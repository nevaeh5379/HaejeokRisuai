/**
 * Serialized-JSON adaptation of ComfyUI_frontend's graphToPrompt algorithm.
 * Upstream: https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/utils/executionUtil.ts
 * Copyright ComfyUI frontend contributors; GPL-3.0 (see repository LICENSE).
 * Modified for RisuAI: resolve widgets using /object_info without loading LiteGraph.
 * Extension JS serializers and subgraphs require Export (API) in ComfyUI.
 */
export type ApiWorkflow = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: { title?: string };
  }
>;

type InputSpec = [
  string | unknown[],
  {
    forceInput?: boolean;
    default?: unknown;
    control_after_generate?: boolean | string;
  }?,
];
export type ObjectInfo = Record<
  string,
  {
    input: {
      required?: Record<string, InputSpec>;
      optional?: Record<string, InputSpec>;
    };
    input_order?: { required?: string[]; optional?: string[] };
  }
>;
interface WorkflowNode {
  id: string | number;
  type: string;
  title?: string;
  mode?: number;
  inputs?: {
    name: string;
    type?: string;
    link?: string | number | null;
    widget?: { name: string };
  }[];
  outputs?: { type?: string }[];
  widgets_values?: unknown[] | Record<string, unknown>;
  widgets_values_named?: Record<string, unknown>;
}
type Link = [
  string | number,
  string | number,
  number,
  string | number,
  number,
  string,
];

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Accept API exports and the prompt envelope returned by ComfyUI. */
export function readApiWorkflow(value: unknown): ApiWorkflow | undefined {
  if (!record(value)) throw new Error("Workflow JSON must be an object.");
  if (Array.isArray(value.nodes)) return undefined;
  const prompt = record(value.prompt) ? value.prompt : value;
  if (
    !Object.keys(prompt).length ||
    !Object.values(prompt).every(
      (node) =>
        record(node) &&
        typeof node.class_type === "string" &&
        record(node.inputs),
    )
  ) {
    throw new Error(
      "Invalid workflow JSON. Import a workflow or Export (API) JSON from ComfyUI.",
    );
  }
  return prompt as ApiWorkflow;
}

export function convertComfyWorkflow(
  value: unknown,
  info: ObjectInfo,
): ApiWorkflow {
  const api = readApiWorkflow(value);
  if (api) return api;
  const graph = value as {
    nodes: WorkflowNode[];
    links: Link[];
    definitions?: unknown;
  };
  if (!Array.isArray(graph.links))
    throw new Error("Workflow links are missing.");
  const nodes = new Map(graph.nodes.map((node) => [String(node.id), node]));
  const links = new Map(graph.links.map((link) => [String(link[0]), link]));
  const output: ApiWorkflow = Object.create(null);
  const unsupported = (node: WorkflowNode): never => {
    throw new Error(
      `Cannot convert node ${node.id} (${node.type}). Use ComfyUI Export (API) for subgraphs or custom frontend widgets.`,
    );
  };
  const wrap = (v: unknown) => (Array.isArray(v) ? { __value__: v } : v);

  function resolve(linkId: string | number, seen = new Set<string>()): unknown {
    if (seen.has(String(linkId)))
      throw new Error("Workflow contains a cyclic virtual connection.");
    seen.add(String(linkId));
    const link = links.get(String(linkId));
    if (!link) throw new Error(`Workflow link ${linkId} is missing.`);
    const node = nodes.get(String(link[1]));
    if (!node) throw new Error(`Workflow node ${link[1]} is missing.`);
    if (node.mode === 2) return undefined;
    if (node.type === "PrimitiveNode") {
      const values = node.widgets_values;
      if (!Array.isArray(values) || !values.length) return unsupported(node);
      return wrap(values[0]);
    }
    if (node.type === "Reroute" || node.mode === 4) {
      const type = node.outputs?.[link[2]]?.type;
      const candidates =
        node.inputs?.filter(
          (input) =>
            input.link != null &&
            (node.type === "Reroute" ||
              input.type === type ||
              input.type === "*" ||
              type === "*"),
        ) ?? [];
      const input = candidates[link[2]] ?? candidates[0];
      return input?.link != null ? resolve(input.link, seen) : undefined;
    }
    return [String(node.id), link[2]];
  }

  for (const node of graph.nodes) {
    if (
      node.mode === 2 ||
      node.mode === 4 ||
      ["Reroute", "PrimitiveNode", "Note", "MarkdownNote"].includes(node.type)
    )
      continue;
    const def = info[node.type];
    if (!def) unsupported(node);
    const inputs: Record<string, unknown> = Object.create(null);
    const values = node.widgets_values;
    const named =
      node.widgets_values_named ?? (record(values) ? values : undefined);
    let index = 0;
    for (const group of ["required", "optional"] as const) {
      const specs = def.input[group] ?? {};
      for (const name of def.input_order?.[group] ?? Object.keys(specs)) {
        const spec = specs[name];
        if (!spec) continue;
        const [type, options] = spec;
        const slot = node.inputs?.find((input) => input.name === name);
        const isWidget =
          !options?.forceInput &&
          (Array.isArray(type) ||
            ["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"].includes(
              String(type),
            ));
        // A converted widget still occupies its serialized widget position.
        if (!isWidget) {
          if (slot?.widget) unsupported(node);
          continue;
        }
        const widgetName = slot?.widget?.name ?? name;
        const widgetValue =
          named && Object.hasOwn(named, widgetName)
            ? named[widgetName]
            : Array.isArray(values)
              ? values[index]
              : undefined;
        index++;
        if (
          type === "INT" &&
          (options?.control_after_generate ??
            ["seed", "noise_seed"].includes(name))
        )
          index++;
        if (widgetValue !== undefined) inputs[name] = wrap(widgetValue);
        else if (slot?.link == null && group === "required") unsupported(node);
      }
    }
    // Reject extra widgets rather than silently assigning custom widget values to wrong fields.
    if (!named && Array.isArray(values) && index !== values.length)
      unsupported(node);
    for (const input of node.inputs ?? []) {
      if (input.link == null) continue;
      const resolved = resolve(input.link);
      if (resolved !== undefined) inputs[input.name] = resolved;
      else delete inputs[input.name];
    }
    output[String(node.id)] = {
      inputs,
      class_type: node.type,
      _meta: { title: node.title ?? node.type },
    };
  }
  for (const node of Object.values(output)) {
    for (const [name, input] of Object.entries(node.inputs)) {
      if (Array.isArray(input) && !Object.hasOwn(output, String(input[0])))
        delete node.inputs[name];
    }
  }
  if (!Object.keys(output).length)
    throw new Error("Workflow has no executable nodes.");
  return output;
}
