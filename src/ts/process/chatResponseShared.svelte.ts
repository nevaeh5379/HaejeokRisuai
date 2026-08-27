import type { character, Chat } from "../storage/database.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { pluginV2 } from "../plugins/plugins.svelte";
import { risuChatParser } from "./scripts";
import { runTrigger } from "./triggers";

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
  chatTarget: { characterIndex: number; chatIndex: number },
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
  characterStore.characters[selectedChar].chats[selectedChat] =
    runCurrentChatVariables(
      characterStore.characters[selectedChar].chats[selectedChat],
      currentChar,
      { characterIndex: selectedChar, chatIndex: selectedChat },
    );
  let currentChat = characterStore.characters[selectedChar].chats[selectedChat];
  const triggerResult = await runTrigger(currentChar, "output", {
    chat: currentChat,
    target: { characterIndex: selectedChar, chatIndex: selectedChat },
  });
  if (triggerResult?.chat) currentChat = triggerResult.chat;
  characterStore.characters[selectedChar].chats[selectedChat] = currentChat;
  return {
    currentChat: characterStore.characters[selectedChar].chats[selectedChat],
    resendChat: !!triggerResult?.sendAIprompt,
  };
}
