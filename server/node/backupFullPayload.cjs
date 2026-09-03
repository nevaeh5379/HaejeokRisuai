"use strict";

const crypto = require("crypto");
const {
  LEGACY_PERSONA_MIRROR_KEYS,
} = require("../../packages/protocol/settings.json");

const LEGACY_PERSONA_MIRROR_KEY_SET = new Set(LEGACY_PERSONA_MIRROR_KEYS);

/**
 * 전체(loaded) database 객체에서 백업용 full sync payload를 구성한다.
 * SQL commit/replace payload와 동일한 정규화 형태를
 * 유지하며, replaceAll: true로 백업 DB 전체를 덮어쓴다.
 * baseRevision은 0으로 반환되며, 호출자가 실행 시점의 백업 revision으로 교체한다.
 */
function buildFullBackupPayload(database) {
  if (!database || typeof database !== "object" || Array.isArray(database)) {
    throw new TypeError("buildFullBackupPayload requires a database object");
  }
  const rootUpserts = [];
  for (const [key, value] of Object.entries(database)) {
    if (
      key === "characters" ||
      value === undefined ||
      value === null ||
      LEGACY_PERSONA_MIRROR_KEY_SET.has(key)
    )
      continue;
    rootUpserts.push({ key, value });
  }
  const characters = [];
  const characterIds = [];
  const chats = [];
  const chatManifests = [];
  const messages = [];
  const messageManifests = [];
  const sourceCharacters = Array.isArray(database.characters)
    ? database.characters
    : [];
  for (
    let characterPosition = 0;
    characterPosition < sourceCharacters.length;
    characterPosition++
  ) {
    const character = sourceCharacters[characterPosition];
    const characterId = character.chaId || crypto.randomUUID();
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
    const chatIds = [];
    for (
      let chatPosition = 0;
      chatPosition < sourceChats.length;
      chatPosition++
    ) {
      const chat = sourceChats[chatPosition];
      const chatId = chat.id || crypto.randomUUID();
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
      const messageIds = [];
      if (chat.messagesLoaded !== false) {
        const sourceMessages = Array.isArray(chat.message) ? chat.message : [];
        for (
          let messagePosition = 0;
          messagePosition < sourceMessages.length;
          messagePosition++
        ) {
          const message = sourceMessages[messagePosition];
          const messageId = message.chatId || crypto.randomUUID();
          message.chatId = messageId;
          messageIds.push(messageId);
          const { chatId: _messageId, ...messageData } = message;
          messages.push({
            id: messageId,
            chatId: chatId,
            position: messagePosition,
            data: messageData,
          });
        }
      }
      messageManifests.push({ chatId: chatId, ids: messageIds });
    }
    chatManifests.push({ characterId, ids: chatIds });
  }
  return {
    replaceAll: true,
    baseRevision: 0,
    root: { upserts: rootUpserts, deletes: [] },
    characters,
    characterIds,
    chats,
    chatManifests,
    messages,
    messageManifests,
  };
}

module.exports = {
  buildFullBackupPayload,
};
