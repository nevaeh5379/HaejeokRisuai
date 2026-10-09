import type { NodeId } from "./types";
import type { WorkflowGraph } from "./graph";
/** Persisted slot topology in place of ComfyUI's Pinia link store. */
export function inputLinkId(
  graph: WorkflowGraph,
  nodeId: NodeId,
  slot: number,
) {
  const value = graph.getNodeById(nodeId)?.inputs[slot]?.link;
  return value == null ? undefined : value;
}
