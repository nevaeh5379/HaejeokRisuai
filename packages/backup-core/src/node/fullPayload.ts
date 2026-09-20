import { randomUUID } from "node:crypto";
import settings from "../../../protocol/settings.json";

const LEGACY_PERSONA_MIRROR_KEY_SET = new Set<string>(
  settings.LEGACY_PERSONA_MIRROR_KEYS,
);

export interface FullBackupPayloadOptions {
  idFactory?: () => string;
}

export function buildFullBackupPayload(
  database: Record<string, any>,
  options: FullBackupPayloadOptions = {},
) {
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw new TypeError("buildFullBackupPayload requires a database object");
  }

  const idFactory = options.idFactory ?? randomUUID;
  const rootUpserts: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(database)) {
    if (
      key === "characters" ||
      value === undefined ||
      value === null ||
      LEGACY_PERSONA_MIRROR_KEY_SET.has(key)
    ) {
      continue;
    }
    rootUpserts.push({ key, value });
  }

  const characters: any[] = [];
  const characterIds: string[] = [];
  const chats: any[] = [];
  const chatManifests: any[] = [];
  const messages: any[] = [];
  const messageManifests: any[] = [];
  const sourceCharacters = Array.isArray(database.characters)
    ? database.characters
    : [];

  for (
    let characterPosition = 0;
    characterPosition < sourceCharacters.length;
    characterPosition++
  ) {
    const character = sourceCharacters[characterPosition];
    const characterId = character.chaId || idFactory();
    character.chaId = characterId;
    characterIds.push(characterId);

    const {
      chats: _chats,
      chaId: _chaId,
      detailsLoaded: _detailsLoaded,
      ...characterData
    } = character;
    characters.push({
      id: characterId,
      position: characterPosition,
      data: characterData,
    });

    const sourceChats = Array.isArray(character.chats) ? character.chats : [];
    const chatIds: string[] = [];
    for (
      let chatPosition = 0;
      chatPosition < sourceChats.length;
      chatPosition++
    ) {
      const chat = sourceChats[chatPosition];
      const chatId = chat.id || idFactory();
      chat.id = chatId;
      chatIds.push(chatId);

      const {
        message: _message,
        id: _id,
        messagesLoaded: _messagesLoaded,
        detailsLoaded: _chatDetailsLoaded,
        ...chatData
      } = chat;
      chats.push({
        id: chatId,
        characterId,
        position: chatPosition,
        data: chatData,
      });

      const messageIds: string[] = [];
      if (chat.messagesLoaded !== false) {
        const sourceMessages = Array.isArray(chat.message) ? chat.message : [];
        for (
          let messagePosition = 0;
          messagePosition < sourceMessages.length;
          messagePosition++
        ) {
          const message = sourceMessages[messagePosition];
          const messageId = message.chatId || idFactory();
          message.chatId = messageId;
          messageIds.push(messageId);

          const { chatId: _messageId, ...messageData } = message;
          messages.push({
            id: messageId,
            chatId,
            position: messagePosition,
            data: messageData,
          });
        }
      }
      messageManifests.push({ chatId, ids: messageIds });
    }
    chatManifests.push({ characterId, ids: chatIds });
  }

  return {
    replaceAll: true,
    baseRevision: 0,
    root: { upserts: rootUpserts, deletes: [] as string[] },
    characters,
    characterIds,
    chats,
    chatManifests,
    messages,
    messageManifests,
  };
}
