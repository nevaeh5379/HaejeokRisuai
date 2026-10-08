/**
 * Headless loader for the upstream graphToPrompt/ExecutableNodeDTO runtime.
 * This file restores persisted graph state; prompt serialization and connection
 * resolution are performed by the vendored, unmodified upstream functions.
 */
import {
  ExecutableNodeDTO,
  type ExecutableLGraphNode,
  type ExecutionId,
} from "./upstream/src/lib/litegraph/src/subgraph/ExecutableNodeDTO";
import { LGraphEventMode } from "./upstream/src/lib/litegraph/src/types/globalEnums";
import type { ISerialisedGraph } from "./compat/lib/litegraph/src/types/serialisation";

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

// Only promoted subgraph widgets need the upstream store read. Entries are
// scoped to a conversion and released in finally, including conversion errors.
const widgetValues = new Map<string, Widget>();
export const useWidgetValueStore = () => ({
  getWidget: (id: string) => widgetValues.get(id),
});

export class WorkflowLink implements SerializedLink {
  id: NodeId;
  origin_id: NodeId;
  origin_slot: number;
  target_id: NodeId;
  target_slot: number;
  type: SlotType;
  readonly originIsIoNode: boolean;
  constructor(
    value: SerializedLink | [NodeId, NodeId, number, NodeId, number, SlotType],
    graph: WorkflowGraph,
  ) {
    const data = Array.isArray(value)
      ? {
          id: value[0],
          origin_id: value[1],
          origin_slot: value[2],
          target_id: value[3],
          target_slot: value[4],
          type: value[5],
        }
      : value;
    Object.assign(this, data);
    this.originIsIoNode =
      String(this.origin_id) === String(graph.source.inputNode?.id ?? -10);
  }
  resolve(graph: WorkflowGraph) {
    return {
      link: this,
      inputNode: graph.getNodeById(this.target_id),
      outputNode: graph.getNodeById(this.origin_id),
    };
  }
}

export class WorkflowNode {
  readonly id: NodeId;
  readonly type: string;
  readonly title: string;
  readonly mode: LGraphEventMode;
  readonly comfyClass: string;
  readonly properties: Record<string, unknown>;
  readonly inputs: Slot[];
  readonly outputs: Slot[];
  readonly widgets: Widget[] = [];
  readonly isVirtualNode: boolean;
  subgraph?: WorkflowGraph;
  applyToGraph?: () => void;
  resolveVirtualOutput?: (
    slot: number,
  ) => { node: WorkflowNode; slot: number } | undefined;

  constructor(
    readonly source: SerializedNode,
    readonly graph: WorkflowGraph,
    info: ObjectInfo,
    ancestors: Set<string>,
  ) {
    this.id = source.id;
    this.type = source.type;
    this.title = source.title ?? source.type;
    this.mode = source.mode ?? LGraphEventMode.ALWAYS;
    this.comfyClass = source.type;
    this.properties = source.properties ?? {};
    this.inputs = (source.inputs ?? []).map((slot) => ({
      ...slot,
      type: slot.type ?? "*",
    }));
    this.outputs = (source.outputs ?? []).map((slot) => ({
      ...slot,
      type: slot.type ?? "*",
    }));
    this.isVirtualNode = [
      "PrimitiveNode",
      "Reroute",
      "Note",
      "MarkdownNote",
    ].includes(source.type);

    const definition = graph.definitions.get(source.type);
    if (definition) {
      this.isVirtualNode = true;
      if (ancestors.has(source.type))
        throw new Error(`Recursive subgraph: ${source.type}`);
      this.subgraph = new WorkflowGraph(
        definition,
        info,
        graph.rootGraph,
        new Set([...ancestors, source.type]),
      );
      this.restoreSubgraphWidgets();
      return;
    }
    if (source.type === "PrimitiveNode") {
      const values = source.widgets_values;
      if (!Array.isArray(values) || !values.length)
        throw new Error(`Primitive node ${this.id} has no saved value.`);
      this.applyToGraph = () => this.propagatePrimitive(values[0]);
      return;
    }
    if (
      this.isVirtualNode ||
      this.mode === LGraphEventMode.NEVER ||
      this.mode === LGraphEventMode.BYPASS
    )
      return;
    const def = info[this.type];
    if (!def?.input)
      throw new Error(
        `Node ${this.id} (${this.type}) is missing from ComfyUI /object_info.`,
      );
    const values = source.widgets_values;
    const named =
      source.widgets_values_named ??
      (!Array.isArray(values) && values ? values : undefined);
    let index = 0;
    for (const group of ["required", "optional"] as const) {
      const specs = def.input[group] ?? {};
      for (const name of def.input_order?.[group] ?? Object.keys(specs)) {
        const spec = specs[name];
        if (!spec) continue;
        const [type, options] = spec;
        if (options?.forceInput) continue;
        const slot = this.inputs.find(
          (input) => input.name === name || input.widget?.name === name,
        );
        const hasNamedValue = !!named && Object.hasOwn(named, name);
        const hasPositionalValue =
          Array.isArray(values) && index < values.length;
        // Saved widget metadata distinguishes value inputs from link-only sockets.
        // Older workflows omit widget sockets, so retain their saved values too.
        if (
          !hasNamedValue &&
          !slot?.widget &&
          (slot ||
            (!hasPositionalValue && !Object.hasOwn(options ?? {}, "default")))
        )
          continue;
        const value =
          named && Object.hasOwn(named, name)
            ? named[name]
            : Array.isArray(values)
              ? values[index]
              : options?.default;
        index++;
        this.widgets.push({
          name,
          type: Array.isArray(type) ? "combo" : type.toLowerCase(),
          value,
          options: {},
        });
        if (
          type === "INT" &&
          (options?.control_after_generate ??
            ["seed", "noise_seed"].includes(name))
        )
          index++;
      }
    }
    // Extra workflow-only widgets (e.g. image previews on VAEDecode) are not
    // backend inputs and must not make a valid backend node unconvertible.
  }

  isSubgraphNode(): boolean {
    return !!this.subgraph;
  }

  getInnerNodes(
    map: Map<ExecutionId, ExecutableLGraphNode>,
    path: readonly NodeId[] = [],
  ): ExecutableLGraphNode[] {
    if (!this.subgraph)
      return [new ExecutableNodeDTO(this, path, map, this.graph.owner)];
    const dto = new ExecutableNodeDTO(this, path, map, this.graph.owner);
    map.set(dto.id, dto);
    const inner: ExecutableLGraphNode[] = [];
    for (const node of this.subgraph.computeExecutionOrder(false)) {
      const children = node.getInnerNodes(map, [...path, this.id]);
      for (const child of children) map.set(child.id, child);
      inner.push(...children);
    }
    return inner;
  }

  getInputLink(slot: number) {
    const id = this.inputs[slot]?.link;
    return id == null ? undefined : this.graph.getLink(id);
  }

  resolveSubgraphOutputLink(slot: number) {
    const graph = this.subgraph;
    if (!graph) return;
    const outputId = graph.source.outputNode?.id ?? -20;
    const link = [...graph.links.values()].find(
      (item) =>
        String(item.target_id) === String(outputId) &&
        item.target_slot === slot,
    );
    return link?.resolve(graph);
  }

  private propagatePrimitive(
    value: unknown,
    visited = new Set<WorkflowNode>(),
  ) {
    if (visited.has(this))
      throw new Error("Workflow contains a cyclic virtual connection.");
    visited.add(this);
    for (const link of this.graph.links.values()) {
      if (String(link.origin_id) !== String(this.id)) continue;
      const target = this.graph.getNodeById(link.target_id);
      if (!target) continue;
      if (target.type === "Reroute") {
        target.propagatePrimitive(value, new Set(visited));
        continue;
      }
      const slot = target.inputs[link.target_slot];
      const widget = target.widgets.find(
        (item) => item.name === (slot?.widget?.name ?? slot?.name),
      );
      if (widget) widget.value = value;
    }
  }

  private restoreSubgraphWidgets() {
    const graph = this.subgraph!;
    graph.owner = this;
    const proxy = this.properties.proxyWidgets;
    const values = this.source.widgets_values;
    if (!Array.isArray(proxy) || !Array.isArray(values)) return;
    for (const [index, target] of proxy.entries()) {
      if (!Array.isArray(target) || target.length < 2) continue;
      const [nodeId, name] = target as [NodeId, string];
      const value = values[index];
      if (String(nodeId) === "-1") {
        const slot = this.inputs.find((item) => item.name === name) ?? {
          name,
          type: "*",
          link: null,
        };
        if (!this.inputs.includes(slot)) this.inputs.push(slot);
        const widget = {
          name,
          type: "unknown",
          value,
          options: { serialize: false },
        };
        const id = `${graph.rootGraph.id}:${graph.instanceId}:${name}`;
        slot.widgetId = id;
        widgetValues.set(id, widget);
        graph.rootGraph.widgetIds.add(id);
      } else {
        const widget = graph
          .getNodeById(nodeId)
          ?.widgets.find((item) => item.name === name);
        if (widget) widget.value = value;
      }
    }
  }
}

let nextInstanceId = 0;
export class WorkflowGraph {
  readonly id: string;
  readonly instanceId = ++nextInstanceId;
  readonly rootGraph: WorkflowGraph;
  readonly definitions: Map<string, SerializedGraph>;
  readonly nodes: WorkflowNode[];
  readonly links = new Map<string, WorkflowLink>();
  readonly widgetIds = new Set<string>();
  owner?: WorkflowNode;

  constructor(
    readonly source: SerializedGraph,
    info: ObjectInfo,
    root?: WorkflowGraph,
    ancestors = new Set<string>(),
  ) {
    if (!Array.isArray(source.nodes) || !Array.isArray(source.links))
      throw new Error("Workflow nodes or links are missing.");
    this.id = source.id ?? `workflow-${this.instanceId}`;
    this.rootGraph = root ?? this;
    this.definitions = new Map(root?.definitions);
    for (const def of source.definitions?.subgraphs ?? []) {
      if (def.id) this.definitions.set(def.id, def);
    }
    for (const data of source.links) {
      const link = new WorkflowLink(data, this);
      this.links.set(String(link.id), link);
    }
    try {
      this.nodes = source.nodes.map(
        (node) => new WorkflowNode(node, this, info, ancestors),
      );
    } catch (cause) {
      if (!root) this.dispose();
      throw cause;
    }
  }

  getLink(id: NodeId) {
    return this.links.get(String(id));
  }
  getNodeById(id: NodeId) {
    return this.nodes.find((node) => String(node.id) === String(id));
  }
  computeExecutionOrder(_onlyOnExecute: boolean) {
    return [...this.nodes].sort(
      (a, b) => (a.source.order ?? 0) - (b.source.order ?? 0),
    );
  }
  serialize(_options?: { sortNodes?: boolean }): ISerialisedGraph {
    const snapshot = structuredClone(this.source) as ISerialisedGraph;
    // The root workflow format uses link tuples, unlike subgraph definitions.
    snapshot.links = [...this.links.values()].map((link) => [
      link.id,
      link.origin_id,
      link.origin_slot,
      link.target_id,
      link.target_slot,
      link.type,
    ]);
    return snapshot;
  }
  dispose() {
    for (const id of this.widgetIds) widgetValues.delete(id);
    this.widgetIds.clear();
  }
}
