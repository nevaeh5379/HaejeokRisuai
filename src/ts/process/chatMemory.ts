import type { character, Chat, groupChat } from "../storage/database.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { language } from "../../lang";
import { ChatTokenizer } from "../tokenizer";
import { chatProcessStage } from "./chatRuntimeState";
import { hanuraiMemory } from "./memory/hanuraiMemory";
import { hypaMemoryV2 } from "./memory/hypav2";
import { hypaMemoryV3 } from "./memory/hypav3";
import { supaMemory } from "./memory/supaMemory";
import type { OpenAIChat } from "./index.svelte";

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
    currentTokens -= tokenCounts[removeCount];
    removeCount += 1;
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
}

export async function applyChatMemory(options: ApplyChatMemoryOptions) {
  let { chats, currentTokens, currentChat } = options;
  const stage1Duration = Date.now() - options.stage1Start;
  let stage2Duration = 0;

  if (!memoryEnabled(options.nowChatroom)) {
    const trimmed = await trimHistoryToContext(
      chats,
      currentTokens,
      options.maxContextTokens,
      options.tokenizer,
    );
    if (!trimmed.ok) {
      options.throwError(
        `${language.errors.toomuchtoken}\n\nRequired Tokens: ${trimmed.currentTokens}`,
      );
      return { ok: false as const };
    }
    chats = trimmed.chats;
    currentTokens = trimmed.currentTokens;
    currentChat.lastMemory = chats[0].memo;
    return {
      ok: true as const,
      chats,
      currentTokens,
      currentChat,
      stage1Duration,
      stage2Duration,
    };
  }

  chatProcessStage.set(2);
  const stage2Start = Date.now();

  if (settingsStore.state.hanuraiEnable) {
    const result = await hanuraiMemory(chats, {
      currentTokens,
      maxContextTokens: options.maxContextTokens,
      tokenizer: options.tokenizer,
      serverIndexId: currentChat.id,
    });
    if (result === false) return { ok: false as const };
    chats = result.chats;
    currentTokens = result.tokens;
  } else if (settingsStore.state.hypav2) {
    const result = await hypaMemoryV2(
      chats,
      currentTokens,
      options.maxContextTokens,
      currentChat,
      options.nowChatroom,
      options.tokenizer,
    );
    if (result.error) {
      options.throwError(result.error);
      return { ok: false as const };
    }
    chats = result.chats;
    currentTokens = result.currentTokens;
    currentChat.hypaV2Data = result.memory ?? currentChat.hypaV2Data;
    characterStore.characters[options.selectedChar].chats[
      options.selectedChat
    ].hypaV2Data = currentChat.hypaV2Data;
    currentChat =
      characterStore.characters[options.selectedChar].chats[options.selectedChat];
  } else if (settingsStore.state.hypaV3) {
    const result = await hypaMemoryV3(
      chats,
      currentTokens,
      options.maxContextTokens,
      currentChat,
      options.nowChatroom,
      options.tokenizer,
    );
    if (result.error) {
      if (result.memory) {
        currentChat.hypaV3Data = result.memory;
        characterStore.characters[options.selectedChar].chats[
          options.selectedChat
        ].hypaV3Data = currentChat.hypaV3Data;
      }
      options.throwError(result.error);
      return { ok: false as const };
    }
    chats = result.chats;
    currentTokens = result.currentTokens;
    currentChat.hypaV3Data = result.memory ?? currentChat.hypaV3Data;
    characterStore.characters[options.selectedChar].chats[
      options.selectedChat
    ].hypaV3Data = currentChat.hypaV3Data;
    currentChat =
      characterStore.characters[options.selectedChar].chats[options.selectedChat];
  } else {
    const result = await supaMemory(
      chats,
      currentTokens,
      options.maxContextTokens,
      currentChat,
      options.nowChatroom,
      options.tokenizer,
      { asHyper: settingsStore.state.hypaMemory },
    );
    if (result.error) {
      options.throwError(result.error);
      return { ok: false as const };
    }
    chats = result.chats;
    currentTokens = result.currentTokens;
    currentChat.supaMemoryData = result.memory ?? currentChat.supaMemoryData;
    characterStore.characters[options.selectedChar].chats[
      options.selectedChat
    ].supaMemoryData = currentChat.supaMemoryData;
    currentChat.lastMemory = result.lastId ?? currentChat.lastMemory;
  }

  stage2Duration = Date.now() - stage2Start;
  chatProcessStage.set(1);
  return {
    ok: true as const,
    chats,
    currentTokens,
    currentChat,
    stage1Duration,
    stage2Duration,
  };
}
