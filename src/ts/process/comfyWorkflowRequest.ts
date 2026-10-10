import type { GlobalFetchArgs, globalFetch } from "../globalApi.svelte";
import type { ObjectInfo } from "./comfyWorkflow";

export const COMFY_WORKFLOW_REQUEST_TIMEOUT_MS = 30_000;

export const COMFY_WORKFLOW_LIST_PATH =
  "/userdata?dir=workflows&recurse=true&split=false&full_info=true";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function responseShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (isRecord(value))
    return `object keys: ${Object.keys(value).slice(0, 8).join(", ") || "(empty)"}`;
  return typeof value;
}

/** Load only the node types used by this workflow, with bounded concurrency. */
export async function fetchComfyWorkflowObjectInfo(
  workflow: unknown,
  getJson: (path: string) => Promise<unknown>,
  createUrl: (path: string) => string,
  onProgress?: (completed: number, total: number) => void,
): Promise<ObjectInfo> {
  const required = new Map<string, string>();
  const definitions = new Map<string, Record<string, unknown>>();
  const seen = new Set<unknown>();
  function indexDefinitions(graph: unknown) {
    if (!isRecord(graph) || seen.has(graph)) return;
    seen.add(graph);
    const defs = isRecord(graph.definitions)
      ? graph.definitions.subgraphs
      : undefined;
    if (!Array.isArray(defs)) return;
    for (const def of defs) {
      if (isRecord(def) && typeof def.id === "string")
        definitions.set(def.id, def);
      indexDefinitions(def);
    }
  }
  indexDefinitions(workflow);
  seen.clear();
  function collect(graph: unknown) {
    if (!isRecord(graph) || seen.has(graph) || !Array.isArray(graph.nodes))
      return;
    seen.add(graph);
    for (const node of graph.nodes) {
      if (
        !isRecord(node) ||
        typeof node.type !== "string" ||
        node.mode === 2 ||
        node.mode === 4
      )
        continue;
      if (
        ["PrimitiveNode", "Reroute", "Note", "MarkdownNote"].includes(node.type)
      )
        continue;
      const subgraph = definitions.get(node.type);
      if (subgraph) collect(subgraph);
      else required.set(node.type, String(node.id));
    }
  }
  collect(workflow);
  const info: ObjectInfo = Object.create(null);
  function definition(value: unknown): value is ObjectInfo[string] {
    return isRecord(value) && isRecord(value.input);
  }
  const pending = required.entries();
  let completed = 0;
  let failed = false;
  onProgress?.(0, required.size);
  async function worker() {
    while (!failed) {
      const next = pending.next();
      if (next.done) return;
      const [type, id] = next.value;
      const path = `/object_info/${encodeURIComponent(type)}`;
      try {
        const single = await getJson(path);
        const entry = isRecord(single) ? single[type] : undefined;
        if (!definition(entry)) {
          throw new Error(
            `Node ${id} (${type}) has no valid definition in ComfyUI.\n${createUrl(path)}\nReceived ${responseShape(single)}`,
          );
        }
        if (failed) return;
        info[type] = entry;
        onProgress?.(++completed, required.size);
      } catch (cause) {
        failed = true;
        throw new Error(
          `Could not load node ${id} (${type}) from ComfyUI.\n${createUrl(path)}\n${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, required.size) }, worker));
  return info;
}

/** Decode the three list formats provided by ComfyUI's userdata API. */
export function parseComfyWorkflowList(value: unknown, url: string): string[] {
  const invalid = (entry?: unknown, index?: number): never => {
    const received = Array.isArray(value)
      ? `array; entry ${index ?? 0}: ${responseShape(index === undefined ? value[0] : entry)}`
      : responseShape(value);
    throw new Error(
      `Invalid ComfyUI workflow list. Received ${received}.\n${url}`,
    );
  };
  if (!Array.isArray(value)) return invalid();
  const files: string[] = [];
  for (const [index, entry] of value.entries()) {
    let path: string;
    if (typeof entry === "string") {
      path = entry;
    } else if (
      Array.isArray(entry) &&
      entry.length > 0 &&
      entry.every((part) => typeof part === "string")
    ) {
      // ComfyUI split mode returns [relativePath, ...relativePath.split('/')].
      const parts = entry.slice(1).join("/");
      path = entry[0] === parts ? entry[0] : entry.join("/");
    } else if (
      entry &&
      typeof entry === "object" &&
      typeof entry.path === "string"
    ) {
      path = entry.path;
    } else {
      return invalid(entry, index);
    }
    path = path.replace(/\\/g, "/");
    if (/\.json$/i.test(path)) files.push(path);
  }
  return [...new Set(files)].sort();
}

/** Bound the complete operation, even when a native transport ignores abort. */
export async function withComfyWorkflowTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMessage: string,
  timeoutMs = COMFY_WORKFLOW_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Use the finite JSON transport, not the native SSE/event stream transport. */
export async function fetchComfyWorkflowJson(
  url: string,
  fetchJson: (
    url: string,
    options: GlobalFetchArgs,
  ) => ReturnType<typeof globalFetch>,
  timeoutMessage: string,
): Promise<unknown> {
  return withComfyWorkflowTimeout(async (signal) => {
    const response = await fetchJson(url, {
      method: "GET",
      abortSignal: signal,
      requestTimeoutMs: COMFY_WORKFLOW_REQUEST_TIMEOUT_MS,
    });
    if (signal.aborted) throw new Error(timeoutMessage);
    if (!response.ok) {
      const detail =
        typeof response.data === "string" ? response.data.slice(0, 1000) : "";
      throw new Error(
        `ComfyUI HTTP ${response.status}: ${url}${detail ? `\n${detail}` : ""}`,
      );
    }
    // globalFetch keeps non-JSON responses as strings; surface parse errors here.
    if (typeof response.data === "string") {
      try {
        return JSON.parse(response.data);
      } catch {
        throw new Error(`ComfyUI returned invalid JSON: ${url}`);
      }
    }
    return response.data;
  }, `${timeoutMessage}\n${url}`);
}
