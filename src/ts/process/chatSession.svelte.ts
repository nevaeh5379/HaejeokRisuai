import { get } from "svelte/store";
import type {
  character,
  Chat,
  MessagePresetInfo,
} from "../storage/database.svelte";
import { changeToPreset } from "../storage/database.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { selectedCharID } from "../stores.svelte";
import { alertToast } from "../alert";
import { language } from "../../lang";
import { ChatTokenizer } from "../tokenizer";
import { findCharacterbyId, parseToggleSyntax } from "../util";
import { v4 } from "uuid";
import { groupOrder } from "./group";
import { risuChatParser } from "./scripts";
import { getModuleToggles } from "./modules";
import { pluginV2 } from "../plugins/plugins.svelte";
import { preLoadChat } from "./coldstorage.svelte";
import { chatProcessStage, doingChat } from "./chatRuntimeState";
import {
  connectionOpen,
  peerRevertChat,
  peerSafeCheck,
  peerSync,
} from "../sync/multiuser";
import type { ChatErrorContext } from "./chatError.svelte";

export interface GroupGenerationRequest {
  chatProcessIndex: number;
  chatAdditonalTokens: number;
  signal: AbortSignal;
}

function createCharacterLookup() {
  const cache: Record<string, character> = {};
  return (id: string) => {
    if (cache[id]) return cache[id];
    const character = findCharacterbyId(id);
    cache[id] = character;
    return character;
  };
}

function runCurrentChatVariables(chat: Chat, currentChar: character) {
  for (const message of chat.message) {
    message.data = risuChatParser(message.data, {
      chara: currentChar,
      runVar: true,
    });
  }
  return chat;
}

async function applyPresetChain(chatProcessIndex: number) {
  if (chatProcessIndex !== -1 || !settingsStore.state.presetChain) return;
  const names = settingsStore.state.presetChain
    .split(",")
    .map((name) => name.trim());
  const name = names[Math.floor(Math.random() * names.length)];
  const presetIndex = presetStore.summaries.findIndex(
    (summary) => summary.name === name,
  );
  if (presetIndex === -1) {
    alertToast(`Cannot find preset: ${name}`);
  } else {
    await changeToPreset(presetIndex, true);
  }
}

async function synchronizePeer(throwError: (error: string) => void) {
  if (!connectionOpen) return true;
  chatProcessStage.set(4);
  const safe = await peerSafeCheck();
  if (!safe) {
    peerRevertChat();
    doingChat.set(false);
    throwError(language.otherUserRequesting);
    return false;
  }
  await peerSync();
  chatProcessStage.set(0);
  return true;
}

function buildPromptInfo(): MessagePresetInfo {
  if (!settingsStore.state.promptInfoInsideChat) return {};
  const promptToggles = parseToggleSyntax(
    settingsStore.state.customPromptTemplateToggle + getModuleToggles(),
  ).flatMap((toggle) => {
    const raw =
      settingsStore.state.globalChatVariables[`toggle_${toggle.key}`];
    if (toggle.type === "select" || toggle.type === "text") {
      return [{ key: toggle.value, value: toggle.options[raw] }];
    }
    return raw === "1" ? [{ key: toggle.value, value: "ON" }] : [];
  });
  return {
    promptName: presetStore.activePreset?.name ?? "",
    promptToggles,
  };
}

function getGroupOrder(
  room: Extract<(typeof characterStore.characters)[number], { type: "group" }>,
) {
  const lastMessage = room.chats[room.chatPage].message.at(-1);
  let order = room.characters
    .map((id, index) => ({
      id,
      talkness: room.characterActive[index] ? room.characterTalks[index] : -1,
      index,
    }))
    .filter((entry) => entry.talkness > 0);
  if (!room.orderByOrder) {
    order = groupOrder(order, lastMessage?.data).filter(
      (entry) => entry.id !== lastMessage?.saying,
    );
  }
  return order;
}

export interface PrepareChatSessionOptions {
  chatProcessIndex: number;
  chatAdditonalTokens?: number;
  abortSignal: AbortSignal;
  errorContext: ChatErrorContext;
  throwError: (error: string) => void;
  sendGroupMember: (request: GroupGenerationRequest) => Promise<boolean>;
}

export async function prepareChatSession(options: PrepareChatSessionOptions) {
  chatProcessStage.set(0);
  if ((characterStore as any)?.ensureLoaded) {
    await (characterStore as any).ensureLoaded();
  }

  if (get(doingChat) && options.chatProcessIndex === -1) {
    return { status: "done" as const, result: false };
  }
  doingChat.set(true);
  await applyPresetChain(options.chatProcessIndex);
  if (!(await synchronizePeer(options.throwError))) {
    return { status: "done" as const, result: false };
  }

  settingsStore.state.statics.messages += 1;
  const selectedChar = get(selectedCharID);
  options.errorContext.selectedChar = selectedChar;
  const nowChatroom = characterStore.characters[selectedChar];
  if (!nowChatroom) {
    doingChat.set(false);
    return { status: "done" as const, result: false };
  }

  characterStore.touchCharacterInteraction(selectedChar);
  const selectedChat = nowChatroom.chatPage;
  options.errorContext.selectedChat = selectedChat;
  await preLoadChat(selectedChar, selectedChat, {
    full: true,
    generation: pluginV2.chatOutput.size === 0,
  });
  for (const message of nowChatroom.chats[selectedChat].message) {
    message.chatId ??= v4();
  }

  const promptInfo = buildPromptInfo();
  const calculatedChatTokens = settingsStore.state.aiModel.startsWith("gpt")
    ? 5
    : 3;
  const findCharacter = createCharacterLookup();
  let currentChar: character;

  if (nowChatroom.type === "group") {
    if (options.chatProcessIndex === -1) {
      for (const entry of getGroupOrder(nowChatroom)) {
        const result = await options.sendGroupMember({
          chatProcessIndex: entry.index,
          chatAdditonalTokens: calculatedChatTokens,
          signal: options.abortSignal,
        });
        if (!result) return { status: "done" as const, result: false };
      }
      return { status: "done" as const, result: true };
    }

    currentChar = findCharacter(
      nowChatroom.characters[options.chatProcessIndex],
    );
    if (!currentChar) {
      options.throwError(
        `cannot find character: ${nowChatroom.characters[options.chatProcessIndex]}`,
      );
      return { status: "done" as const, result: false };
    }
  } else {
    currentChar = nowChatroom;
  }

  options.errorContext.currentChar = currentChar;
  const tokenizer = new ChatTokenizer(
    options.chatAdditonalTokens ?? calculatedChatTokens,
    settingsStore.state.aiModel.startsWith("gpt") ? "noName" : "name",
  );
  const currentChat = runCurrentChatVariables(
    nowChatroom.chats[selectedChat],
    currentChar,
  );
  nowChatroom.chats[selectedChat] = currentChat;

  return {
    status: "ready" as const,
    selectedChar,
    selectedChat,
    nowChatroom,
    currentChar,
    currentChat,
    promptInfo,
    tokenizer,
    maxContextTokens: settingsStore.state.maxContext,
    findCharacter,
  };
}
