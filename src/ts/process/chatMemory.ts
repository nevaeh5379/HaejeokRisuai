import type { character, Chat, groupChat } from "../storage/database/schema";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { language } from "../../lang";
import { ChatTokenizer } from "../tokenizer";
import { setChatProcessStage } from "./chatRuntimeState";
import { hanuraiMemory } from "./memory/hanuraiMemory";
import { hypaMemoryV2 } from "./memory/hypav2";
import { hypaMemoryV3 } from "./memory/hypav3";
import { supaMemory } from "./memory/supaMemory";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";
import { requireChatTargetFromIndexes } from "../chatTarget";

interface MemoryState {
  chats: OpenAIChat[];
  currentTokens: number;
  currentChat: Chat;
}

function memoryEnabled(room: character | groupChat) {
  return (
    room.supaMemory &&
    (settingsStore.state.supaModelType !== "none" ||
      settingsStore.state.hanuraiEnable ||
      settingsStore.state.hypav2 ||
      settingsStore.state.hypaV3)
  );
}

async function trimHistoryToContext(
  chats: OpenAIChat[],
  currentTokens: number,
  maxContextTokens: number,
  tokenizer: ChatTokenizer,
) {
  if (currentTokens <= maxContextTokens) {
    return { ok: true as const, chats, currentTokens };
  }

  const tokenCounts = await tokenizer.tokenizeChatsDetailed(chats);
  let removeCount = 0;
  while (currentTokens > maxContextTokens && removeCount < chats.length - 1) {
    currentTokens -= tokenCounts[removeCount++];
  }
  if (currentTokens > maxContextTokens) {
    return { ok: false as const, chats, currentTokens };
  }
  if (removeCount > 0) chats.splice(0, removeCount);
  return { ok: true as const, chats, currentTokens };
}

export interface ApplyChatMemoryOptions {
  chats: OpenAIChat[];
  currentTokens: number;
  maxContextTokens: number;
  currentChat: Chat;
  nowChatroom: character | groupChat;
  currentChar: character;
  tokenizer: ChatTokenizer;
  selectedChar: number;
  selectedChat: number;
  stage1Start: number;
  throwError: (error: string) => void;
  /** Bypass configured memory engines while still applying normal context trimming. */
  skipMemory?: boolean;
}

function storedChat(options: ApplyChatMemoryOptions) {
  return characterStore.characters[options.selectedChar].chats[
    options.selectedChat
  ];
}

async function applyWithoutMemory(
  options: ApplyChatMemoryOptions,
  state: MemoryState,
) {
  const trimmed = await trimHistoryToContext(
    state.chats,
    state.currentTokens,
    options.maxContextTokens,
    options.tokenizer,
  );
  if (!trimmed.ok) {
    options.throwError(
      `${language.errors.toomuchtoken}\n\nRequired Tokens: ${trimmed.currentTokens}`,
    );
    return { ok: false as const };
  }

  state.chats = trimmed.chats;
  state.currentTokens = trimmed.currentTokens;
  state.currentChat.lastMemory = state.chats[0].memo;
  return { ok: true as const, state };
}

async function applyHanuraiMemory(
  options: ApplyChatMemoryOptions,
  state: MemoryState,
) {
  const result = await hanuraiMemory(state.chats, {
    currentTokens: state.currentTokens,
    maxContextTokens: options.maxContextTokens,
    tokenizer: options.tokenizer,
    serverIndexId: state.currentChat.id,
  });
  if (result === false) return { ok: false as const };
  return {
    ok: true as const,
    state: { ...state, chats: result.chats, currentTokens: result.tokens },
  };
}

async function applyHypaV2Memory(
  options: ApplyChatMemoryOptions,
  state: MemoryState,
) {
  const result = await hypaMemoryV2(
    state.chats,
    state.currentTokens,
    options.maxContextTokens,
    state.currentChat,
    options.nowChatroom,
    options.tokenizer,
    {
      currentChar: options.currentChar,
      chatTarget: requireChatTargetFromIndexes(
        options.selectedChar,
        options.selectedChat,
      ),
    },
  );
  if (result.error) {
    options.throwError(result.error);
    return { ok: false as const };
  }

  state.currentChat.hypaV2Data = result.memory ?? state.currentChat.hypaV2Data;
  storedChat(options).hypaV2Data = state.currentChat.hypaV2Data;
  return {
    ok: true as const,
    state: {
      chats: result.chats,
      currentTokens: result.currentTokens,
      currentChat: storedChat(options),
    },
  };
}

async function applyHypaV3Memory(
  options: ApplyChatMemoryOptions,
  state: MemoryState,
) {
  const result = await hypaMemoryV3(
    state.chats,
    state.currentTokens,
    options.maxContextTokens,
    state.currentChat,
    options.nowChatroom,
    options.tokenizer,
    {
      currentChar: options.currentChar,
      chatTarget: requireChatTargetFromIndexes(
        options.selectedChar,
        options.selectedChat,
      ),
    },
  );
  if (result.error) {
    if (result.memory) {
      state.currentChat.hypaV3Data = result.memory;
      storedChat(options).hypaV3Data = state.currentChat.hypaV3Data;
    }
    options.throwError(result.error);
    return { ok: false as const };
  }

  state.currentChat.hypaV3Data = result.memory ?? state.currentChat.hypaV3Data;
  storedChat(options).hypaV3Data = state.currentChat.hypaV3Data;
  return {
    ok: true as const,
    state: {
      chats: result.chats,
      currentTokens: result.currentTokens,
      currentChat: storedChat(options),
    },
  };
}

async function applySupaMemory(
  options: ApplyChatMemoryOptions,
  state: MemoryState,
) {
  const result = await supaMemory(
    state.chats,
    state.currentTokens,
    options.maxContextTokens,
    state.currentChat,
    options.nowChatroom,
    options.tokenizer,
    {
      asHyper: settingsStore.state.hypaMemory,
      chatTarget: requireChatTargetFromIndexes(
        options.selectedChar,
        options.selectedChat,
      ),
      currentChar: options.currentChar,
    },
  );
  if (result.error) {
    options.throwError(result.error);
    return { ok: false as const };
  }

  state.currentChat.supaMemoryData = result.memory ?? state.currentChat.supaMemoryData;
  storedChat(options).supaMemoryData = state.currentChat.supaMemoryData;
  state.currentChat.lastMemory = result.lastId ?? state.currentChat.lastMemory;
  return {
    ok: true as const,
    state: {
      ...state,
      chats: result.chats,
      currentTokens: result.currentTokens,
    },
  };
}

function runConfiguredMemory(options: ApplyChatMemoryOptions, state: MemoryState) {
  if (settingsStore.state.hanuraiEnable) return applyHanuraiMemory(options, state);
  if (settingsStore.state.hypav2) return applyHypaV2Memory(options, state);
  if (settingsStore.state.hypaV3) return applyHypaV3Memory(options, state);
  return applySupaMemory(options, state);
}

export async function applyChatMemory(options: ApplyChatMemoryOptions) {
  const stage1Duration = Date.now() - options.stage1Start;
  const initialState: MemoryState = {
    chats: options.chats,
    currentTokens: options.currentTokens,
    currentChat: options.currentChat,
  };

  if (options.skipMemory || !memoryEnabled(options.nowChatroom)) {
    const result = await applyWithoutMemory(options, initialState);
    if (!result.ok) return { ok: false as const };
    return {
      ok: true as const,
      ...result.state,
      stage1Duration,
      stage2Duration: 0,
    };
  }

  setChatProcessStage(options.currentChat.id, 2);
  const stage2Start = Date.now();
  const result = await runConfiguredMemory(options, initialState);
  if (!result.ok) return { ok: false as const };
  setChatProcessStage(options.currentChat.id, 1);
  return {
    ok: true as const,
    ...result.state,
    stage1Duration,
    stage2Duration: Date.now() - stage2Start,
  };
}
