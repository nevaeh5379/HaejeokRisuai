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

export interface ChatErrorContext {
  selectedChar: number;
  selectedChat: number;
  currentChar?: character;
  generationInfo?: MessageGenerationInfo;
}

function resolveErrorMessages(context: ChatErrorContext) {
  const selectedChar =
    context.selectedChar >= 0 ? context.selectedChar : get(selectedCharID);
  const charRoom = characterStore.characters?.[selectedChar];
  if (!charRoom) return null;

  const selectedChat =
    context.selectedChat >= 0 ? context.selectedChat : charRoom.chatPage;
  const chatRoom = charRoom.chats?.[selectedChat];
  if (!chatRoom || !Array.isArray(chatRoom.message)) return null;
  return chatRoom.message;
}

function appendInlayError(
  messages: Message[],
  error: string,
  context: ChatErrorContext,
) {
  const lastMessage = messages.at(-1);
  const block = `\`\`\`risuerror\n${error}\n\`\`\``;
  if (lastMessage?.role === "char") {
    lastMessage.data += `\n${block}`;
    return;
  }

  const message: Message = { role: "char", data: block, time: Date.now() };
  if (context.currentChar?.chaId) message.saying = context.currentChar.chaId;
  if (context.generationInfo) message.generationInfo = context.generationInfo;
  messages.push(message);
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
    appendInlayError(messages, error, context);
  } catch (caught) {
    console.error(caught);
    alertError(error);
  }
}

export function createChatErrorHandler(context: ChatErrorContext) {
  return (error: string) => handleChatError(context, error);
}
