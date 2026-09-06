import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import type {
  Chat,
  ChatBranchReason,
  Message,
} from "../storage/database/schema";
import type { SqlChatBranchGraphData } from "../storage/sql/ISqlStorage";

export interface ChatGraphTerminal {
  branchId: string;
  reason: "root" | ChatBranchReason;
  active: boolean;
}

export interface RenderedChatNode {
  id: string;
  x: number;
  y: number;
  kind: "message" | "summary";
  role?: Message["role"];
  preview: string;
  endPreview: string;
  model: string;
  isComment: boolean;
  activePath: boolean;
  activeTerminal: boolean;
  branchPoint: boolean;
  continuationCount: number;
  messageIndex: number;
  endMessageIndex: number;
  collapsedCount: number;
  time?: number;
  terminals: ChatGraphTerminal[];
}

export interface ChatBranchEdge {
  from: string;
  to: string;
  active: boolean;
}

export interface ChatBranchGraph {
  nodes: RenderedChatNode[];
  edges: ChatBranchEdge[];
  columns: number;
  rows: number;
  timelineCount: number;
  messageCount: number;
  collapsedMessageCount: number;
}

export interface ChatGraphTimeline {
  branchId: string;
  reason: "root" | ChatBranchReason;
  active: boolean;
  messages: Message[];
}

export type ChatGraphDensity = "smart" | "all" | "branches";

export interface ChatGraphBuildOptions {
  density?: ChatGraphDensity;
}

export interface ChatGraphLaneLayout {
  laneByNodeId: Map<string, number>;
  columns: number;
}

interface PackedChain {
  nodeIds: string[];
  start: number;
  end: number;
  forkChildren: string[];
}

/**
 * Lane assignment with reuse: the active path keeps lane 0 while every other
 * branch chain claims the first lane whose occupied flow interval does not
 * overlap it, so branches scattered across the chat share lanes instead of
 * each stretching the canvas with a mostly-empty lane.
 */
export function buildChatGraphPackedLanes(
  graph: ChatBranchGraph,
  flowOf: (node: RenderedChatNode) => number,
): ChatGraphLaneLayout {
  const laneByNodeId = new Map<string, number>();
  if (graph.nodes.length === 0) return { laneByNodeId, columns: 1 };

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = new Map<string, Array<{ id: string; active: boolean }>>();
  const incoming = new Set<string>();
  for (const edge of graph.edges) {
    const siblings = children.get(edge.from) ?? [];
    siblings.push({ id: edge.to, active: edge.active });
    children.set(edge.from, siblings);
    incoming.add(edge.to);
  }

  const chains: PackedChain[] = [];
  const chainIdByNodeId = new Map<string, number>();
  const pending: string[] = [];
  const buildChain = (startId: string) => {
    if (chainIdByNodeId.has(startId)) return;
    const chain: PackedChain = {
      nodeIds: [],
      start: Number.POSITIVE_INFINITY,
      end: Number.NEGATIVE_INFINITY,
      forkChildren: [],
    };
    let currentId: string | undefined = startId;
    while (currentId !== undefined && !chainIdByNodeId.has(currentId)) {
      chainIdByNodeId.set(currentId, chains.length);
      chain.nodeIds.push(currentId);
      const flow = flowOf(nodeById.get(currentId)!);
      chain.start = Math.min(chain.start, flow);
      chain.end = Math.max(chain.end, flow);
      const childEdges = children.get(currentId) ?? [];
      const primary =
        childEdges.find((child) => child.active) ?? childEdges[0];
      for (const child of childEdges) {
        if (child.id === primary?.id) continue;
        if (!chainIdByNodeId.has(child.id)) chain.forkChildren.push(child.id);
      }
      currentId =
        primary !== undefined && !chainIdByNodeId.has(primary.id)
          ? primary.id
          : undefined;
    }
    chains.push(chain);
    pending.push(...chain.forkChildren);
  };

  for (const node of graph.nodes) {
    if (!incoming.has(node.id)) buildChain(node.id);
    while (pending.length > 0) buildChain(pending.shift()!);
  }
  for (const node of graph.nodes) {
    if (!chainIdByNodeId.has(node.id)) buildChain(node.id);
  }

  const activeTerminal = graph.nodes.find((node) => node.activeTerminal);
  const activeChainId = activeTerminal
    ? chainIdByNodeId.get(activeTerminal.id)
    : undefined;
  const ordered = chains
    .map((chain, index) => ({ chain, index }))
    .sort((a, b) => a.chain.start - b.chain.start || a.index - b.index);
  if (activeChainId !== undefined) {
    const activePosition = ordered.findIndex(
      (entry) => entry.index === activeChainId,
    );
    if (activePosition > 0) {
      const [activeEntry] = ordered.splice(activePosition, 1);
      ordered.unshift(activeEntry);
    }
  }

  const laneIntervals: Array<Array<{ start: number; end: number }>> = [];
  const laneOfChain = new Map<number, number>();
  for (const { chain, index } of ordered) {
    let lane = 0;
    for (; lane < laneIntervals.length; lane++) {
      const intervals = laneIntervals[lane];
      let overlaps = false;
      for (const interval of intervals) {
        if (interval.start > chain.end) break;
        if (interval.end >= chain.start) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) break;
    }
    const intervals = laneIntervals[lane] ?? [];
    const insertAt = intervals.findIndex(
      (interval) => interval.start > chain.start,
    );
    if (insertAt === -1) {
      intervals.push({ start: chain.start, end: chain.end });
    } else {
      intervals.splice(insertAt, 0, {
        start: chain.start,
        end: chain.end,
      });
    }
    laneIntervals[lane] = intervals;
    laneOfChain.set(index, lane);
  }

  for (const [index, chain] of chains.entries()) {
    const lane = laneOfChain.get(index) ?? 0;
    for (const nodeId of chain.nodeIds) laneByNodeId.set(nodeId, lane);
  }

  return { laneByNodeId, columns: Math.max(1, laneIntervals.length) };
}

export interface ChatGraphRowLayout {
  rowByNodeId: Map<string, number>;
  rows: number;
}

interface GitRowCandidate {
  id: string;
  time: number;
  active: number;
  order: number;
}

/**
 * Git log --graph row assignment: every node occupies its own row, ordered by
 * message time when available (falling back to topological depth + insertion
 * order), while parents always precede their children.
 */
export function buildChatGraphGitRows(
  graph: ChatBranchGraph,
): ChatGraphRowLayout {
  const nodes = graph.nodes;
  const rowByNodeId = new Map<string, number>();
  if (nodes.length === 0) return { rowByNodeId, rows: 0 };

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const orderById = new Map(nodes.map((node, index) => [node.id, index]));
  const children = new Map<string, string[]>();
  const indegree = new Map<string, number>(
    nodes.map((node) => [node.id, 0]),
  );
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (!indegree.has(edge.from) || !indegree.has(edge.to)) continue;
    const siblings = children.get(edge.from) ?? [];
    siblings.push(edge.to);
    children.set(edge.from, siblings);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    if (!parentOf.has(edge.to)) parentOf.set(edge.to, edge.from);
  }

  const effectiveTime = new Map<string, number>();
  for (const node of nodes) {
    if (node.time !== undefined) {
      effectiveTime.set(node.id, node.time);
      continue;
    }
    const parentId = parentOf.get(node.id);
    const parentTime =
      parentId === undefined ? undefined : effectiveTime.get(parentId);
    effectiveTime.set(node.id, parentTime === undefined ? 0 : parentTime + 1);
  }

  const candidateLess = (a: GitRowCandidate, b: GitRowCandidate) =>
    a.time !== b.time
      ? a.time < b.time
      : a.active !== b.active
        ? a.active < b.active
        : a.order < b.order;
  const candidates: GitRowCandidate[] = [];
  const pushCandidate = (id: string) => {
    candidates.push({
      id,
      time: effectiveTime.get(id) ?? 0,
      active: nodeById.get(id)?.activePath ? 0 : 1,
      order: orderById.get(id) ?? 0,
    });
    let index = candidates.length - 1;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      if (candidateLess(candidates[parentIndex], candidates[index])) break;
      [candidates[parentIndex], candidates[index]] = [
        candidates[index],
        candidates[parentIndex],
      ];
      index = parentIndex;
    }
  };
  const popCandidate = () => {
    const top = candidates[0];
    const last = candidates.pop()!;
    if (candidates.length > 0) {
      candidates[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (
          left < candidates.length &&
          candidateLess(candidates[left], candidates[smallest])
        )
          smallest = left;
        if (
          right < candidates.length &&
          candidateLess(candidates[right], candidates[smallest])
        )
          smallest = right;
        if (smallest === index) break;
        [candidates[smallest], candidates[index]] = [
          candidates[index],
          candidates[smallest],
        ];
        index = smallest;
      }
    }
    return top;
  };

  for (const node of nodes) {
    if ((indegree.get(node.id) ?? 0) === 0) pushCandidate(node.id);
  }
  let rows = 0;
  while (candidates.length > 0) {
    const { id } = popCandidate();
    rowByNodeId.set(id, rows++);
    for (const childId of children.get(id) ?? []) {
      const remaining = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, remaining);
      if (remaining === 0) pushCandidate(childId);
    }
  }
  for (const node of nodes) {
    if (!rowByNodeId.has(node.id)) rowByNodeId.set(node.id, rows++);
  }

  return { rowByNodeId, rows };
}

interface MutableMessageNode {
  id: string;
  message: Message;
  parentId?: string;
  children: string[];
  terminals: ChatGraphTerminal[];
  messageIndex: number;
  synthetic: boolean;
}

interface DisplayNode {
  node: RenderedChatNode;
  children: string[];
}

const LONG_CHAT_THRESHOLD = 80;
const CONTEXT_RADIUS = 2;
const MIN_COLLAPSED_RUN = 6;

function messagePreview(message: Message): string {
  const plain = message.data?.replace(/\s+/g, " ").trim() ?? "";
  return plain.length > 180 ? `${plain.slice(0, 177)}...` : plain;
}

function messageModel(message: Message): string {
  return message.generationInfo?.model ?? "";
}

function fallbackSignature(message: Message): string {
  return JSON.stringify([
    message.role,
    message.data,
    message.saying ?? "",
    message.time ?? null,
    message.generationInfo?.model ?? "",
    message.isComment ?? false,
  ]);
}

/**
 * Reconstruct a message tree from complete timeline paths. Stable chat IDs
 * merge the shared prefix; legacy ID-less messages fall back to matching only
 * beneath the same parent so unrelated parts of a chat cannot collapse.
 */
export function buildChatMessageGraph(
  timelines: ChatGraphTimeline[],
  options: ChatGraphBuildOptions = {},
): ChatBranchGraph {
  const empty: ChatBranchGraph = {
    nodes: [],
    edges: [],
    columns: 0,
    rows: 0,
    timelineCount: timelines.length,
    messageCount: 0,
    collapsedMessageCount: 0,
  };
  if (timelines.length === 0) return empty;

  const mutableNodes = new Map<string, MutableMessageNode>();
  const stableIds = new Map<string, string>();
  const fallbackIds = new Map<string, string>();
  const rootIds: string[] = [];
  const activeNodeIds = new Set<string>();
  const activeEdgeKeys = new Set<string>();
  let generatedId = 0;

  const addChild = (parentId: string | undefined, childId: string) => {
    if (!parentId) {
      if (!rootIds.includes(childId)) rootIds.push(childId);
      return;
    }
    const parent = mutableNodes.get(parentId);
    if (parent && !parent.children.includes(childId))
      parent.children.push(childId);
  };

  for (const timeline of timelines) {
    let parentId: string | undefined;
    let lastNode: MutableMessageNode | undefined;
    const pathIds: string[] = [];

    for (const [messageIndex, message] of timeline.messages.entries()) {
      let nodeId = message.chatId ? stableIds.get(message.chatId) : undefined;
      if (!nodeId) {
        if (message.chatId) {
          nodeId = `message:${message.chatId}`;
          stableIds.set(message.chatId, nodeId);
        } else {
          const fallbackKey = `${parentId ?? "__root__"}\u0000${fallbackSignature(message)}`;
          nodeId = fallbackIds.get(fallbackKey);
          if (!nodeId) {
            nodeId = `message:fallback:${generatedId++}`;
            fallbackIds.set(fallbackKey, nodeId);
          }
        }
      }

      let node = mutableNodes.get(nodeId);
      if (!node) {
        node = {
          id: nodeId,
          message,
          parentId,
          children: [],
          terminals: [],
          messageIndex,
          synthetic: false,
        };
        mutableNodes.set(nodeId, node);
        addChild(parentId, nodeId);
      } else if (
        node.parentId === undefined &&
        parentId !== undefined &&
        node.id !== parentId
      ) {
        node.parentId = parentId;
        addChild(parentId, nodeId);
      }

      pathIds.push(nodeId);
      lastNode = node;
      parentId = nodeId;
    }

    if (!lastNode) {
      const emptyId = `empty:${timeline.branchId}`;
      lastNode = {
        id: emptyId,
        message: { role: "char", data: "" },
        children: [],
        terminals: [],
        messageIndex: 0,
        synthetic: true,
      };
      mutableNodes.set(emptyId, lastNode);
      rootIds.push(emptyId);
      pathIds.push(emptyId);
    }

    lastNode.terminals.push({
      branchId: timeline.branchId,
      reason: timeline.reason,
      active: timeline.active,
    });

    if (timeline.active) {
      pathIds.forEach((id) => activeNodeIds.add(id));
      for (let index = 1; index < pathIds.length; index++) {
        activeEdgeKeys.add(`${pathIds[index - 1]}\u0000${pathIds[index]}`);
      }
    }
  }

  const messageCount = [...mutableNodes.values()].filter(
    (node) => !node.synthetic,
  ).length;
  const density = options.density ?? "smart";
  const keepIds = new Set<string>();
  if (
    density === "all" ||
    (density === "smart" && messageCount <= LONG_CHAT_THRESHOLD)
  ) {
    for (const nodeId of mutableNodes.keys()) keepIds.add(nodeId);
  } else {
    const anchors = [...mutableNodes.values()]
      .filter(
        (node) =>
          rootIds.includes(node.id) ||
          node.children.length !== 1 ||
          node.terminals.length > 0,
      )
      .map((node) => node.id);
    const nearestAnchor = new Map<string, number>();
    const queue = anchors.map((id) => ({ id, distance: 0 }));
    for (let index = 0; index < queue.length; index++) {
      const { id, distance } = queue[index];
      const previousDistance = nearestAnchor.get(id);
      if (previousDistance !== undefined && previousDistance <= distance)
        continue;
      nearestAnchor.set(id, distance);
      keepIds.add(id);
      const contextRadius = density === "branches" ? 0 : CONTEXT_RADIUS;
      if (distance >= contextRadius) continue;
      const node = mutableNodes.get(id);
      if (!node) continue;
      const neighbors = [node.parentId, ...node.children].filter(
        (neighbor): neighbor is string => Boolean(neighbor),
      );
      for (const neighbor of neighbors) {
        queue.push({ id: neighbor, distance: distance + 1 });
      }
    }
  }

  const toRenderedMessage = (node: MutableMessageNode): RenderedChatNode => {
    const continuationCount = node.children.length + node.terminals.length;
    return {
      id: node.id,
      x: 0,
      y: 0,
      kind: "message",
      role: node.message.role,
      preview: messagePreview(node.message),
      endPreview: "",
      model: messageModel(node.message),
      isComment: node.message.isComment ?? false,
      activePath: activeNodeIds.has(node.id),
      activeTerminal: node.terminals.some((terminal) => terminal.active),
      branchPoint: continuationCount > 1,
      continuationCount,
      messageIndex: node.messageIndex,
      endMessageIndex: node.messageIndex,
      collapsedCount: 0,
      time: node.message.time,
      terminals: node.terminals,
    };
  };

  const displayNodes = new Map<string, DisplayNode>();
  const edges: ChatBranchEdge[] = [];
  const edgeIds = new Set<string>();
  const displayRootIds: string[] = [];
  const visitedOriginalIds = new Set<string>();
  const processedMessageIds = new Set<string>();
  let summaryId = 0;

  const ensureMessage = (nodeId: string): DisplayNode | undefined => {
    const existing = displayNodes.get(nodeId);
    if (existing) return existing;
    const source = mutableNodes.get(nodeId);
    if (!source) return undefined;
    const display = { node: toRenderedMessage(source), children: [] };
    displayNodes.set(nodeId, display);
    return display;
  };
  const addDisplayEdge = (from: string, to: string, active: boolean) => {
    const edgeId = `${from}\u0000${to}`;
    if (edgeIds.has(edgeId)) return;
    edgeIds.add(edgeId);
    displayNodes.get(from)?.children.push(to);
    edges.push({ from, to, active });
  };
  const originalEdgeActive = (from: string, to: string) =>
    activeEdgeKeys.has(`${from}\u0000${to}`);
  const pathIsActive = (ids: string[]) => {
    for (let index = 1; index < ids.length; index++) {
      if (!originalEdgeActive(ids[index - 1], ids[index])) return false;
    }
    return ids.length > 1;
  };

  const renderFromMessage = (nodeId: string) => {
    visitedOriginalIds.add(nodeId);
    ensureMessage(nodeId);
    if (processedMessageIds.has(nodeId)) return;
    processedMessageIds.add(nodeId);
    const source = mutableNodes.get(nodeId);
    if (!source) return;

    for (const directChildId of source.children) {
      const hiddenIds: string[] = [];
      let targetId = directChildId;
      while (!keepIds.has(targetId)) {
        hiddenIds.push(targetId);
        visitedOriginalIds.add(targetId);
        const hidden = mutableNodes.get(targetId);
        if (!hidden || hidden.children.length !== 1) break;
        targetId = hidden.children[0];
      }
      visitedOriginalIds.add(targetId);
      ensureMessage(targetId);

      const collapseThreshold = density === "branches" ? 1 : MIN_COLLAPSED_RUN;
      if (hiddenIds.length >= collapseThreshold) {
        const first = mutableNodes.get(hiddenIds[0])!;
        const last = mutableNodes.get(hiddenIds[hiddenIds.length - 1])!;
        const id = `summary:${summaryId++}`;
        const pathIds = [nodeId, ...hiddenIds, targetId];
        displayNodes.set(id, {
          node: {
            id,
            x: 0,
            y: 0,
            kind: "summary",
            preview: messagePreview(first.message),
            endPreview: messagePreview(last.message),
            model: "",
            isComment: false,
            activePath: hiddenIds.every((hiddenId) =>
              activeNodeIds.has(hiddenId),
            ),
            activeTerminal: false,
            branchPoint: false,
            continuationCount: 1,
            messageIndex: first.messageIndex,
            endMessageIndex: last.messageIndex,
            collapsedCount: hiddenIds.length,
            terminals: [],
          },
          children: [],
        });
        const active = pathIsActive(pathIds);
        addDisplayEdge(nodeId, id, active);
        addDisplayEdge(id, targetId, active);
      } else {
        let previousId = nodeId;
        for (const hiddenId of hiddenIds) {
          ensureMessage(hiddenId);
          addDisplayEdge(
            previousId,
            hiddenId,
            originalEdgeActive(previousId, hiddenId),
          );
          previousId = hiddenId;
        }
        addDisplayEdge(
          previousId,
          targetId,
          originalEdgeActive(previousId, targetId),
        );
      }
      renderFromMessage(targetId);
    }
  };

  for (const rootId of rootIds) {
    if (!displayRootIds.includes(rootId)) displayRootIds.push(rootId);
    renderFromMessage(rootId);
  }
  for (const nodeId of mutableNodes.keys()) {
    if (visitedOriginalIds.has(nodeId)) continue;
    displayRootIds.push(nodeId);
    renderFromMessage(nodeId);
  }


  // Hierarchical compact tree layout using depth contours (Reingold-Tilford variant)
  interface NodeLayoutInfo {
    childOffsets: Map<string, number>;
    leftContour: number[];
    rightContour: number[];
  }

  const layoutInfo = new Map<string, NodeLayoutInfo>();
  const visitingSubtree = new Set<string>();

  const layoutSubtree = (nodeId: string): NodeLayoutInfo => {
    const cached = layoutInfo.get(nodeId);
    if (cached) return cached;
    if (visitingSubtree.has(nodeId)) {
      return { childOffsets: new Map(), leftContour: [0], rightContour: [0] };
    }
    visitingSubtree.add(nodeId);

    const children = displayNodes.get(nodeId)?.children ?? [];
    if (children.length === 0) {
      visitingSubtree.delete(nodeId);
      const leafInfo: NodeLayoutInfo = {
        childOffsets: new Map(),
        leftContour: [0],
        rightContour: [0],
      };
      layoutInfo.set(nodeId, leafInfo);
      return leafInfo;
    }

    if (children.length === 1) {
      const childId = children[0];
      const childLayout = layoutSubtree(childId);
      visitingSubtree.delete(nodeId);
      const singleInfo: NodeLayoutInfo = {
        childOffsets: new Map([[childId, 0]]),
        leftContour: [0, ...childLayout.leftContour],
        rightContour: [0, ...childLayout.rightContour],
      };
      layoutInfo.set(nodeId, singleInfo);
      return singleInfo;
    }

    const childLayouts = children.map((childId) => layoutSubtree(childId));
    const childX: number[] = [0];
    const accumLeft = [...childLayouts[0].leftContour];
    const accumRight = [...childLayouts[0].rightContour];

    for (let i = 1; i < children.length; i++) {
      const cur = childLayouts[i];
      let shift = 1;
      const overlap = Math.min(accumRight.length, cur.leftContour.length);
      for (let d = 0; d < overlap; d++) {
        const gap = accumRight[d] - cur.leftContour[d] + 1;
        if (gap > shift) shift = gap;
      }
      childX.push(shift);
      for (let d = 0; d < cur.leftContour.length; d++) {
        const l = cur.leftContour[d] + shift;
        const r = cur.rightContour[d] + shift;
        if (d < accumLeft.length) {
          if (l < accumLeft[d]) accumLeft[d] = l;
          if (r > accumRight[d]) accumRight[d] = r;
        } else {
          accumLeft.push(l);
          accumRight.push(r);
        }
      }
    }

    const Xu = (childX[0] + childX[childX.length - 1]) / 2;

    const childOffsets = new Map<string, number>();
    for (let i = 0; i < children.length; i++) {
      childOffsets.set(children[i], childX[i] - Xu);
    }

    visitingSubtree.delete(nodeId);
    const branchInfo: NodeLayoutInfo = {
      childOffsets,
      leftContour: [0, ...accumLeft.map((x) => x - Xu)],
      rightContour: [0, ...accumRight.map((x) => x - Xu)],
    };
    layoutInfo.set(nodeId, branchInfo);
    return branchInfo;
  };

  for (const rootId of displayRootIds) layoutSubtree(rootId);
  for (const nodeId of displayNodes.keys()) layoutSubtree(nodeId);

  // Pack multiple roots side-by-side using depth contours
  const rootPositions = new Map<string, number>();
  const globalLeftContour: number[] = [];
  const globalRightContour: number[] = [];

  for (const rootId of displayRootIds) {
    const layout = layoutInfo.get(rootId);
    if (!layout) continue;
    if (rootPositions.size === 0) {
      rootPositions.set(rootId, 0);
      globalLeftContour.push(...layout.leftContour);
      globalRightContour.push(...layout.rightContour);
    } else {
      let shift = 1;
      const overlap = Math.min(
        globalRightContour.length,
        layout.leftContour.length,
      );
      for (let d = 0; d < overlap; d++) {
        const gap = globalRightContour[d] - layout.leftContour[d] + 1;
        if (gap > shift) shift = gap;
      }
      rootPositions.set(rootId, shift);
      for (let d = 0; d < layout.leftContour.length; d++) {
        const l = layout.leftContour[d] + shift;
        const r = layout.rightContour[d] + shift;
        if (d < globalLeftContour.length) {
          if (l < globalLeftContour[d]) globalLeftContour[d] = l;
          if (r > globalRightContour[d]) globalRightContour[d] = r;
        } else {
          globalLeftContour.push(l);
          globalRightContour.push(r);
        }
      }
    }
  }

  // Assign absolute coordinates
  const positions = new Map<string, { x: number; y: number }>();
  const assignPositions = (nodeId: string, absX: number, depth: number) => {
    if (positions.has(nodeId)) return;
    positions.set(nodeId, { x: absX, y: depth });
    const layout = layoutInfo.get(nodeId);
    if (!layout) return;
    const children = displayNodes.get(nodeId)?.children ?? [];
    for (const childId of children) {
      const relX = layout.childOffsets.get(childId) ?? 0;
      assignPositions(childId, absX + relX, depth + 1);
    }
  };

  for (const rootId of displayRootIds) {
    const rootX = rootPositions.get(rootId) ?? 0;
    assignPositions(rootId, rootX, 0);
  }
  for (const nodeId of displayNodes.keys()) {
    if (!positions.has(nodeId)) {
      assignPositions(nodeId, 0, 0);
    }
  }

  // Normalize so leftmost node is at x = 0
  let minX = Number.POSITIVE_INFINITY;
  for (const pos of positions.values()) {
    if (pos.x < minX) minX = pos.x;
  }
  if (Number.isFinite(minX) && minX !== 0) {
    for (const pos of positions.values()) {
      pos.x -= minX;
    }
  }

  const nodes = [...displayNodes.values()]
    .map(({ node }) => ({
      ...node,
      ...(positions.get(node.id) ?? { x: 0, y: 0 }),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const columns = Math.max(
    1,
    Math.ceil(Math.max(...nodes.map((node) => node.x), 0)) + 1,
  );
  const rows = Math.max(1, Math.max(...nodes.map((node) => node.y), 0) + 1);
  const collapsedMessageCount = nodes.reduce(
    (total, node) => total + node.collapsedCount,
    0,
  );

  return {
    nodes,
    edges,
    columns,
    rows,
    timelineCount: timelines.length,
    messageCount,
    collapsedMessageCount,
  };
}

export function getChatBranchesFromPersistentGraph(
  snapshot: SqlChatBranchGraphData,
  options: ChatGraphBuildOptions = {},
): ChatBranchGraph {
  const messageById = new Map(
    snapshot.messages
      .filter((message) => Boolean(message.chatId))
      .map((message) => [message.chatId!, message]),
  );
  const parentById = new Map(
    snapshot.links.map((link) => [link.messageId, link.parentMessageId]),
  );
  const timelineForHead = (headMessageId?: string) => {
    const reversed: Message[] = [];
    const seen = new Set<string>();
    let messageId = headMessageId;
    while (messageId && !seen.has(messageId)) {
      seen.add(messageId);
      const message = messageById.get(messageId);
      if (message) reversed.push(message);
      messageId = parentById.get(messageId);
    }
    return reversed.reverse();
  };
  return buildChatMessageGraph(
    snapshot.branches.map((branch) => ({
      branchId: branch.id,
      reason: branch.reason,
      active: branch.id === snapshot.activeBranchId,
      messages: timelineForHead(branch.headMessageId || branch.forkMessageId),
    })),
    options,
  );
}

export function getChatBranches(
  targetChat?: Chat | null,
  options: ChatGraphBuildOptions = {},
): ChatBranchGraph {
  const character =
    targetChat === undefined ? characterStore.currentCharacter : undefined;
  const chat =
    targetChat === undefined
      ? character?.chats?.[character.chatPage ?? 0]
      : targetChat;
  if (!chat) return buildChatMessageGraph([], options);
  return buildChatMessageGraph(
    [
      {
        branchId: "__current__",
        reason: "root",
        active: true,
        messages: chat.message ?? [],
      },
    ],
    options,
  );
}
