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

export function createChatErrorHandler(context: ChatErrorContext) {
  return (error: string) => {
    if (!settingsStore.state?.inlayErrorResponse) {
      alertError(error);
      return;
    }

    try {
      const selectedChar =
        context.selectedChar >= 0 ? context.selectedChar : get(selectedCharID);
      const charRoom = characterStore.characters?.[selectedChar];
      if (!charRoom) {
        alertError(error);
        return;
      }

      const selectedChat =
        context.selectedChat >= 0 ? context.selectedChat : charRoom.chatPage;
      const chatRoom = charRoom.chats?.[selectedChat];
      if (!chatRoom || !Array.isArray(chatRoom.message)) {
        alertError(error);
        return;
      }

      const messages = chatRoom.message;
      const lastMessage = messages.at(-1);
      const suffix = `\n\`\`\`risuerror\n${error}\n\`\`\``;
      if (lastMessage?.role === "char") {
        lastMessage.data += suffix;
        return;
      }

      const message: Message = {
        role: "char",
        data: `\`\`\`risuerror\n${error}\n\`\`\``,
        time: Date.now(),
      };
      if (context.currentChar?.chaId) {
        message.saying = context.currentChar.chaId;
      }
      if (context.generationInfo) {
        message.generationInfo = context.generationInfo;
      }
      messages.push(message);
    } catch (caught) {
      console.error(caught);
      alertError(error);
    }
  };
}
