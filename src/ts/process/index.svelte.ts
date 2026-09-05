import { get, writable } from "svelte/store";
import {
  beginChatGeneration,
  chatProcessStage,
  doingChat,
  endChatGeneration,
} from "./chatRuntimeState";
export { chatProcessStage, doingChat } from "./chatRuntimeState";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { selectedCharID } from "../stores.svelte";
import { createLocalChatExecutor } from "./chatLocalExecutor";
import { runWithPresetChainGenerationGate } from "./presetChainGenerationGate";
import type { ChatSendOptions } from "@risuai/chat-core/executor.cjs";
import {
  beginNativeChatRequest,
  endNativeChatRequest,
} from "../androidChatLifecycle";
import { ensureChatNotificationPermission } from "../chatNotifications";
import {
  beginNodeGenerationLifecycle,
  endNodeGenerationLifecycle,
  reportNodeGenerationFailure,
} from "./nodeGenerationLifecycle";

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
    ? characterStore.characters.find(
        (character) => character?.chaId === targetCharacterId,
      )
    : fallbackCharacter;
  const fallbackChat = targetCharacter?.chats?.[targetCharacter.chatPage ?? 0];
  const targetChatId = arg.targetChatId ?? fallbackChat?.id;
  const targetChat = targetChatId
    ? targetCharacter?.chats?.find((chat) => chat?.id === targetChatId)
    : fallbackChat;
  const locked =
    keepAlive && targetChatId ? beginChatGeneration(targetChatId) : false;
  if (keepAlive && targetChatId && !locked) return false;

  const previousCompactionGuard = targetChat?.preventMessageCompaction;
  if (keepAlive && targetChat) targetChat.preventMessageCompaction = true;
  const lifecycleId =
    locked && targetChatId
      ? await beginNodeGenerationLifecycle(targetChatId)
      : null;
  if (keepAlive) {
    // Ask while we are still inside the send gesture: browsers drop the
    // notification permission prompt once the tab is backgrounded, so
    // requesting at response time never shows the dialog.
    await ensureChatNotificationPermission();
    await beginNativeChatRequest();
  }
  const serializeForPresetChain =
    chatProcessIndex === -1 && Boolean(settingsStore.state.presetChain?.trim());
  try {
    return await runWithPresetChainGenerationGate(
      serializeForPresetChain,
      async () => {
        if (arg.signal?.aborted) return false;
        return localChatExecutor.execute(chatProcessIndex, {
          ...arg,
          targetCharacterId,
          targetChatId,
        });
      },
    );
  } catch (error) {
    reportNodeGenerationFailure(targetChatId, error);
    throw error;
  } finally {
    if (keepAlive && targetChat) {
      targetChat.preventMessageCompaction = previousCompactionGuard;
    }
    if (locked && targetChatId) endChatGeneration(targetChatId);
    if (targetChatId) {
      await endNodeGenerationLifecycle(
        targetChatId,
        lifecycleId,
        arg.signal?.aborted === true,
      );
    }
    if (keepAlive) await endNativeChatRequest();
  }
}
