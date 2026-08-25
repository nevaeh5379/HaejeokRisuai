import { get } from "svelte/store";
import type {
  character,
  groupChat,
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

export interface PrepareChatSessionOptions {
  chatProcessIndex: number;
  chatAdditonalTokens?: number;
  abortSignal: AbortSignal;
  errorContext: ChatErrorContext;
  throwError: (error: string) => void;
  sendGroupMember: (request: GroupGenerationRequest) => Promise<boolean>;
}

function createCharacterLookup() {
  const cache: Record<string, character> = {};
  return (id: string) => {
    if (cache[id]) return cache[id];
    const found = findCharacterbyId(id);
    cache[id] = found;
    return found;
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

function getGroupOrder(room: groupChat) {
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

async function initializeGeneration(options: PrepareChatSessionOptions) {
  chatProcessStage.set(0);
  if ((characterStore as any)?.ensureLoaded) {
    await (characterStore as any).ensureLoaded();
  }
  if (get(doingChat) && options.chatProcessIndex === -1) return false;

  doingChat.set(true);
  await applyPresetChain(options.chatProcessIndex);
  return synchronizePeer(options.throwError);
}

async function loadSelectedChat(options: PrepareChatSessionOptions) {
  settingsStore.state.statics.messages += 1;
  const selectedChar = get(selectedCharID);
  options.errorContext.selectedChar = selectedChar;
  const nowChatroom = characterStore.characters[selectedChar];
  if (!nowChatroom) {
    doingChat.set(false);
    return null;
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
  return { selectedChar, selectedChat, nowChatroom };
}

async function runGroupGeneration(
  options: PrepareChatSessionOptions,
  room: groupChat,
  calculatedChatTokens: number,
) {
  for (const entry of getGroupOrder(room)) {
    const result = await options.sendGroupMember({
      chatProcessIndex: entry.index,
      chatAdditonalTokens: calculatedChatTokens,
      signal: options.abortSignal,
    });
    if (!result) return false;
  }
  return true;
}

async function resolveCurrentCharacter(
  options: PrepareChatSessionOptions,
  room: character | groupChat,
  calculatedChatTokens: number,
  findCharacter: (id: string) => character,
) {
  if (room.type !== "group") {
    return { status: "ready" as const, currentChar: room };
  }
  if (options.chatProcessIndex === -1) {
    return {
      status: "done" as const,
      result: await runGroupGeneration(options, room, calculatedChatTokens),
    };
  }

  const characterId = room.characters[options.chatProcessIndex];
  const currentChar = findCharacter(characterId);
  if (!currentChar) {
    options.throwError(`cannot find character: ${characterId}`);
    return { status: "done" as const, result: false };
  }
  return { status: "ready" as const, currentChar };
}

function createTokenizer(additionalTokens: number) {
  return new ChatTokenizer(
    additionalTokens,
    settingsStore.state.aiModel.startsWith("gpt") ? "noName" : "name",
  );
}

export async function prepareChatSession(options: PrepareChatSessionOptions) {
  if (!(await initializeGeneration(options))) {
    return { status: "done" as const, result: false };
  }

  const selection = await loadSelectedChat(options);
  if (!selection) return { status: "done" as const, result: false };

  const calculatedChatTokens = settingsStore.state.aiModel.startsWith("gpt")
    ? 5
    : 3;
  const findCharacter = createCharacterLookup();
  const speaker = await resolveCurrentCharacter(
    options,
    selection.nowChatroom,
    calculatedChatTokens,
    findCharacter,
  );
  if (speaker.status === "done") return speaker;

  options.errorContext.currentChar = speaker.currentChar;
  const tokenizer = createTokenizer(
    options.chatAdditonalTokens ?? calculatedChatTokens,
  );
  const currentChat = runCurrentChatVariables(
    selection.nowChatroom.chats[selection.selectedChat],
    speaker.currentChar,
  );
  selection.nowChatroom.chats[selection.selectedChat] = currentChat;

  return {
    status: "ready" as const,
    ...selection,
    currentChar: speaker.currentChar,
    currentChat,
    promptInfo: buildPromptInfo(),
    tokenizer,
    maxContextTokens: settingsStore.state.maxContext,
    findCharacter,
  };
}
