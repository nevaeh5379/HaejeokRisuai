import { getBranchFamily, getBranchRootId } from "../chatBranches";
import {
  getCurrentCharacter,
  type Chat,
  type ChatBranchReason,
} from "../storage/database.svelte";

export interface RenderedChatBranch {
  chatId: string;
  parentChatId?: string;
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
function chatPreview(chat: Chat): string {
  const message = [...(chat.message ?? [])]
    .reverse()
    .find((item) => !item.isComment && item.data?.trim());
  if (!message) return "";
  const plain = message.data.replace(/\s+/g, " ").trim();
  return plain.length > 140 ? `${plain.slice(0, 137)}...` : plain;
}

function chatModel(chat: Chat): string {
  return (
    [...(chat.message ?? [])]
      .reverse()
      .find((item) => item.generationInfo?.model)?.generationInfo?.model ?? ""
  );
}

function branchSort(a: Chat, b: Chat): number {
  const aCreated = a.branch?.createdAt ?? 0;
  const bCreated = b.branch?.createdAt ?? 0;
  if (aCreated !== bCreated) return aCreated - bCreated;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

export function getChatBranches(): ChatBranchGraph {
  const character = getCurrentCharacter();
  const empty: ChatBranchGraph = { nodes: [], edges: [], columns: 0, rows: 0 };
  if (!character?.chats?.length) return empty;

  const activeChat = character.chats[character.chatPage ?? 0];
  if (!activeChat?.id) return empty;
  const family = getBranchFamily(character.chats, activeChat.id);
  const byId = new Map(
    family.filter((chat) => chat.id).map((chat) => [chat.id!, chat]),
  );
  const rootId = getBranchRootId(character.chats, activeChat.id);
  const root = byId.get(rootId) ?? activeChat;
  if (!root.id) return empty;

  const children = new Map<string, Chat[]>();
  for (const chat of family) {
    const parentId = chat.branch?.parentChatId;
    if (!chat.id || !parentId || !byId.has(parentId)) continue;
    const list = children.get(parentId) ?? [];
    list.push(chat);
    children.set(parentId, list);
  }
  for (const list of children.values()) list.sort(branchSort);

  const positions = new Map<string, { x: number; y: number }>();
  let nextLeaf = 0;
  const visiting = new Set<string>();
  const place = (chatId: string, depth: number): number => {
    if (visiting.has(chatId)) return nextLeaf++;
    visiting.add(chatId);
    const childChats = children.get(chatId) ?? [];
    let x: number;
    if (childChats.length === 0) {
      x = nextLeaf++;
    } else {
      const childXs = childChats.map((child) => place(child.id!, depth + 1));
      x = (childXs[0] + childXs[childXs.length - 1]) / 2;
    }
    positions.set(chatId, { x, y: depth });
    visiting.delete(chatId);
    return x;
  };
  place(root.id, 0);
  for (const chat of family) {
    if (!chat.id || positions.has(chat.id)) continue;
    positions.set(chat.id, { x: nextLeaf++, y: 0 });
  }

  const nodes = family
    .filter((chat): chat is Chat & { id: string } => Boolean(chat.id))
    .map((chat) => {
      const position = positions.get(chat.id) ?? { x: 0, y: 0 };
      return {
        chatId: chat.id,
        parentChatId: chat.branch?.parentChatId,
        x: position.x,
        y: position.y,
        title: chat.name || "Chat",
        preview: chatPreview(chat),
        model: chatModel(chat),
        reason: chat.id === root.id ? "root" : (chat.branch?.reason ?? "manual"),
        active: chat.id === activeChat.id,
        branchMessageIndex: chat.branch?.branchMessageIndex,
      } satisfies RenderedChatBranch;
    })
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const edges = nodes
    .filter((node) => node.parentChatId && byId.has(node.parentChatId))
    .map((node) => ({ from: node.parentChatId!, to: node.chatId }));
  const columns = Math.max(1, Math.ceil(Math.max(...nodes.map((node) => node.x), 0)) + 1);
  const rows = Math.max(1, Math.max(...nodes.map((node) => node.y), 0) + 1);

  return { nodes, edges, columns, rows };
}
