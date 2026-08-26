import { get, writable } from "svelte/store";
import {
  beginChatGeneration,
  chatProcessStage,
  doingChat,
  endChatGeneration,
} from "./chatRuntimeState";
export { chatProcessStage, doingChat } from "./chatRuntimeState";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { selectedCharID } from "../stores.svelte";
import { createLocalChatExecutor } from "./chatLocalExecutor";
import type { ChatSendOptions } from "@risuai/chat-core/executor.cjs";
import {
  beginNativeChatRequest,
  endNativeChatRequest,
} from "../androidChatLifecycle";

export type { MultiModal, OpenAIChat } from "@risuai/chat-core/types.cjs";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";

export interface requestTokenPart {
  name: string;
  tokens: number;
}

export const abortChat = writable(false);
export let requestTokenParts: { [key: string]: requestTokenPart[] } = {};
export let previewFormated: OpenAIChat[] = [];
export let previewBody: string = "";

const localChatExecutor = createLocalChatExecutor({
  setPreviewFormated: (chats) => {
    previewFormated = chats;
  },
  setPreviewBody: (body) => {
    previewBody = body;
  },
});

export async function sendChat(
  chatProcessIndex = -1,
  arg: ChatSendOptions = {},
): Promise<boolean> {
  const keepAlive = !arg.preview && !arg.previewPrompt;
  const selectedIndex = get(selectedCharID);
  const fallbackCharacter = characterStore.characters[selectedIndex];
  const targetCharacterId = arg.targetCharacterId ?? fallbackCharacter?.chaId;
  const targetCharacter = targetCharacterId
    ? characterStore.characters.find((character) => character?.chaId === targetCharacterId)
    : fallbackCharacter;
  const fallbackChat = targetCharacter?.chats?.[targetCharacter.chatPage ?? 0];
  const targetChatId = arg.targetChatId ?? fallbackChat?.id;
  const targetChat = targetChatId
    ? targetCharacter?.chats?.find((chat) => chat?.id === targetChatId)
    : fallbackChat;
  const locked = keepAlive && targetChatId ? beginChatGeneration(targetChatId) : false;
  if (keepAlive && targetChatId && !locked) return false;

  const previousCompactionGuard = targetChat?.preventMessageCompaction;
  if (keepAlive && targetChat) targetChat.preventMessageCompaction = true;
  if (keepAlive) await beginNativeChatRequest();
  try {
    return await localChatExecutor.execute(chatProcessIndex, {
      ...arg,
      targetCharacterId,
      targetChatId,
    });
  } finally {
    if (keepAlive && targetChat) {
      targetChat.preventMessageCompaction = previousCompactionGuard;
    }
    if (locked && targetChatId) endChatGeneration(targetChatId);
    if (keepAlive) await endNativeChatRequest();
  }
}
