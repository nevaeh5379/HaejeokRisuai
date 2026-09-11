import { Sha256 } from "@aws-crypto/sha256-js";
import { encodeStorageSyncValue } from "@risuai/protocol/storageSyncValueCodec.cjs";
import type {
  ISqlStorage,
  SqlChatBranchGraphLink,
  SqlStorageSyncSummary,
} from "../sql/ISqlStorage";
import {
  sqlCharacterData,
  sqlChatData,
  sqlMessageData,
} from "../sql/sqlCommit";

export const STORAGE_SYNC_SQL_FORMAT_VERSION = 1 as const;
export const STORAGE_SYNC_SOURCE_PAGE_SIZE = 256;
export const STORAGE_SYNC_SOURCE_CHUNK_SIZE = 4 * 1024 * 1024;
const SETTING_BATCH_SIZE = 32;

export interface StorageSyncSqlSourcePlan {
  formatVersion: typeof STORAGE_SYNC_SQL_FORMAT_VERSION;
  size: number;
  recordCount: number;
  sha256: string;
  sourceRevision: number;
}
export type StorageSyncSqlRecord =
  | { type: "meta"; formatVersion: 1; revision: number }
  | { type: "setting"; key: string; value: unknown }
  | { type: "plugin-storage"; key: string; value: unknown }
  | { type: "module"; position: number; id: string; data: unknown }
  | { type: "preset"; position: number; id: string; data: unknown }
  | { type: "cold-storage"; key: string; value: unknown }
  | { type: "character"; position: number; id: string; data: unknown }
  | {
      type: "chat";
      characterId: string;
      position: number;
      id: string;
      data: unknown;
    }
  | { type: "branch"; chatId: string; data: unknown }
  | { type: "active-branch"; chatId: string; branchId: string }
  | {
      type: "message";
      chatId: string;
      id: string;
      position: number;
      parentMessageId?: string;
      originBranchId: string;
      data: unknown;
    };
export class StorageSyncSourceRevisionChangedError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Storage sync source changed from revision ${expectedRevision} to ${currentRevision}. Refresh the preview and retry.`,
    );
    this.name = "StorageSyncSourceRevisionChangedError";
  }
}

function assertCachedRevision(storage: ISqlStorage, expectedRevision: number) {
  const current = storage.getRevision();
  if (current !== expectedRevision) {
    throw new StorageSyncSourceRevisionChangedError(expectedRevision, current);
  }
}

async function assertAuthoritativeRevision(
  storage: ISqlStorage,
  expectedRevision: number,
): Promise<SqlStorageSyncSummary> {
  const summary = await storage.getStorageSyncSummary();
  const current = summary?.revision ?? storage.getRevision();
  if (!summary || current !== expectedRevision) {
    throw new StorageSyncSourceRevisionChangedError(expectedRevision, current);
  }
  return summary;
}
async function* iterateSettings(
  storage: ISqlStorage,
  expectedRevision: number,
): AsyncGenerator<StorageSyncSqlRecord> {
  if (!storage.listSettingKeys) {
    throw new Error("This SQL backend cannot enumerate persisted setting keys.");
  }
  const keys = [...new Set(await storage.listSettingKeys())].sort();
  for (let offset = 0; offset < keys.length; offset += SETTING_BATCH_SIZE) {
    assertCachedRevision(storage, expectedRevision);
    const batch = keys.slice(offset, offset + SETTING_BATCH_SIZE);
    if (storage.loadSettingKeys) {
      const values = await storage.loadSettingKeys(batch);
      for (const key of batch) {
        yield { type: "setting", key, value: values.get(key) };
      }
      continue;
    }
    for (const key of batch) {
      yield { type: "setting", key, value: await storage.loadSettingKey(key) };
    }
  }
}

async function* iteratePluginStorage(
  storage: ISqlStorage,
): AsyncGenerator<StorageSyncSqlRecord> {
  const keys = [...new Set(await storage.listPluginCustomStorageKeys())].sort();
  for (const key of keys) {
    yield { type: "plugin-storage", key, value: await storage.loadPluginCustomStorageKey(key) };
  }
}
async function* iterateModules(
  storage: ISqlStorage,
): AsyncGenerator<StorageSyncSqlRecord> {
  const modules = await storage.loadModules();
  for (let position = 0; position < modules.length; position++) {
    const module = modules[position];
    if (!module?.id) throw new Error("Storage sync encountered a module without an id.");
    yield { type: "module", position, id: module.id, data: module };
  }
}

async function* iteratePresets(
  storage: ISqlStorage,
): AsyncGenerator<StorageSyncSqlRecord> {
  const summaries = [...(await storage.listBotPresets())].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
  for (const summary of summaries) {
    const preset = await storage.loadBotPreset(summary.id);
    if (!preset) throw new Error(`Storage sync preset disappeared: ${summary.id}`);
    const { id: _id, ...data } = preset;
    yield { type: "preset", position: summary.position, id: summary.id, data };
  }
}

async function* iterateColdStorage(
  storage: ISqlStorage,
): AsyncGenerator<StorageSyncSqlRecord> {
  const { items } = await storage.listColdStorageItems();
  const keys = [...new Set(items)].sort();
  for (const key of keys) {
    yield { type: "cold-storage", key, value: await storage.getColdStorageItem(key) };
  }
}
function requireBranchPageLoader(storage: ISqlStorage) {
  if (!storage.loadChatBranchGraphPage) {
    throw new Error(
      "This SQL backend cannot page branch graph messages. Upgrade the storage implementation before syncing.",
    );
  }
  return storage.loadChatBranchGraphPage.bind(storage);
}

function linkByMessageId(links: SqlChatBranchGraphLink[]) {
  return new Map(links.map((link) => [link.messageId, link]));
}

async function* iterateChatGraph(
  storage: ISqlStorage,
  chatId: string,
  expectedRevision: number,
  pageSize: number,
): AsyncGenerator<StorageSyncSqlRecord> {
  const loadPage = requireBranchPageLoader(storage);
  let offset = 0;
  let emittedMetadata = false;
  while (true) {
    assertCachedRevision(storage, expectedRevision);
    const page = await loadPage(chatId, offset, pageSize);
    if (!emittedMetadata) {
      for (const branch of page.branches) {
        yield { type: "branch", chatId, data: branch };
      }
      if (page.activeBranchId) {
        yield { type: "active-branch", chatId, branchId: page.activeBranchId };
      }
      emittedMetadata = true;
    }
    if (page.offset !== offset || page.messages.length > pageSize || page.total < offset) {
      throw new Error(`Storage sync branch page is invalid for chat ${chatId}.`);
    }
    const links = linkByMessageId(page.links);
    for (let index = 0; index < page.messages.length; index++) {
      const message = page.messages[index];
      const id = message.chatId;
      if (!id) throw new Error(`Storage sync encountered a message without an id in chat ${chatId}.`);
      const link = links.get(id);
      if (!link) throw new Error(`Storage sync branch link is missing for message ${id}.`);
      if (!Number.isSafeInteger(link.position) || Number(link.position) < 0) {
        throw new Error(
          "The storage backend does not expose branch message positions required for lossless sync. Upgrade it before syncing.",
        );
      }
      yield {
        type: "message",
        chatId,
        id,
        position: Number(link.position),
        parentMessageId: link.parentMessageId,
        originBranchId: link.originBranchId,
        data: sqlMessageData(message),
      };
    }
    const nextOffset = page.offset + page.messages.length;
    if (!page.hasMore) break;
    if (nextOffset <= offset || nextOffset >= page.total) {
      throw new Error(`Storage sync branch paging did not advance for chat ${chatId}.`);
    }
    offset = nextOffset;
  }
}

async function* iterateEntities(
  storage: ISqlStorage,
  expectedRevision: number,
  pageSize: number,
): AsyncGenerator<StorageSyncSqlRecord> {
  const startup = await storage.loadStartupData();
  const characters = startup?.characters ?? [];
  for (let position = 0; position < characters.length; position++) {
    assertCachedRevision(storage, expectedRevision);
    const id = characters[position].chaId;
    if (!id) throw new Error("Storage sync encountered a character without an id.");
    const character = await storage.loadCharacter(id);
    if (!character) throw new Error(`Storage sync character disappeared: ${id}`);
    yield { type: "character", position, id, data: sqlCharacterData(character) };

    const chats = character.chats ?? [];
    for (let chatPosition = 0; chatPosition < chats.length; chatPosition++) {
      assertCachedRevision(storage, expectedRevision);
      const chatId = chats[chatPosition].id;
      if (!chatId) throw new Error(`Storage sync encountered a chat without an id for character ${id}.`);
      const chat = await storage.loadChat(chatId, { messageLimit: 1 });
      if (!chat) throw new Error(`Storage sync chat disappeared: ${chatId}`);
      yield {
        type: "chat",
        characterId: id,
        position: chatPosition,
        id: chatId,
        data: sqlChatData(chat),
      };
      yield* iterateChatGraph(storage, chatId, expectedRevision, pageSize);
    }
  }
}

export async function* iterateStorageSyncSqlRecords(
  storage: ISqlStorage,
  options: { expectedRevision: number; pageSize?: number },
): AsyncGenerator<StorageSyncSqlRecord> {
  const pageSize = Math.max(1, Math.min(500, Math.floor(options.pageSize ?? STORAGE_SYNC_SOURCE_PAGE_SIZE)));
  await assertAuthoritativeRevision(storage, options.expectedRevision);
  yield {
    type: "meta",
    formatVersion: STORAGE_SYNC_SQL_FORMAT_VERSION,
    revision: options.expectedRevision,
  };
  yield* iterateSettings(storage, options.expectedRevision);
  assertCachedRevision(storage, options.expectedRevision);
  yield* iteratePluginStorage(storage);
  assertCachedRevision(storage, options.expectedRevision);
  yield* iterateModules(storage);
  assertCachedRevision(storage, options.expectedRevision);
  yield* iteratePresets(storage);
  assertCachedRevision(storage, options.expectedRevision);
  yield* iterateColdStorage(storage);
  assertCachedRevision(storage, options.expectedRevision);
  yield* iterateEntities(storage, options.expectedRevision, pageSize);
  await assertAuthoritativeRevision(storage, options.expectedRevision);
}

const textEncoder = new TextEncoder();

export function encodeStorageSyncSqlRecord(record: StorageSyncSqlRecord): Uint8Array {
  const encoded = encodeStorageSyncValue(record);
  return textEncoder.encode(`${JSON.stringify(encoded)}\n`);
}

function bytesToHex(bytes: Uint8Array): string {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

export async function measureStorageSyncSqlSource(
  storage: ISqlStorage,
  options: { expectedRevision: number; pageSize?: number },
): Promise<StorageSyncSqlSourcePlan> {
  const hash = new Sha256();
  let size = 0;
  let recordCount = 0;
  for await (const record of iterateStorageSyncSqlRecords(storage, options)) {
    const bytes = encodeStorageSyncSqlRecord(record);
    hash.update(bytes);
    size += bytes.byteLength;
    recordCount++;
  }
  return {
    formatVersion: STORAGE_SYNC_SQL_FORMAT_VERSION,
    size,
    recordCount,
    sha256: bytesToHex(await hash.digest()),
    sourceRevision: options.expectedRevision,
  };
}

export async function* iterateStorageSyncSqlChunks(
  storage: ISqlStorage,
  options: {
    expectedRevision: number;
    pageSize?: number;
    chunkSize?: number;
  },
): AsyncGenerator<Uint8Array> {
  const chunkSize = Math.max(
    1,
    Math.min(STORAGE_SYNC_SOURCE_CHUNK_SIZE, Math.floor(options.chunkSize ?? STORAGE_SYNC_SOURCE_CHUNK_SIZE)),
  );
  let chunk = new Uint8Array(chunkSize);
  let used = 0;
  for await (const record of iterateStorageSyncSqlRecords(storage, options)) {
    let bytes = encodeStorageSyncSqlRecord(record);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const length = Math.min(chunkSize - used, bytes.byteLength - offset);
      chunk.set(bytes.subarray(offset, offset + length), used);
      used += length;
      offset += length;
      if (used === chunkSize) {
        yield chunk;
        chunk = new Uint8Array(chunkSize);
        used = 0;
      }
    }
    bytes = new Uint8Array(0);
  }
  if (used > 0) yield chunk.slice(0, used);
}
