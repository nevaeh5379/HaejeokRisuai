import { get, writable } from "svelte/store";
import {
  beginChatGeneration,
  chatProcessStage,
  doingChat,
  endChatGeneration,
} from "./chat/runtimeState";
export { chatProcessStage, doingChat } from "./chat/runtimeState";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { selectedCharID } from "../stores.svelte";
import { createLocalChatExecutor } from "./chat/localExecutor";
import { runWithPresetChainGenerationGate } from "./presetChainGenerationGate";
import type { ChatSendOptions } from "@risuai/chat-core/executor.cjs";
import {
  beginNativeChatRequest,
  boundedNativeCall,
  endNativeChatRequest,
  NATIVE_BRIDGE_TIMEOUT_MS,
} from "../android/androidChatLifecycle";
import { ensureChatNotificationPermission } from "../chatNotifications";
import { localGenerationController } from "./chat/generationCancellation";
import {
  beginNodeGenerationLifecycle,
  endNodeGenerationLifecycle,
  getActiveNodeGenerationLifecycleId,
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

  const controller = locked ? new AbortController() : null;
  const forwardAbort = () => controller?.abort();
  if (arg.signal?.aborted) forwardAbort();
  else arg.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (controller && targetChatId) {
    localGenerationController.register(targetChatId, {
      controller,
      lifecycleId: () => getActiveNodeGenerationLifecycleId(targetChatId),
    });
  }
  const signal = controller?.signal ?? arg.signal;
  const previousCompactionGuard = targetChat?.preventMessageCompaction;
  if (keepAlive && targetChat) targetChat.preventMessageCompaction = true;
  let lifecycleId: string | null = null;
  const serializeForPresetChain =
    chatProcessIndex === -1 && Boolean(settingsStore.state.presetChain?.trim());
  try {
    if (locked && targetChatId) {
      lifecycleId = await beginNodeGenerationLifecycle(targetChatId, signal);
    }
    if (keepAlive) {
      // Ask while we are still inside the send gesture: browsers drop the
      // notification permission prompt once the tab is backgrounded.
      // Both calls cross the native bridge; bound them so a vendor ROM hang
      // cannot leave the generation lock held forever.
      await boundedNativeCall(
        ensureChatNotificationPermission(),
        NATIVE_BRIDGE_TIMEOUT_MS,
      );
      await boundedNativeCall(
        beginNativeChatRequest(),
        NATIVE_BRIDGE_TIMEOUT_MS,
      );
    }
    const result = await runWithPresetChainGenerationGate(
      serializeForPresetChain,
      async () => {
        if (signal?.aborted) return false;
        return localChatExecutor.execute(chatProcessIndex, {
          ...arg,
          signal,
          targetCharacterId,
          targetChatId,
        });
      },
    );
    return signal?.aborted ? false : result;
  } catch (error) {
    reportNodeGenerationFailure(targetChatId, error);
    throw error;
  } finally {
    arg.signal?.removeEventListener("abort", forwardAbort);
    if (controller && targetChatId) {
      localGenerationController.unregister(targetChatId, controller);
    }
    if (keepAlive && targetChat) {
      targetChat.preventMessageCompaction = previousCompactionGuard;
    }
    if (locked && targetChatId) endChatGeneration(targetChatId);
    if (targetChatId) {
      await boundedNativeCall(
        endNodeGenerationLifecycle(
          targetChatId,
          lifecycleId,
          signal?.aborted === true,
        ),
        NATIVE_BRIDGE_TIMEOUT_MS,
      );
    }
    if (keepAlive) {
      await boundedNativeCall(endNativeChatRequest(), NATIVE_BRIDGE_TIMEOUT_MS);
    }
  }
}
