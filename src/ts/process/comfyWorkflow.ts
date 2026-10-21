export type { ObjectInfo } from "../../../packages/comfyui-workflow";
import type { ObjectInfo } from "../../../packages/comfyui-workflow";

export type ApiWorkflow = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title?: string };
  }
>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasNonTitleKey(meta: Record<string, unknown>): boolean {
  for (const key in meta) {
    if (Object.hasOwn(meta, key) && key !== "title") return true;
  }
  return false;
}

function keepNodeTitle(api: ApiWorkflow): ApiWorkflow {
  let result = api;
  for (const id in api) {
    if (!Object.hasOwn(api, id)) continue;
    const node = api[id];
    if (!record(node._meta) || !hasNonTitleKey(node._meta)) continue;
    const meta = Object.hasOwn(node._meta, "title")
      ? { title: node._meta.title }
      : {};
    if (result === api) result = { ...api };
    result[id] = { ...node, _meta: meta };
  }
  return result;
}

/** Accept API exports and the prompt envelope returned by ComfyUI. */
export function readApiWorkflow(value: unknown): ApiWorkflow | undefined {
  if (!record(value)) throw new Error("Workflow JSON must be an object.");
  if (Array.isArray(value.nodes)) return undefined;
  const prompt = record(value.prompt) ? value.prompt : value;
  let hasNodes = false;
  for (const id in prompt) {
    if (!Object.hasOwn(prompt, id)) continue;
    hasNodes = true;
    const node = prompt[id];
    if (
      !record(node) ||
      typeof node.class_type !== "string" ||
      !record(node.inputs)
    ) {
      throw new Error(
        "Invalid workflow JSON. Import a workflow or Export (API) JSON from ComfyUI.",
      );
    }
  }
  if (!hasNodes) {
    throw new Error(
      "Invalid workflow JSON. Import a workflow or Export (API) JSON from ComfyUI.",
    );
  }
  return keepNodeTitle(prompt as ApiWorkflow);
}

export async function convertComfyWorkflow(
  value: unknown,
  info: ObjectInfo,
): Promise<ApiWorkflow> {
  const api = readApiWorkflow(value);
  if (api) return api;
  const { workflowToPrompt } =
    await import("../../../packages/comfyui-workflow");
  return keepNodeTitle(await workflowToPrompt(value, info));
}
