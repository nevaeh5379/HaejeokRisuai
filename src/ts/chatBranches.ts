import { v4 as uuidv4 } from "uuid";
import { safeStructuredClone } from "./polyfill";
import type { Chat, ChatBranchReason, ChatBranchState, ChatBranchTimeline, Message } from "./storage/schema";

export interface CreateChatTimelineBranchOptions {
  branchMessageIndex: number;
  branchMessageId?: string;
  parentBranchId?: string;
  reason: ChatBranchReason;
  createdAt?: number;
}

export interface ChatBranchSwitchResult {
  previousMessages: Message[];
  nextMessages: Message[];
  branchId: string;
}

export interface RerollAlternatives {
  parentBranchId: string;
  branchIds: string[];
  currentIndex: number;
}

export interface RerollTarget {
  branchMessageIndex: number;
  responseMessageIndex: number | null;
}

export function resolveRerollTarget(
  messages: Message[],
  requestedIndex?: number,
): RerollTarget | null {
  if (messages.length === 0) return null;
  const targetIndex = requestedIndex === undefined
    ? messages.length - 1
    : Math.min(messages.length - 1, Math.max(0, requestedIndex));
  const target = messages[targetIndex];
  if (!target) return null;

  if (target.role === "user") {
    let responseMessageIndex: number | null = null;
    for (let index = targetIndex + 1; index < messages.length; index++) {
      if (messages[index]?.role === "user") break;
      if (messages[index]?.role === "char" && !messages[index]?.isComment) {
        responseMessageIndex = index;
        break;
      }
    }
    return { branchMessageIndex: targetIndex, responseMessageIndex };
  }

  for (let index = targetIndex - 1; index >= 0; index--) {
    if (messages[index]?.role === "user" && !messages[index]?.isComment) {
      return { branchMessageIndex: index, responseMessageIndex: targetIndex };
    }
  }
  return null;
}

function cloneMessages(messages: Message[]): Message[] {
  return safeStructuredClone(messages);
}

function cloneBranchScriptState(chat: Chat) {
  return {
    scriptstate: chat.scriptstate ? safeStructuredClone(chat.scriptstate) : null,
    GLGlobalVariables: chat.GLGlobalVariables
      ? safeStructuredClone(chat.GLGlobalVariables)
      : null,
    useLocallySetGlobalVariables: chat.useLocallySetGlobalVariables ?? null,
  };
}

function restoreBranchScriptState(
  chat: Chat,
  branch: ChatBranchTimeline,
): void {
  if ("scriptstate" in branch) {
    chat.scriptstate = branch.scriptstate
      ? safeStructuredClone(branch.scriptstate)
      : undefined;
  }
  if ("GLGlobalVariables" in branch) {
    chat.GLGlobalVariables = branch.GLGlobalVariables
      ? safeStructuredClone(branch.GLGlobalVariables)
      : undefined;
  }
  if ("useLocallySetGlobalVariables" in branch) {
    chat.useLocallySetGlobalVariables = branch.useLocallySetGlobalVariables ?? undefined;
  }
}

function updateChatMessageRuntime(chat: Chat): void {
  chat.messagesLoaded = true;
  chat.messageOffset = 0;
  chat.messageTotal = chat.message.length;
  chat.messagesFullyLoaded = true;
  chat.detailsLoaded = true;
}

function activeTimeline(chat: Chat): ChatBranchTimeline | undefined {
  const state = chat.branchState;
  if (!state) return undefined;
  return state.branches.find((branch) => branch.id === state.activeBranchId);
}

export function syncActiveChatBranch(chat: Chat): void {
  const state = chat.branchState;
  const active = activeTimeline(chat);
  if (!state || !active) return;
  active.messages = cloneMessages(chat.message.slice(state.baseMessageIndex + 1));
  Object.assign(active, cloneBranchScriptState(chat));
}

function createRootState(chat: Chat, forkIndex: number): ChatBranchState {
  const rootId = uuidv4();
  return {
    baseMessageIndex: forkIndex,
    activeBranchId: rootId,
    branches: [
      {
        id: rootId,
        branchMessageId: chat.message[forkIndex]?.chatId,
        branchMessageIndex: forkIndex,
        reason: "root",
        createdAt: Date.now(),
        messages: cloneMessages(chat.message.slice(forkIndex + 1)),
        ...cloneBranchScriptState(chat),
      },
    ],
  };
}

export function ensureChatBranchState(
  chat: Chat,
  forkIndex: number,
): ChatBranchState {
  if (!chat.branchState || !activeTimeline(chat)) {
    chat.branchState = createRootState(chat, forkIndex);
    return chat.branchState;
  }

  syncActiveChatBranch(chat);
  const state = chat.branchState;
  if (forkIndex < state.baseMessageIndex) {
    const sharedExtension = cloneMessages(
      chat.message.slice(forkIndex + 1, state.baseMessageIndex + 1),
    );
    for (const branch of state.branches) {
      branch.messages = [...cloneMessages(sharedExtension), ...branch.messages];
    }
    state.baseMessageIndex = forkIndex;
  }
  return state;
}

export function getChatBranchMessages(chat: Chat, branchId: string): Message[] {
  const state = chat.branchState;
  if (!state) return cloneMessages(chat.message);
  if (branchId === state.activeBranchId) return cloneMessages(chat.message);
  const branch = state.branches.find((item) => item.id === branchId);
  if (!branch) return cloneMessages(chat.message);
  const prefix = chat.message.slice(0, state.baseMessageIndex + 1);
  return [...cloneMessages(prefix), ...cloneMessages(branch.messages)];
}

export function activateChatBranch(
  chat: Chat,
  branchId: string,
): ChatBranchSwitchResult | null {
  const state = chat.branchState;
  if (!state || !state.branches.some((branch) => branch.id === branchId)) return null;

  const previousMessages = cloneMessages(chat.message);
  syncActiveChatBranch(chat);
  const target = state.branches.find((branch) => branch.id === branchId)!;
  const prefix = chat.message.slice(0, state.baseMessageIndex + 1);
  chat.message = [...cloneMessages(prefix), ...cloneMessages(target.messages)];
  restoreBranchScriptState(chat, target);
  state.activeBranchId = branchId;
  updateChatMessageRuntime(chat);
  return {
    previousMessages,
    nextMessages: cloneMessages(chat.message),
    branchId,
  };
}

export function createChatTimelineBranch(
  chat: Chat,
  options: CreateChatTimelineBranchOptions,
): ChatBranchTimeline {
  const state = ensureChatBranchState(chat, options.branchMessageIndex);
  const parentBranchId = options.parentBranchId ?? state.activeBranchId;
  const branch: ChatBranchTimeline = {
    id: uuidv4(),
    parentBranchId,
    branchMessageId:
      options.branchMessageId ?? chat.message[options.branchMessageIndex]?.chatId,
    branchMessageIndex: options.branchMessageIndex,
    reason: options.reason,
    createdAt: options.createdAt ?? Date.now(),
    messages: cloneMessages(
      chat.message.slice(state.baseMessageIndex + 1, options.branchMessageIndex + 1),
    ),
    ...cloneBranchScriptState(chat),
  };

  state.branches.push(branch);
  state.activeBranchId = branch.id;
  chat.message = cloneMessages(chat.message.slice(0, options.branchMessageIndex + 1));
  updateChatMessageRuntime(chat);
  return branch;
}

export function getRerollAlternatives(
  chat: Chat,
  branchMessageIndex: number,
): RerollAlternatives | null {
  const state = chat.branchState;
  if (!state) return null;
  const active = activeTimeline(chat);
  if (!active) return null;

  const currentMessageId = chat.message[branchMessageIndex]?.chatId;
  const sameFork =
    active.reason === "reroll" &&
    active.branchMessageIndex === branchMessageIndex &&
    (!active.branchMessageId ||
      !currentMessageId ||
      active.branchMessageId === currentMessageId);
  const parentBranchId = sameFork
    ? (active.parentBranchId ?? active.id)
    : active.id;

  const siblings = state.branches
    .filter(
      (branch) =>
        branch.reason === "reroll" &&
        branch.parentBranchId === parentBranchId &&
        branch.branchMessageIndex === branchMessageIndex,
    )
    .filter(
      (branch) =>
        !currentMessageId ||
        !branch.branchMessageId ||
        branch.branchMessageId === currentMessageId,
    )
    .sort((a, b) => a.createdAt - b.createdAt);

  const branchIds = [
    parentBranchId,
    ...siblings.map((branch) => branch.id).filter((id) => id !== parentBranchId),
  ];
  return {
    parentBranchId,
    branchIds,
    currentIndex: Math.max(0, branchIds.indexOf(state.activeBranchId)),
  };
}

export function getChatBranchTimeline(
  chat: Chat,
  branchId: string,
): ChatBranchTimeline | undefined {
  return chat.branchState?.branches.find((branch) => branch.id === branchId);
}

export function getActiveChatBranchId(chat: Chat): string | undefined {
  return chat.branchState?.activeBranchId;
}
