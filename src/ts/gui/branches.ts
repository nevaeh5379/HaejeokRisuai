import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { getChatBranchMessages } from "../chatBranches";
import type {
  Chat,
  ChatBranchReason,
  Message,
} from "../storage/database/schema";

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
  const keepIds = new Set<string>();
  if (messageCount <= LONG_CHAT_THRESHOLD) {
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
      if (distance >= CONTEXT_RADIUS) continue;
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

      if (hiddenIds.length >= MIN_COLLAPSED_RUN) {
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

  const positions = new Map<string, { x: number; y: number }>();
  const placing = new Set<string>();
  let nextLeaf = 0;
  const place = (nodeId: string, depth: number): number => {
    const positioned = positions.get(nodeId);
    if (positioned) return positioned.x;
    if (placing.has(nodeId)) {
      const x = nextLeaf++;
      positions.set(nodeId, { x, y: depth });
      return x;
    }
    placing.add(nodeId);
    const childXs = (displayNodes.get(nodeId)?.children ?? []).map((childId) =>
      place(childId, depth + 1),
    );
    const x =
      childXs.length === 0
        ? nextLeaf++
        : (childXs[0] + childXs[childXs.length - 1]) / 2;
    positions.set(nodeId, { x, y: depth });
    placing.delete(nodeId);
    return x;
  };

  for (const rootId of displayRootIds) place(rootId, 0);
  for (const nodeId of displayNodes.keys()) {
    if (!positions.has(nodeId)) place(nodeId, 0);
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

export function getChatBranches(targetChat?: Chat | null): ChatBranchGraph {
  const character =
    targetChat === undefined ? characterStore.currentCharacter : undefined;
  const chat =
    targetChat === undefined
      ? character?.chats?.[character.chatPage ?? 0]
      : targetChat;
  if (!chat) return buildChatMessageGraph([]);

  const state = chat.branchState;
  if (!state || state.branches.length === 0) {
    return buildChatMessageGraph([
      {
        branchId: "__current__",
        reason: "root",
        active: true,
        messages: chat.message ?? [],
      },
    ]);
  }

  return buildChatMessageGraph(
    state.branches.map((branch) => ({
      branchId: branch.id,
      reason: branch.reason,
      active: branch.id === state.activeBranchId,
      messages: getChatBranchMessages(chat, branch.id),
    })),
  );
}
