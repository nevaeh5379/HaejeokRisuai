import type {
  SerializedGraph,
  SerializedLink,
  Slot,
  NodeId,
  SlotType,
} from "../../../../../graph";
export type ISerialisableNodeInput = Slot;
export type ExportedSubgraph = Omit<
  SerializedGraph,
  "links" | "definitions"
> & {
  links: SerializedLink[];
  definitions?: { subgraphs?: ExportedSubgraph[] };
};
export type ISerialisedGraph = Omit<
  SerializedGraph,
  "links" | "definitions"
> & {
  links: [NodeId, NodeId, number, NodeId, number, SlotType][];
  definitions?: { subgraphs?: ExportedSubgraph[] };
};
