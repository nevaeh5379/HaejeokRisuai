import type { ISerialisedGraph, ISerialisableNodeInput, ExportedSubgraph } from '@/lib/litegraph/src/types/serialisation'
export function compressWidgetInputSlots(graph: ISerialisedGraph) {
  for (const node of graph.nodes) {
    node.inputs = node.inputs?.filter(matchesLegacyApi)

    for (const [inputIndex, input] of node.inputs?.entries() ?? []) {
      if (input.link) {
        const link = graph.links.find((link) => link[0] === input.link)
        if (link) {
          link[4] = inputIndex
        }
      }
    }
  }

  compressSubgraphWidgetInputSlots(graph.definitions?.subgraphs)
}

function matchesLegacyApi(input: ISerialisableNodeInput) {
  return !(input.widget && input.link === null && !input.label)
}

/**
 * Duplication to handle the legacy link arrays in the root workflow.
 * @see compressWidgetInputSlots
 * @param subgraph The subgraph to compress widget input slots for.
 */
function compressSubgraphWidgetInputSlots(
  subgraphs: ExportedSubgraph[] | undefined,
  visited = new WeakSet<ExportedSubgraph>()
) {
  if (!subgraphs) return

  for (const subgraph of subgraphs) {
    if (visited.has(subgraph)) throw new Error('Infinite loop detected')
    visited.add(subgraph)

    if (subgraph.nodes) {
      for (const node of subgraph.nodes) {
        node.inputs = node.inputs?.filter(matchesLegacyApi)

        if (!subgraph.links) continue

        for (const [inputIndex, input] of node.inputs?.entries() ?? []) {
          if (input.link) {
            const link = subgraph.links.find((link) => link.id === input.link)
            if (link) link.target_slot = inputIndex
          }
        }
      }
    }

    compressSubgraphWidgetInputSlots(subgraph.definitions?.subgraphs, visited)
  }
}

