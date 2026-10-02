import { v4 as uuidv4 } from "uuid";
import type { Chat, character, groupChat } from "../storage/database/schema";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { messageStore } from "../stores/domain/messageStore.svelte";
import { StoreCommitQueue } from "../stores/domain/storeCommitQueue";
import { getSqlStorage } from "../storage/sql/sqlStorageFactory";
import { commitSqlChanges } from "../storage/sql/sqlCommitCoordinator";
import {
  createEmptySqlCommit,
  hasSqlCommitChanges,
  sqlCharacterData,
  sqlChatData,
  sqlMessageData,
  type SqlCommit,
} from "../storage/sql/sqlCommit";
import { safeStructuredClone } from "../polyfill";

type PluginCharacter = character | groupChat;
const writes = new StoreCommitQueue();
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

async function loadCharacter(characterId: string): Promise<PluginCharacter> {
  if (characterStore.getById(characterId)?.detailsLoaded === false) {
    await characterStore.ensureCharacterDetails(characterId);
  }
  const current = characterStore.getById(characterId);
  if (!current || current.detailsLoaded === false) {
    throw new Error(`Cannot load complete character: ${characterId}`);
  }
  return current;
}

export async function getPluginCharacter(index: number) {
  const characterId = characterStore.characters[index]?.chaId;
  if (!characterId) return null;
  const current = await loadCharacter(characterId);
  const snapshot = characterStore.getCharacterByIndex(
    characterStore.characters.indexOf(current),
    { snapshot: true },
  )!;
  // Read one chat at a time, and keep complete histories only in the return value.
  for (let index = 0; index < snapshot.chats.length; index++) {
    snapshot.chats[index] = await characterStore.getFullChatSnapshot(
      snapshot.chats[index].id!,
    );
  }
  return snapshot;
}

export async function getPluginChat(characterIndex: number, chatIndex: number) {
  const characterId = characterStore.characters[characterIndex]?.chaId;
  if (!characterId) return null;
  const current = await loadCharacter(characterId);
  const chat = current.chats?.[chatIndex];
  return chat?.id ? characterStore.getFullChatSnapshot(chat.id) : null;
}

export async function getPluginCharacters(): Promise<PluginCharacter[]> {
  const ids = characterStore.characters.map((character) => character.chaId);
  const snapshots: PluginCharacter[] = [];
  for (const id of ids) {
    const index = characterStore.characters.findIndex(
      (character) => character.chaId === id,
    );
    const snapshot = await getPluginCharacter(index);
    if (!snapshot)
      throw new Error(`Character changed while reading plugin database: ${id}`);
    snapshots.push(snapshot);
  }
  return snapshots;
}

async function prepareChat(
  commit: SqlCommit,
  characterId: string,
  position: number,
  incoming: Chat,
  previous?: Chat,
): Promise<Chat> {
  incoming.id ||= previous?.id || uuidv4();
  const old = previous?.id
    ? await characterStore.getFullChatSnapshot(previous.id)
    : undefined;
  const partial =
    incoming.messagesLoaded === false || incoming.messagesFullyLoaded === false;
  const next =
    incoming.detailsLoaded === false ? { ...old, ...incoming } : incoming;
  if (incoming.detailsLoaded === false && old) {
    if (old.scriptstate || incoming.scriptstate) {
      next.scriptstate = { ...old.scriptstate, ...incoming.scriptstate };
    }
    if (old.GLGlobalVariables || incoming.GLGlobalVariables) {
      next.GLGlobalVariables = {
        ...old.GLGlobalVariables,
        ...incoming.GLGlobalVariables,
      };
    }
  }
  const usedIds = new Set<string>();
  const offset = partial ? (incoming.messageOffset ?? 0) : 0;
  for (const [index, message] of (incoming.message ?? []).entries()) {
    message.chatId ||= old?.message[offset + index]?.chatId || uuidv4();
    if (usedIds.has(message.chatId)) message.chatId = uuidv4();
    usedIds.add(message.chatId);
  }
  if (partial && old) {
    const updates = new Map(
      incoming.message.map((message) => [message.chatId, message]),
    );
    next.message = old.message.map(
      (message) => updates.get(message.chatId) ?? message,
    );
    const oldIds = new Set(old.message.map((message) => message.chatId));
    next.message.push(
      ...incoming.message.filter((message) => !oldIds.has(message.chatId)),
    );
  }
  next.message ??= [];
  next.detailsLoaded = true;
  next.messagesLoaded = true;
  next.messagesFullyLoaded = true;
  next.messageOffset = 0;
  next.messageTotal = next.message.length;
  const previousPosition = characterStore
    .getById(characterId)
    ?.chats.findIndex((chat) => chat.id === next.id);
  if (
    !old ||
    previousPosition !== position ||
    !same(sqlChatData(next), sqlChatData(old))
  ) {
    commit.chats.push({
      id: next.id!,
      characterId,
      position,
      data: sqlChatData(next),
    });
  }
  const oldMessages = new Map(
    old?.message.map((message, index) => [
      message.chatId,
      { message, index },
    ]) ?? [],
  );
  for (const [index, message] of next.message.entries()) {
    const previous = oldMessages.get(message.chatId);
    if (
      !previous ||
      previous.index !== index ||
      !same(sqlMessageData(message), sqlMessageData(previous.message))
    ) {
      commit.messages.push({
        id: message.chatId!,
        chatId: next.id!,
        position: index,
        data: sqlMessageData(message),
      });
    }
  }
  const ids = next.message.map((message) => message.chatId!);
  const oldIds = old?.message.map((message) => message.chatId!) ?? [];
  if (!same(ids, oldIds)) {
    commit.messageManifests.push({ chatId: next.id!, ids });
    const retained = new Set(ids);
    const removed = oldIds.filter((id) => !retained.has(id));
    if (removed.length)
      commit.messageDeletes!.push({ chatId: next.id!, ids: removed });
  }
  return next;
}

function keepResidentWindow(next: Chat, previous?: Chat): Chat {
  if (
    !previous ||
    (previous.messagesLoaded !== false &&
      previous.messagesFullyLoaded !== false)
  )
    return next;
  const total = next.message.length;
  if (previous.messagesLoaded === false) {
    return {
      ...next,
      message: [],
      messagesLoaded: false,
      messagesFullyLoaded: false,
      messageTotal: total,
    };
  }
  const count = previous.message.length;
  const atEnd =
    (previous.messageOffset ?? 0) + count >= (previous.messageTotal ?? 0);
  const offset = atEnd
    ? Math.max(0, total - count)
    : Math.min(previous.messageOffset ?? 0, total);
  const message = next.message.slice(offset, offset + count);
  return {
    ...next,
    message,
    messageOffset: offset,
    messageTotal: total,
    messagesFullyLoaded: message.length === total,
  };
}

async function flushExistingWrites() {
  await messageStore.flush();
  await characterStore.flush();
  if (characterStore.hasPendingWrites() || messageStore.hasPendingWrites()) {
    throw new Error(
      "Cannot replace plugin data while storage writes are pending",
    );
  }
}

async function prepareCharacter(
  commit: SqlCommit,
  position: number,
  incoming: PluginCharacter,
  current?: PluginCharacter,
): Promise<PluginCharacter> {
  const next: PluginCharacter =
    incoming.detailsLoaded === false && current
      ? Object.assign(safeStructuredClone(current), incoming, {
          chats: safeStructuredClone(current.chats),
        })
      : incoming;
  next.chaId = current?.chaId || next.chaId || uuidv4();
  next.detailsLoaded = true;
  if (
    !current ||
    characterStore.characters.indexOf(current) !== position ||
    !same(sqlCharacterData(next), sqlCharacterData(current))
  ) {
    commit.characters.push({
      id: next.chaId,
      position,
      data: sqlCharacterData(next),
    });
  }
  const previousChats = new Map(
    current?.chats.map((chat) => [chat.id, chat]) ?? [],
  );
  const residentChats: Chat[] = [];
  for (const [index, chat] of (next.chats ?? []).entries()) {
    const previous = previousChats.get(chat.id);
    const complete = await prepareChat(
      commit,
      next.chaId,
      index,
      chat,
      previous,
    );
    residentChats.push(keepResidentWindow(complete, previous));
  }
  const ids = (next.chats ?? []).map((chat) => chat.id!);
  const oldIds = current?.chats.map((chat) => chat.id!) ?? [];
  if (!same(ids, oldIds)) {
    commit.chatManifests.push({ characterId: next.chaId, ids });
    const retained = new Set(ids);
    commit.chatDeletes!.push(...oldIds.filter((id) => !retained.has(id)));
  }
  next.chats = residentChats;
  return next;
}

export function setPluginCharacter(
  index: number,
  value: PluginCharacter,
): Promise<void> {
  const characterId = characterStore.characters[index]?.chaId;
  if (!characterId) return Promise.resolve();
  const incoming = safeStructuredClone(value);
  return writes.enqueue(async () => {
    await flushExistingWrites();
    const current = await loadCharacter(characterId);
    const position = characterStore.characters.indexOf(current);
    const storage = await getSqlStorage();
    const commit = createEmptySqlCommit(
      storage.getRevision(),
      "plugin-character",
    );
    const next = await prepareCharacter(commit, position, incoming, current);
    if (hasSqlCommitChanges(commit)) await commitSqlChanges(storage, commit);
    characterStore.setCharacterByIndex(position, next);
  });
}

export function setPluginChat(
  characterIndex: number,
  chatIndex: number,
  value: Chat,
): Promise<void> {
  const current = characterStore.characters[characterIndex];
  const characterId = current?.chaId;
  const chatId = current?.chats?.[chatIndex]?.id;
  if (!characterId) return Promise.resolve();
  const incoming = safeStructuredClone(value);
  return writes.enqueue(async () => {
    await flushExistingWrites();
    const current = await loadCharacter(characterId);
    const position = chatId
      ? current.chats.findIndex((chat) => chat.id === chatId)
      : chatIndex;
    const previous = current.chats[position];
    if (!previous) return;
    incoming.id = previous.id!;
    const storage = await getSqlStorage();
    const commit = createEmptySqlCommit(storage.getRevision(), "plugin-chat");
    const next = await prepareChat(
      commit,
      characterId,
      position,
      incoming,
      previous,
    );
    if (hasSqlCommitChanges(commit)) await commitSqlChanges(storage, commit);
    current.chats[position] = keepResidentWindow(next, previous);
  });
}

export function replacePluginCharacters(
  values: PluginCharacter[],
): Promise<void> {
  const incoming = safeStructuredClone(values);
  return writes.enqueue(async () => {
    await flushExistingWrites();
    const storage = await getSqlStorage();
    const commit = createEmptySqlCommit(
      storage.getRevision(),
      "plugin-characters",
    );
    const nextCharacters: PluginCharacter[] = [];
    for (const [position, next] of incoming.entries()) {
      let current = next.chaId ? characterStore.getById(next.chaId) : undefined;
      if (current) {
        current = await loadCharacter(current.chaId);
      }
      nextCharacters.push(
        await prepareCharacter(commit, position, next, current),
      );
    }
    const ids = nextCharacters.map((character) => character.chaId);
    const oldIds = characterStore.characters.map(
      (character) => character.chaId,
    );
    if (!same(ids, oldIds)) {
      commit.characterIds = ids;
      const retained = new Set(ids);
      commit.characterDeletes = oldIds.filter((id) => !retained.has(id));
    }
    if (hasSqlCommitChanges(commit)) await commitSqlChanges(storage, commit);
    const selectedId = characterStore.currentCharacter?.chaId;
    characterStore.characters = nextCharacters;
    characterStore.select(
      nextCharacters.findIndex((character) => character.chaId === selectedId),
    );
  });
}
