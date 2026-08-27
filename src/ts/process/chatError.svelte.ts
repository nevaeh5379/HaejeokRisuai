import { get } from "svelte/store";
import type {
  character,
  Message,
  MessageGenerationInfo,
} from "../storage/database.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { selectedCharID } from "../stores.svelte";
import { alertError } from "../alert";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { reportNodeGenerationFailure } from "./nodeGenerationLifecycle";

export interface ChatErrorContext {
  selectedChar: number;
  selectedChat: number;
  targetChatId?: string;
  currentChar?: character;
  generationInfo?: MessageGenerationInfo;
}

function resolveErrorChat(context: ChatErrorContext) {
  if (context.targetChatId) {
    for (const character of characterStore.characters ?? []) {
      const target = character?.chats?.find(
        (chat) => chat?.id === context.targetChatId,
      );
      if (target) return target;
    }
  }
  const selectedChar =
    context.selectedChar >= 0 ? context.selectedChar : get(selectedCharID);
  const charRoom = characterStore.characters?.[selectedChar];
  if (!charRoom) return null;
  const selectedChat =
    context.selectedChat >= 0 ? context.selectedChat : charRoom.chatPage;
  return charRoom.chats?.[selectedChat] ?? null;
}

function resolveErrorMessages(context: ChatErrorContext) {
  const chatRoom = resolveErrorChat(context);
  if (!chatRoom || !Array.isArray(chatRoom.message)) return null;
  return chatRoom.message;
}

function appendInlayError(
  messages: Message[],
  error: string,
  context: ChatErrorContext,
): Message {
  const lastMessage = messages.at(-1);
  const block = `\`\`\`risuerror\n${error}\n\`\`\``;
  if (lastMessage?.role === "char") {
    lastMessage.data += `\n${block}`;
    return lastMessage;
  }

  const message: Message = { role: "char", data: block, time: Date.now() };
  if (context.currentChar?.chaId) message.saying = context.currentChar.chaId;
  if (context.generationInfo) message.generationInfo = context.generationInfo;
  messages.push(message);
  return message;
}

function handleChatError(context: ChatErrorContext, error: string) {
  if (!settingsStore.state?.inlayErrorResponse) {
    alertError(error);
    return;
  }

  try {
    const messages = resolveErrorMessages(context);
    if (!messages) {
      alertError(error);
      return;
    }
    const chatId = resolveErrorChat(context)?.id;
    const message = appendInlayError(messages, error, context);
    if (chatId) void messageStore.appendMessage(chatId, message);
  } catch (caught) {
    console.error(caught);
    alertError(error);
  }
}

export function createChatErrorHandler(context: ChatErrorContext) {
  return (error: string) => {
    reportNodeGenerationFailure(resolveErrorChat(context)?.id, error);
    handleChatError(context, error);
  };
}
