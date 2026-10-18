export type NodeId = string | number;
export type SlotType = string | number;
export type InputSpec = [
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
export interface Slot {
  name: string;
  type?: SlotType;
  link?: NodeId | null;
  widget?: { name: string };
  widgetId?: string;
  label?: string;
  localized_name?: string;
}
export interface SerializedNode {
  id: NodeId;
  type: string;
  title?: string;
  mode?: number;
  order?: number;
  properties?: Record<string, unknown>;
  inputs?: Slot[];
  outputs?: Slot[];
  widgets_values?: unknown[] | Record<string, unknown>;
  widgets_values_named?: Record<string, unknown>;
}
export interface SerializedGraph {
  id?: string;
  name?: string;
  nodes: SerializedNode[];
  links: (
    SerializedLink | [NodeId, NodeId, number, NodeId, number, SlotType]
  )[];
  inputs?: Slot[];
  outputs?: Slot[];
  inputNode?: { id: NodeId };
  outputNode?: { id: NodeId };
  definitions?: { subgraphs?: SerializedGraph[] };
  extra?: Record<string, unknown>;
}
export interface SerializedLink {
  id: NodeId;
  origin_id: NodeId;
  origin_slot: number;
  target_id: NodeId;
  target_slot: number;
  type: SlotType;
}
export interface Widget {
  name: string;
  type: string;
  value: unknown;
  options: { serialize?: boolean };
  serializeValue?: (node: unknown, index: number) => unknown | Promise<unknown>;
}

export type ExportedSubgraph = Omit<
  SerializedGraph,
  "links" | "definitions"
> & {
  links: SerializedLink[];
  definitions?: { subgraphs?: ExportedSubgraph[] };
};
export type SerializedWorkflow = Omit<
  SerializedGraph,
  "links" | "definitions"
> & {
  links: [NodeId, NodeId, number, NodeId, number, SlotType][];
  definitions?: { subgraphs?: ExportedSubgraph[] };
};

export type ComfyApiWorkflow = Record<
  string,
  {
    class_type: string;
    inputs: Record<string, unknown>;
    _meta?: Record<string, string>;
  }
>;
