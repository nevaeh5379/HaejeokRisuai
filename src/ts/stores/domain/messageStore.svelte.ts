import type { Message, Chat } from "../../storage/database.svelte";
import { getSqlStorage } from "../../storage/sqlStorageFactory";
import { characterStore } from "./characterStore.svelte";
import { settingsStore } from "./settingsStore.svelte";
import { v4 as uuidv4 } from "uuid";
import { sqlMessageData } from "../../storage/sqlCommit";

/**
 * In-memory retention cap for a single active chat. Messages beyond the most
 * recent `ACTIVE_CHAT_MESSAGE_RETENTION` slice are evicted from RAM and marked
 * as paged-out (`messagesFullyLoaded = false`); they are transparently reloaded
 * from SQL storage via `loadOlderChatMessages` when scrolled into view.
 *
 * Low-spec mode scales the cap down when the cost of keeping thousands of
 * parsed message objects is the primary memory pressure point.
 */
const getActiveChatMessageRetention = () =>
  settingsStore.state.lowSpecMode ? 40 : 200;

function findChatAcrossCharacters(chatId: string): Chat | undefined {
  for (const char of characterStore.characters) {
    const chat = char.chats?.find((c) => c.id === chatId);
    if (chat) return chat;
  }
  return characterStore.currentChat?.id === chatId
    ? characterStore.currentChat
    : undefined;
}

class MessageStore {
  get currentMessages(): Message[] {
    return characterStore.currentChat?.message ?? [];
  }

  async persistNewChat(
    characterId: string,
    chatId: string,
    messages: Message[],
  ): Promise<void> {
    await this.persistNewChats(characterId, [{ chatId, messages }]);
  }

  async persistNewChats(
    characterId: string,
    chats: Array<{ chatId: string; messages: Message[] }>,
  ): Promise<void> {
    if (chats.length === 0) return;

    // Messages reference their parent chat through a foreign key in every SQL
    // backend. Persist all parent chat rows and the manifest before inserting
    // any child messages, avoiding the debounced CharacterStore race.
    for (const { chatId } of chats) {
      characterStore.markChatDirty(chatId);
    }
    characterStore.markChatManifestDirty(characterId);
    await characterStore.flush();

    const nonEmptyChats = chats.filter(({ messages }) => messages.length > 0);
    if (nonEmptyChats.length === 0) return;

    const storage = await getSqlStorage();
    const messageUpserts = nonEmptyChats.flatMap(({ chatId, messages }) =>
      messages.map((message, position) => {
        message.chatId ||= uuidv4();
        return {
          id: message.chatId,
          chatId,
          position,
          data: sqlMessageData(message),
        };
      }),
    );

    await storage.commit({
      baseRevision: storage.getRevision(),
      action: "chat-create-messages",
      root: { upserts: [], deletes: [] },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: messageUpserts,
      messageManifests: nonEmptyChats.map(({ chatId, messages }) => ({
        chatId,
        ids: messages.map((message) => message.chatId!).filter(Boolean),
      })),
    });
  }

  async appendMessage(chatId: string, message: Message): Promise<void> {
    message.chatId ||= uuidv4();
    const chat = findChatAcrossCharacters(chatId);
    if (chat) {
      chat.message ??= [];
      const existingIndex = chat.message.findIndex(
        (m) => m.chatId === message.chatId,
      );
      if (existingIndex >= 0) {
        chat.message[existingIndex] = message;
      } else {
        chat.message.push(message);
      }
    }
    try {
      const storage = await getSqlStorage();
      const messages = chat?.message ?? [message];
      const msgIndex = messages.findIndex((m) => m.chatId === message.chatId);
      const position =
        (chat?.messagesFullyLoaded === false ? (chat?.messageOffset ?? 0) : 0) +
        (msgIndex >= 0 ? msgIndex : messages.length - 1);
      await storage.commit({
        baseRevision: storage.getRevision(),
        action: "message",
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [
          {
            id: message.chatId,
            chatId,
            position,
            data: sqlMessageData(message),
          },
        ],
        messageManifests: [],
      });
    } catch (error) {
      console.error("[MessageStore] Failed to commit appendMessage:", error);
    }
  }

  async commitMessages(chatId: string, msgs: Message[]): Promise<void> {
    const chat = findChatAcrossCharacters(chatId);
    const allMessages = chat?.message ?? msgs;
    const baseOffset =
      chat?.messagesFullyLoaded === false ? (chat?.messageOffset ?? 0) : 0;

    const messageUpserts = msgs.map((m) => {
      m.chatId ||= uuidv4();
      const idx = allMessages.findIndex((item) => item.chatId === m.chatId);
      const position = baseOffset + (idx >= 0 ? idx : allMessages.length - 1);
      return {
        id: m.chatId,
        chatId,
        position,
        data: sqlMessageData(m),
      };
    });
    const isCompleteSnapshot =
      !!chat &&
      chat.messagesFullyLoaded !== false &&
      msgs.length === allMessages.length &&
      msgs.every((message, index) => message.chatId === allMessages[index]?.chatId);

    try {
      const storage = await getSqlStorage();
      await storage.commit({
        baseRevision: storage.getRevision(),
        action: "message",
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: messageUpserts,
        messageManifests: isCompleteSnapshot
          ? [
              {
                chatId,
                ids: allMessages.map((m) => m.chatId!).filter(Boolean),
              },
            ]
          : [],
      });
    } catch (error) {
      console.error("[MessageStore] Failed to commit messages:", error);
    }
  }

  async replaceMessages(
    chatId: string,
    nextMessages: Message[],
    previousMessages?: Message[],
  ): Promise<void> {
    const chat = findChatAcrossCharacters(chatId);
    const previous = previousMessages ?? chat?.message ?? [];
    for (const message of nextMessages) message.chatId ||= uuidv4();

    if (chat) {
      chat.message = nextMessages;
      chat.messagesLoaded = true;
      chat.messageOffset = 0;
      chat.messageTotal = nextMessages.length;
      chat.messagesFullyLoaded = true;
    }

    const nextIds = new Set(nextMessages.map((message) => message.chatId!));
    const removedIds = previous
      .map((message) => message.chatId)
      .filter((id): id is string => !!id && !nextIds.has(id));
    const messageUpserts = nextMessages.map((message, position) => ({
      id: message.chatId!,
      chatId,
      position,
      data: sqlMessageData(message),
    }));

    try {
      const storage = await getSqlStorage();
      await storage.commit({
        baseRevision: storage.getRevision(),
        action: "message-branch-switch",
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: messageUpserts,
        messageManifests: [{ chatId, ids: nextMessages.map((message) => message.chatId!) }],
        messageDeletes: removedIds.length > 0 ? [{ chatId, ids: removedIds }] : [],
      });
    } catch (error) {
      console.error("[MessageStore] Failed to replace messages:", error);
    }
  }

  async updateMessage(chatId: string, message: Message): Promise<void> {
    const chat = findChatAcrossCharacters(chatId);
    let position = 0;
    if (chat && chat.message) {
      const index = chat.message.findIndex((m) => m.chatId === message.chatId);
      if (index >= 0) {
        chat.message[index] = message;
        position =
          (chat.messagesFullyLoaded === false ? (chat.messageOffset ?? 0) : 0) +
          index;
      }
    }
    try {
      const storage = await getSqlStorage();
      await storage.commit({
        baseRevision: storage.getRevision(),
        action: "message",
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [
          {
            id: message.chatId!,
            chatId,
            position,
            data: sqlMessageData(message),
          },
        ],
        messageManifests: [],
      });
    } catch (error) {
      console.error("[MessageStore] Failed to commit updateMessage:", error);
    }
  }

  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const chat = findChatAcrossCharacters(chatId);
    if (chat && chat.message) {
      const beforeLen = chat.message.length;
      chat.message = chat.message.filter((m) => m.chatId !== messageId);
      const deletedCount = beforeLen - chat.message.length;
      if (deletedCount > 0 && typeof chat.messageTotal === "number") {
        chat.messageTotal = Math.max(0, chat.messageTotal - deletedCount);
      }
    }
    try {
      const storage = await getSqlStorage();
      await storage.commit({
        baseRevision: storage.getRevision(),
        action: "message-delete",
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [],
        messageManifests: [],
        messageDeletes: [
          {
            chatId,
            ids: [messageId],
          },
        ],
      });
    } catch (error) {
      console.error("[MessageStore] Failed to commit deleteMessage:", error);
    }
  }

  async deleteMessages(chatId: string, messageIds: string[]): Promise<void> {
    if (!messageIds || messageIds.length === 0) return;
    const idSet = new Set(messageIds);
    const chat = findChatAcrossCharacters(chatId);
    if (chat && chat.message) {
      const beforeLen = chat.message.length;
      chat.message = chat.message.filter(
        (m) => !m.chatId || !idSet.has(m.chatId),
      );
      const deletedCount = beforeLen - chat.message.length;
      if (deletedCount > 0 && typeof chat.messageTotal === "number") {
        chat.messageTotal = Math.max(0, chat.messageTotal - deletedCount);
      }
    }
    try {
      const storage = await getSqlStorage();
      await storage.commit({
        baseRevision: storage.getRevision(),
        action: "message-delete",
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [],
        messageManifests: [],
        messageDeletes: [
          {
            chatId,
            ids: messageIds,
          },
        ],
      });
    } catch (error) {
      console.error("[MessageStore] Failed to commit deleteMessages:", error);
    }
  }

  async finalizeStreaming(chatId: string, message: Message): Promise<void> {
    await this.appendMessage(chatId, message);
  }

  async loadOlderMessages(chatId: string, limit?: number): Promise<number> {
    return characterStore.loadOlderChatMessages(chatId, limit);
  }
}

export const messageStore = new MessageStore();

let inactiveReleaseGeneration = 0;

/** Cancel any idle eviction work from a previous character/chat transition. */
export function cancelInactiveChatMessageRelease(): void {
  inactiveReleaseGeneration += 1;
}

function evictInactiveChatMessages(chats: Chat[], activeChatId?: string): void {
  for (const chat of chats) {
    if (!chat.id || chat.id === activeChatId) continue;
    if (chat.preventMessageCompaction) continue;
    if (
      chat.message &&
      chat.message.length > 0 &&
      chat.messagesLoaded !== false
    ) {
      chat.message = [];
      chat.messagesLoaded = false;
      chat.messagesFullyLoaded = false;
    }
  }
}

/**
 * Evicts the message array of every chat except the active one (and any chat
 * flagged with `preventMessageCompaction`, e.g. while generation is running).
 *
 * Evicted chats are marked `messagesLoaded = false` so that the next access
 * transparently reloads them from SQL storage via `ensureChatMessages` /
 * `preLoadChat`. Because messages are persisted to the DB on every commit,
 * dropping the in-memory copy does not lose data.
 *
 * This is the single biggest memory win when a user has browsed through many
 * chats: without it, every chat ever visited keeps its full message array
 * live in the Svelte `$state` tree and cannot be garbage-collected.
 */
export function releaseInactiveChatMessages(activeChatId?: string): void {
  const generation = ++inactiveReleaseGeneration;
  const batchSize = settingsStore.state.lowSpecMode ? 4 : 32;

  const scheduleIdle = (callback: () => void) => {
    if ("requestIdleCallback" in globalThis) {
      globalThis.requestIdleCallback(callback);
    } else {
      globalThis.setTimeout(callback, 0);
    }
  };

  // Character selection should become paintable before we traverse and mutate
  // every previously visited chat. Even on fast devices, clearing many large
  // reactive arrays in the same task can turn into a visible GC/Svelte pause.
  scheduleIdle(() => {
    if (generation !== inactiveReleaseGeneration) return;
    const inactiveChats: Chat[] = [];
    for (const char of characterStore.characters) {
      if (!char.chats) continue;
      for (const chat of char.chats) {
        if (!chat.id || chat.id === activeChatId) continue;
        if (chat.preventMessageCompaction) continue;
        if (chat.messagesLoaded === false || !chat.message?.length) continue;
        inactiveChats.push(chat);
      }
    }

    let cursor = 0;
    const releaseBatch = () => {
      if (generation !== inactiveReleaseGeneration) return;
      const nextCursor = Math.min(cursor + batchSize, inactiveChats.length);
      evictInactiveChatMessages(
        inactiveChats.slice(cursor, nextCursor),
        activeChatId,
      );
      cursor = nextCursor;
      if (cursor < inactiveChats.length) scheduleIdle(releaseBatch);
    };
    releaseBatch();
  });
}

/**
 * Trims the message array of the active chat to the most recent retention cap,
 * converting the dropped prefix into a paged-out window. The removed messages
 * remain in SQL storage and are reloaded on demand via `loadOlderMessages`.
 *
 * No-op when the chat is still loading, not fully loaded, or guarded by
 * `preventMessageCompaction`.
 */
export function compactChatMessages(chatId: string): void {
  const chat = findChatAcrossCharacters(chatId);
  if (!chat || !chat.id) return;
  if (chat.preventMessageCompaction) return;
  if (chat.messagesFullyLoaded === false) return;
  const messages = chat.message;
  const retention = getActiveChatMessageRetention();
  if (!messages || messages.length <= retention) return;

  const dropCount = messages.length - retention;
  chat.message = messages.slice(dropCount);
  chat.messageOffset = (chat.messageOffset ?? 0) + dropCount;
  if (typeof chat.messageTotal === "number") {
    chat.messageTotal = Math.max(chat.messageTotal, messages.length);
  } else {
    chat.messageTotal = messages.length;
  }
  chat.messagesFullyLoaded = false;
  chat.messagesLoaded = true;
}

/**
 * Reserved hook for cancelling a pending compaction. The current synchronous
 * implementation has nothing to cancel, so this remains a no-op but is kept in
 * the public API so callers don't need conditional imports.
 */
export function cancelChatMessageCompaction(_chatId: string): void {}
