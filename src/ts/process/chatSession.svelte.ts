import { get } from "svelte/store";
import type { character, groupChat, Chat, MessagePresetInfo } from "../storage/database/schema";
import { changeToPreset } from "../storage/presets/presetService";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { selectedCharID } from "../stores.svelte";
import { alertToast } from "../alert";
import { language } from "../../lang";
import { ChatTokenizer } from "../tokenizer";
import { findCharacterbyId, parseToggleSyntax } from "../util";
import { v4 } from "uuid";
import { selectGroupGenerationOrder } from "@risuai/chat-core/group.cjs";
import { risuChatParser } from "./scripts";
import { getModuleToggles } from "./modules";
import { pluginV2 } from "../plugins/plugins.svelte";
import { preLoadChat } from "./coldstorage.svelte";
import { setChatProcessStage } from "./chatRuntimeState";
import {
  connectionOpen,
  peerRevertChat,
  peerSafeCheck,
  peerSync,
} from "../sync/multiuser";
import type { ChatErrorContext } from "./chatError.svelte";
import { requireChatTargetFromIndexes, type ChatExecutionTarget } from "../chatTarget";

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
  targetCharacterId?: string;
  targetChatId?: string;
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

function runCurrentChatVariables(
  chat: Chat,
  currentChar: character,
  chatTarget: ChatExecutionTarget,
) {
  for (const message of chat.message) {
    message.data = risuChatParser(message.data, {
      chara: currentChar,
      runVar: true,
      chatTarget,
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

async function synchronizePeer(
  throwError: (error: string) => void,
  chatId?: string,
) {
  if (!connectionOpen) return true;
  setChatProcessStage(chatId, 4);
  const safe = await peerSafeCheck();
  if (!safe) {
    peerRevertChat();
    throwError(language.otherUserRequesting);
    return false;
  }
  await peerSync();
  setChatProcessStage(chatId, 0);
  return true;
}

function buildPromptInfo(room: character | groupChat): MessagePresetInfo {
  if (!settingsStore.state.promptInfoInsideChat) return {};
  const promptToggles = parseToggleSyntax(
    presetStore.state.customPromptTemplateToggle + getModuleToggles(room),
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

function getGroupOrder(room: groupChat, findCharacter: (id: string) => character) {
  const lastMessage = room.chats[room.chatPage].message.at(-1);
  return selectGroupGenerationOrder({
    candidates: room.characters.map((id, index) => ({
      id,
      name: findCharacter(id)?.name ?? "",
      talkness: room.characterActive[index] ? room.characterTalks[index] : -1,
      index,
    })),
    lastMessage: lastMessage?.data,
    lastSpeakerId: lastMessage?.saying,
    preserveOrder: room.orderByOrder,
  });
}

async function initializeGeneration(options: PrepareChatSessionOptions) {
  setChatProcessStage(options.targetChatId, 0);
  await applyPresetChain(options.chatProcessIndex);
  return synchronizePeer(options.throwError, options.targetChatId);
}

async function loadSelectedChat(options: PrepareChatSessionOptions) {
  settingsStore.state.statics.messages += 1;
  const selectedChar = options.targetCharacterId
    ? characterStore.characters.findIndex(
        (character) => character?.chaId === options.targetCharacterId,
      )
    : get(selectedCharID);
  options.errorContext.selectedChar = selectedChar;
  const nowChatroom = characterStore.characters[selectedChar];
  if (!nowChatroom) return null;

  characterStore.touchCharacterInteraction(selectedChar);
  const selectedChat = options.targetChatId
    ? nowChatroom.chats.findIndex((chat) => chat?.id === options.targetChatId)
    : nowChatroom.chatPage;
  if (selectedChat < 0 || !nowChatroom.chats[selectedChat]) return null;
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
  findCharacter: (id: string) => character,
) {
  for (const entry of getGroupOrder(room, findCharacter)) {
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
      result: await runGroupGeneration(
        options,
        room,
        calculatedChatTokens,
        findCharacter,
      ),
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
    presetStore.state.aiModel.startsWith("gpt") ? "noName" : "name",
  );
}

function buildReadySession(
  options: PrepareChatSessionOptions,
  selection: NonNullable<Awaited<ReturnType<typeof loadSelectedChat>>>,
  currentChar: character,
  calculatedChatTokens: number,
  findCharacter: (id: string) => character,
) {
  options.errorContext.currentChar = currentChar;
  const tokenizer = createTokenizer(
    options.chatAdditonalTokens ?? calculatedChatTokens,
  );
  const chatTarget = requireChatTargetFromIndexes(
    selection.selectedChar,
    selection.selectedChat,
  );
  const currentChat = runCurrentChatVariables(
    selection.nowChatroom.chats[selection.selectedChat],
    currentChar,
    chatTarget,
  );
  selection.nowChatroom.chats[selection.selectedChat] = currentChat;
  return {
    status: "ready" as const,
    ...selection,
    currentChar,
    currentChat,
    promptInfo: buildPromptInfo(selection.nowChatroom),
    tokenizer,
    maxContextTokens: presetStore.state.maxContext,
    findCharacter,
  };
}

export async function prepareChatSession(options: PrepareChatSessionOptions) {
  if (!(await initializeGeneration(options))) {
    return { status: "done" as const, result: false };
  }
  const selection = await loadSelectedChat(options);
  if (!selection) return { status: "done" as const, result: false };

  const calculatedChatTokens = presetStore.state.aiModel.startsWith("gpt") ? 5 : 3;
  const findCharacter = createCharacterLookup();
  const speaker = await resolveCurrentCharacter(
    options,
    selection.nowChatroom,
    calculatedChatTokens,
    findCharacter,
  );
  if (speaker.status === "done") return speaker;
  return buildReadySession(
    options,
    selection,
    speaker.currentChar,
    calculatedChatTokens,
    findCharacter,
  );
}
