import { getChatBranchMessages } from "../chatBranches";
import {
  getCurrentCharacter,
  type ChatBranchReason,
  type ChatBranchTimeline,
  type Message,
} from "../storage/database.svelte";

export interface RenderedChatBranch {
  branchId: string;
  parentBranchId?: string;
  x: number;
  y: number;
  title: string;
  preview: string;
  model: string;
  reason: "root" | ChatBranchReason;
  active: boolean;
  branchMessageIndex?: number;
}

export interface ChatBranchEdge {
  from: string;
  to: string;
}

export interface ChatBranchGraph {
  nodes: RenderedChatBranch[];
  edges: ChatBranchEdge[];
  columns: number;
  rows: number;
}

function messagePreview(messages: Message[]): string {
  const message = [...messages]
    .reverse()
    .find((item) => !item.isComment && item.data?.trim());
  if (!message) return "";
  const plain = message.data.replace(/\s+/g, " ").trim();
  return plain.length > 140 ? `${plain.slice(0, 137)}...` : plain;
}

function messageModel(messages: Message[]): string {
  return (
    [...messages]
      .reverse()
      .find((item) => item.generationInfo?.model)?.generationInfo?.model ?? ""
  );
}

function branchSort(a: ChatBranchTimeline, b: ChatBranchTimeline): number {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

export function getChatBranches(): ChatBranchGraph {
  const empty: ChatBranchGraph = { nodes: [], edges: [], columns: 0, rows: 0 };
  const character = getCurrentCharacter();
  if (!character?.chats?.length) return empty;
  const chat = character.chats[character.chatPage ?? 0];
  if (!chat) return empty;

  const state = chat.branchState;
  if (!state || state.branches.length === 0) {
    return {
      nodes: [{
        branchId: "__current__",
        x: 0,
        y: 0,
        title: chat.name || "Chat",
        preview: messagePreview(chat.message ?? []),
        model: messageModel(chat.message ?? []),
        reason: "root",
        active: true,
      }],
      edges: [],
      columns: 1,
      rows: 1,
    };
  }

  const byId = new Map(state.branches.map((branch) => [branch.id, branch]));
  const children = new Map<string, ChatBranchTimeline[]>();
  for (const branch of state.branches) {
    if (!branch.parentBranchId || !byId.has(branch.parentBranchId)) continue;
    const list = children.get(branch.parentBranchId) ?? [];
    list.push(branch);
    children.set(branch.parentBranchId, list);
  }
  for (const list of children.values()) list.sort(branchSort);

  const root = state.branches.find((branch) => !branch.parentBranchId) ?? state.branches[0];
  const positions = new Map<string, { x: number; y: number }>();
  let nextLeaf = 0;
  const visiting = new Set<string>();

  const place = (branchId: string, depth: number): number => {
    if (visiting.has(branchId)) return nextLeaf++;
    visiting.add(branchId);
    const childBranches = children.get(branchId) ?? [];
    const childXs = childBranches.map((child) => place(child.id, depth + 1));
    const x = childXs.length === 0
      ? nextLeaf++
      : (childXs[0] + childXs[childXs.length - 1]) / 2;
    positions.set(branchId, { x, y: depth });
    visiting.delete(branchId);
    return x;
  };

  place(root.id, 0);
  for (const branch of state.branches) {
    if (!positions.has(branch.id)) positions.set(branch.id, { x: nextLeaf++, y: 0 });
  }

  const nodes = state.branches
    .map((branch) => {
      const messages = getChatBranchMessages(chat, branch.id);
      const position = positions.get(branch.id) ?? { x: 0, y: 0 };
      return {
        branchId: branch.id,
        parentBranchId: branch.parentBranchId,
        x: position.x,
        y: position.y,
        title: chat.name || "Chat",
        preview: messagePreview(messages),
        model: messageModel(messages),
        reason: branch.reason,
        active: branch.id === state.activeBranchId,
        branchMessageIndex: branch.branchMessageIndex,
      } satisfies RenderedChatBranch;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const edges = nodes
    .filter((node) => node.parentBranchId && byId.has(node.parentBranchId))
    .map((node) => ({ from: node.parentBranchId!, to: node.branchId }));
  const columns = Math.max(
    1,
    Math.ceil(Math.max(...nodes.map((node) => node.x), 0)) + 1,
  );
  const rows = Math.max(
    1,
    Math.max(...nodes.map((node) => node.y), 0) + 1,
  );

  return { nodes, edges, columns, rows };
}
