import { v4 as uuidv4 } from "uuid";
import { safeStructuredClone } from "./polyfill";
import type {
  Chat,
  ChatBranchInfo,
  ChatBranchReason,
  Message,
} from "./storage/database.svelte";

export interface CreateChatBranchOptions {
  parentChatId: string;
  branchMessageIndex: number;
  branchMessageId?: string;
  reason: ChatBranchReason;
  keepThroughIndex: number;
  createdAt?: number;
}

export interface RerollAlternatives {
  parentChatId: string;
  chats: Chat[];
  currentIndex: number;
}
function cloneMessagesWithFreshIds(messages: Message[]) {
  const messageIdMap = new Map<string, string>();
  const cloned = messages.map((message) => {
    const next = safeStructuredClone(message);
    const nextId = uuidv4();
    if (message.chatId) messageIdMap.set(message.chatId, nextId);
    next.chatId = nextId;
    return next;
  });
  return { messages: cloned, messageIdMap };
}

function remapBookmarks(chat: Chat, messageIdMap: Map<string, string>) {
  chat.bookmarks = chat.bookmarks
    ?.map((id) => messageIdMap.get(id))
    .filter((id): id is string => Boolean(id));
  if (!chat.bookmarkNames) return;
  chat.bookmarkNames = Object.fromEntries(
    Object.entries(chat.bookmarkNames)
      .map(([id, name]) => [messageIdMap.get(id), name] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0])),
  );
}
export function createChatBranch(
  source: Chat,
  options: CreateChatBranchOptions,
): Chat {
  const chat = safeStructuredClone(source);
  chat.id = uuidv4();
  chat.branch = {
    parentChatId: options.parentChatId,
    branchMessageId: options.branchMessageId,
    branchMessageIndex: options.branchMessageIndex,
    reason: options.reason,
    createdAt: options.createdAt ?? Date.now(),
  } satisfies ChatBranchInfo;

  const keptMessages = chat.message.slice(0, options.keepThroughIndex + 1);
  const cloned = cloneMessagesWithFreshIds(keptMessages);
  chat.message = cloned.messages;
  remapBookmarks(chat, cloned.messageIdMap);

  chat.suggestMessages = [];
  chat.supaMemoryData = undefined;
  chat.hypaV2Data = undefined;
  chat.hypaV3Data = undefined;
  chat.lastMemory = undefined;
  chat.isStreaming = false;
  chat.activeStreamingDisplayOptimizationMode = undefined;
  chat.preventMessageCompaction = false;
  chat.messagesLoaded = true;
  chat.messageOffset = 0;
  chat.messageTotal = chat.message.length;
  chat.messagesFullyLoaded = true;
  chat.detailsLoaded = true;
  chat.lastDate = Date.now();
  return chat;
}
export function getRerollAlternatives(
  chats: Chat[],
  activeChat: Chat,
  branchMessageIndex: number,
): RerollAlternatives {
  const activeId = activeChat.id ?? "";
  const sameFork =
    activeChat.branch?.reason === "reroll" &&
    activeChat.branch.branchMessageIndex === branchMessageIndex;
  const parentChatId = sameFork
    ? activeChat.branch!.parentChatId
    : activeId;
  const branchMessageId = sameFork
    ? activeChat.branch?.branchMessageId
    : activeChat.message[branchMessageIndex]?.chatId;

  const parent = chats.find((chat) => chat.id === parentChatId) ?? activeChat;
  const rerolls = chats
    .filter(
      (chat) =>
        chat.branch?.reason === "reroll" &&
        chat.branch.parentChatId === parentChatId &&
        chat.branch.branchMessageIndex === branchMessageIndex &&
        (!branchMessageId ||
          !chat.branch.branchMessageId ||
          chat.branch.branchMessageId === branchMessageId),
    )
    .sort(
      (a, b) => (a.branch?.createdAt ?? 0) - (b.branch?.createdAt ?? 0),
    );
  const alternatives = [parent, ...rerolls.filter((chat) => chat.id !== parent.id)];
  return {
    parentChatId: parent.id ?? parentChatId,
    chats: alternatives,
    currentIndex: Math.max(
      0,
      alternatives.findIndex((chat) => chat.id === activeChat.id),
    ),
  };
}

function indexChatsById(chats: Chat[]): Map<string, Chat> {
  return new Map(
    chats.filter((chat) => chat.id).map((chat) => [chat.id!, chat]),
  );
}

function getBranchRootIdFromMap(byId: Map<string, Chat>, chatId: string): string {
  let currentId = chatId;
  const visited = new Set<string>();
  while (!visited.has(currentId)) {
    visited.add(currentId);
    const parentId = byId.get(currentId)?.branch?.parentChatId;
    if (!parentId || !byId.has(parentId)) return currentId;
    currentId = parentId;
  }
  return chatId;
}

export function getBranchRootId(chats: Chat[], chatId: string): string {
  return getBranchRootIdFromMap(indexChatsById(chats), chatId);
}

export function getBranchFamily(chats: Chat[], currentChatId: string): Chat[] {
  const byId = indexChatsById(chats);
  const rootId = getBranchRootIdFromMap(byId, currentChatId);
  return chats.filter(
    (chat) => !!chat.id && getBranchRootIdFromMap(byId, chat.id) === rootId,
  );
}
