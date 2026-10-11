// Adapted from Comfy-Org/ComfyUI_frontend, revision 6b0f2bd013fa16c33932085ba519cf8967b03fa7.
// Upstream source: src/utils/litegraphUtil.ts (slot-compression excerpts)
import type { SerializedWorkflow, Slot, ExportedSubgraph } from "./types";
export function compressWidgetInputSlots(graph: SerializedWorkflow) {
  for (const node of graph.nodes) {
    node.inputs = node.inputs?.filter(matchesLegacyApi);

    for (const [inputIndex, input] of node.inputs?.entries() ?? []) {
      if (input.link) {
        const link = graph.links.find((link) => link[0] === input.link);
        if (link) {
          link[4] = inputIndex;
        }
      }
    }
  }

  compressSubgraphWidgetInputSlots(graph.definitions?.subgraphs);
}

function matchesLegacyApi(input: Slot) {
  return !(input.widget && input.link === null && !input.label);
}

/**
 * Duplication to handle the legacy link arrays in the root workflow.
 * @see compressWidgetInputSlots
 * @param subgraph The subgraph to compress widget input slots for.
 */
function compressSubgraphWidgetInputSlots(
  subgraphs: ExportedSubgraph[] | undefined,
  visited = new WeakSet<ExportedSubgraph>(),
) {
  if (!subgraphs) return;

  for (const subgraph of subgraphs) {
    if (visited.has(subgraph)) throw new Error("Infinite loop detected");
    visited.add(subgraph);

    if (subgraph.nodes) {
      for (const node of subgraph.nodes) {
        node.inputs = node.inputs?.filter(matchesLegacyApi);

        if (!subgraph.links) continue;

        for (const [inputIndex, input] of node.inputs?.entries() ?? []) {
          if (input.link) {
            const link = subgraph.links.find((link) => link.id === input.link);
            if (link) link.target_slot = inputIndex;
          }
        }
      }
    }

    compressSubgraphWidgetInputSlots(subgraph.definitions?.subgraphs, visited);
  }
}
