import type { character, Chat } from "../storage/database/schema";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { pluginV2 } from "../plugins/plugins.svelte";
import { risuChatParser } from "./scripts";
import { runTrigger } from "./triggers";
import {
  requireChatTargetFromIndexes,
  type ChatExecutionTarget,
} from "../chatTarget";

export function findMessageIndexByChatId(chat: Chat, chatId?: string) {
  if (!chatId) return -1;
  return chat.message.findIndex((message) => message.chatId === chatId);
}

export async function runChatOutputListeners(
  char: character,
  chat: Chat,
  characterIndex: number,
  chatIndex: number,
  messageIndex: number,
) {
  if (pluginV2.chatOutput.size === 0) return;
  const charSnapshot = $state.snapshot(char);
  const chatSnapshot = $state.snapshot(chat);
  for (const listener of pluginV2.chatOutput) {
    try {
      await listener({
        char: charSnapshot,
        chat: chatSnapshot,
        characterIndex,
        chatIndex,
        messageIndex,
      });
    } catch (error) {
      console.error(error);
    }
  }
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

export async function applyOutputTrigger(
  currentChar: character,
  selectedChar: number,
  selectedChat: number,
) {
  const chatTarget = requireChatTargetFromIndexes(selectedChar, selectedChat);
  characterStore.characters[selectedChar].chats[selectedChat] =
    runCurrentChatVariables(
      characterStore.characters[selectedChar].chats[selectedChat],
      currentChar,
      chatTarget,
    );
  let currentChat = characterStore.characters[selectedChar].chats[selectedChat];
  const triggerResult = await runTrigger(currentChar, "output", {
    chat: currentChat,
    target: chatTarget,
  });
  if (triggerResult?.chat) currentChat = triggerResult.chat;
  characterStore.characters[selectedChar].chats[selectedChat] = currentChat;
  return {
    currentChat: characterStore.characters[selectedChar].chats[selectedChat],
    resendChat: !!triggerResult?.sendAIprompt,
  };
}
