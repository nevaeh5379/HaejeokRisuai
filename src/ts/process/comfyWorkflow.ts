export type { ObjectInfo } from "../../../packages/comfyui-workflow/graph";
import type { ObjectInfo } from "../../../packages/comfyui-workflow/graph";

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

function keepNodeTitle(api: ApiWorkflow): ApiWorkflow {
  let result = api;
  for (const [id, node] of Object.entries(api)) {
    if (
      !record(node._meta) ||
      !Object.keys(node._meta).some((key) => key !== "title")
    )
      continue;
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
