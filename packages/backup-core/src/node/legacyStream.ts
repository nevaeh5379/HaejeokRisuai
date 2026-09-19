import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  promises as fs,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import { createUnzip } from "node:zlib";
import { Unpackr } from "msgpackr";
import settings from "../../../protocol/settings.json";
import type { LegacyBackupSqlRecord } from "../legacyRecords";
import {
  LEGACY_COMPRESSED_DATABASE_HEADER_BYTES,
  LEGACY_RAW_DATABASE_HEADER_BYTES,
  LEGACY_STREAM_COMPRESSED_DATABASE_HEADER_BYTES,
} from "../legacyHeaders";

const RAW_HEADER = Buffer.from(LEGACY_RAW_DATABASE_HEADER_BYTES);
const COMPRESSED_HEADER = Buffer.from(LEGACY_COMPRESSED_DATABASE_HEADER_BYTES);
const STREAM_COMPRESSED_HEADER = Buffer.from(
  LEGACY_STREAM_COMPRESSED_DATABASE_HEADER_BYTES,
);

const LEGACY_PERSONA_MIRROR_KEYS = new Set<string>(
  settings.LEGACY_PERSONA_MIRROR_KEYS,
);
const unpackr = new Unpackr({ int64AsType: "number", useRecords: false });

export class LegacyBackupStreamingUnsupportedError extends Error {
  constructor(
    message: string,
    readonly code:
      | "unsupported_legacy_format"
      | "portable_branch_graphs_present" = "unsupported_legacy_format",
  ) {
    super(message);
    this.name = "LegacyBackupStreamingUnsupportedError";
  }
}

export interface StreamLegacyBackupOptions {
  outputPath: string;
  encodeRecord: (record: LegacyBackupSqlRecord) => unknown;
  idFactory: () => string;
  sourceRevision?: number;
  onProgress?: (progress: {
    records: number;
    phase: "reading" | "characters" | "chats" | "messages" | "finalizing";
  }) => void;
}

export interface StreamLegacyBackupResult {
  sourceRevision: number;
  recordCount: number;
  outputPath: string;
}

type ByteSink = (bytes: Uint8Array) => Promise<void>;

class AsyncByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private current: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private offset = 0;
  private done = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  private async ensureChunk(): Promise<boolean> {
    while (this.offset >= this.current.length && !this.done) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        this.current = new Uint8Array();
        this.offset = 0;
        return false;
      }
      const value = next.value;
      this.current =
        value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      this.offset = 0;
      if (this.current.length > 0) return true;
    }
    return this.offset < this.current.length;
  }

  async readByte(): Promise<number> {
    if (!(await this.ensureChunk())) {
      throw new Error("Unexpected end of MessagePack stream");
    }
    return this.current[this.offset++];
  }

  async readExact(length: number): Promise<Uint8Array> {
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError("Invalid MessagePack read length");
    }
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (!(await this.ensureChunk())) {
        throw new Error("Unexpected end of MessagePack stream");
      }
      const available = Math.min(
        length - written,
        this.current.length - this.offset,
      );
      result.set(
        this.current.subarray(this.offset, this.offset + available),
        written,
      );
      this.offset += available;
      written += available;
    }
    return result;
  }

  async copyExact(length: number, sink: ByteSink): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (!(await this.ensureChunk())) {
        throw new Error("Unexpected end of MessagePack stream");
      }
      const available = Math.min(
        remaining,
        this.current.length - this.offset,
      );
      await sink(this.current.subarray(this.offset, this.offset + available));
      this.offset += available;
      remaining -= available;
    }
  }

  async hasMore(): Promise<boolean> {
    return await this.ensureChunk();
  }
}

function uint16(bytes: Uint8Array): number {
  return (bytes[0] << 8) | bytes[1];
}

function uint32(bytes: Uint8Array): number {
  return (
    bytes[0] * 0x1000000 +
    (bytes[1] << 16) +
    (bytes[2] << 8) +
    bytes[3]
  );
}

async function writeToStream(
  stream: WriteStream,
  bytes: Uint8Array | string,
): Promise<void> {
  if (!stream.write(bytes)) await once(stream, "drain");
}

async function consumeValue(
  reader: AsyncByteReader,
  sink: ByteSink,
): Promise<void> {
  const prefix = await reader.readByte();
  await sink(Uint8Array.of(prefix));

  if (prefix <= 0x7f || prefix >= 0xe0 || prefix === 0xc0 ||
      prefix === 0xc2 || prefix === 0xc3) {
    return;
  }
  if (prefix >= 0xa0 && prefix <= 0xbf) {
    await reader.copyExact(prefix & 0x1f, sink);
    return;
  }

  let count = 0;
  if (prefix >= 0x90 && prefix <= 0x9f) {
    count = prefix & 0x0f;
    for (let i = 0; i < count; i++) await consumeValue(reader, sink);
    return;
  }
  if (prefix >= 0x80 && prefix <= 0x8f) {
    count = prefix & 0x0f;
    for (let i = 0; i < count * 2; i++) await consumeValue(reader, sink);
    return;
  }

  switch (prefix) {
    case 0xc1:
      throw new Error("Invalid reserved MessagePack prefix 0xc1");
    case 0xc4: {
      const header = await reader.readExact(1);
      await sink(header);
      await reader.copyExact(header[0], sink);
      return;
    }
    case 0xc5: {
      const header = await reader.readExact(2);
      await sink(header);
      await reader.copyExact(uint16(header), sink);
      return;
    }
    case 0xc6: {
      const header = await reader.readExact(4);
      await sink(header);
      await reader.copyExact(uint32(header), sink);
      return;
    }
    case 0xc7: {
      const header = await reader.readExact(2);
      await sink(header);
      await reader.copyExact(header[0], sink);
      return;
    }
    case 0xc8: {
      const header = await reader.readExact(3);
      await sink(header);
      await reader.copyExact(uint16(header.subarray(0, 2)), sink);
      return;
    }
    case 0xc9: {
      const header = await reader.readExact(5);
      await sink(header);
      await reader.copyExact(uint32(header.subarray(0, 4)), sink);
      return;
    }
    case 0xca:
      await reader.copyExact(4, sink);
      return;
    case 0xcb:
      await reader.copyExact(8, sink);
      return;
    case 0xcc:
    case 0xd0:
      await reader.copyExact(1, sink);
      return;
    case 0xcd:
    case 0xd1:
      await reader.copyExact(2, sink);
      return;
    case 0xce:
    case 0xd2:
      await reader.copyExact(4, sink);
      return;
    case 0xcf:
    case 0xd3:
      await reader.copyExact(8, sink);
      return;
    case 0xd4:
      await reader.copyExact(2, sink);
      return;
    case 0xd5:
      await reader.copyExact(3, sink);
      return;
    case 0xd6:
      await reader.copyExact(5, sink);
      return;
    case 0xd7:
      await reader.copyExact(9, sink);
      return;
    case 0xd8:
      await reader.copyExact(17, sink);
      return;
    case 0xd9: {
      const header = await reader.readExact(1);
      await sink(header);
      await reader.copyExact(header[0], sink);
      return;
    }
    case 0xda: {
      const header = await reader.readExact(2);
      await sink(header);
      await reader.copyExact(uint16(header), sink);
      return;
    }
    case 0xdb: {
      const header = await reader.readExact(4);
      await sink(header);
      await reader.copyExact(uint32(header), sink);
      return;
    }
    case 0xdc: {
      const header = await reader.readExact(2);
      await sink(header);
      count = uint16(header);
      for (let i = 0; i < count; i++) await consumeValue(reader, sink);
      return;
    }
    case 0xdd: {
      const header = await reader.readExact(4);
      await sink(header);
      count = uint32(header);
      for (let i = 0; i < count; i++) await consumeValue(reader, sink);
      return;
    }
    case 0xde: {
      const header = await reader.readExact(2);
      await sink(header);
      count = uint16(header);
      for (let i = 0; i < count * 2; i++) await consumeValue(reader, sink);
      return;
    }
    case 0xdf: {
      const header = await reader.readExact(4);
      await sink(header);
      count = uint32(header);
      for (let i = 0; i < count * 2; i++) await consumeValue(reader, sink);
      return;
    }
    default:
      throw new Error(
        `Unsupported MessagePack prefix 0x${prefix.toString(16)}`,
      );
  }
}

async function readValueBytes(reader: AsyncByteReader): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  await consumeValue(reader, async (bytes) => {
    const copy = bytes.slice();
    chunks.push(copy);
    total += copy.length;
  });
  if (chunks.length === 1) return chunks[0];
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function decodeValue(reader: AsyncByteReader): Promise<any> {
  return unpackr.decode(await readValueBytes(reader));
}

async function readContainerCount(
  reader: AsyncByteReader,
  kind: "array" | "map",
): Promise<number> {
  const prefix = await reader.readByte();
  if (kind === "array") {
    if (prefix >= 0x90 && prefix <= 0x9f) return prefix & 0x0f;
    if (prefix === 0xdc) return uint16(await reader.readExact(2));
    if (prefix === 0xdd) return uint32(await reader.readExact(4));
  } else {
    if (prefix >= 0x80 && prefix <= 0x8f) return prefix & 0x0f;
    if (prefix === 0xde) return uint16(await reader.readExact(2));
    if (prefix === 0xdf) return uint32(await reader.readExact(4));
  }
  throw new Error(
    `Expected MessagePack ${kind}, got 0x${prefix.toString(16)}`,
  );
}

async function readString(reader: AsyncByteReader): Promise<string> {
  const value = await decodeValue(reader);
  if (typeof value !== "string") {
    throw new Error("Expected a MessagePack string key");
  }
  return value;
}

async function copyValueToFile(
  reader: AsyncByteReader,
  filePath: string,
): Promise<void> {
  const output = createWriteStream(filePath, { flags: "wx", mode: 0o600 });
  const done = new Promise<void>((resolveDone, rejectDone) => {
    output.once("finish", resolveDone);
    output.once("error", rejectDone);
  });
  try {
    await consumeValue(reader, async (bytes) => {
      await writeToStream(output, bytes);
    });
    output.end();
    await done;
  } catch (error) {
    output.destroy();
    await fs.rm(filePath, { force: true }).catch(() => {});
    throw error;
  }
}

function messageData(message: Record<string, any>): Record<string, any> {
  const { chatId: _messageId, ...data } = message;
  return data;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

class RecordTierWriter {
  private readonly rootPath: string;
  private readonly characterPath: string;
  private readonly chatPath: string;
  private readonly messagePath: string;
  private readonly root: WriteStream;
  private readonly characters: WriteStream;
  private readonly chats: WriteStream;
  private readonly messages: WriteStream;
  private readonly done: Promise<void>[];
  recordCount = 0;

  constructor(
    private readonly directory: string,
    private readonly outputPath: string,
    private readonly encodeRecord: (record: LegacyBackupSqlRecord) => unknown,
  ) {
    this.rootPath = join(directory, "legacy-root.ndjson");
    this.characterPath = join(directory, "legacy-characters.ndjson");
    this.chatPath = join(directory, "legacy-chats.ndjson");
    this.messagePath = join(directory, "legacy-messages.ndjson");
    this.root = createWriteStream(this.rootPath, { flags: "wx", mode: 0o600 });
    this.characters = createWriteStream(this.characterPath, {
      flags: "wx",
      mode: 0o600,
    });
    this.chats = createWriteStream(this.chatPath, { flags: "wx", mode: 0o600 });
    this.messages = createWriteStream(this.messagePath, {
      flags: "wx",
      mode: 0o600,
    });
    this.done = [this.root, this.characters, this.chats, this.messages].map(
      (stream) =>
        new Promise<void>((resolveDone, rejectDone) => {
          stream.once("finish", resolveDone);
          stream.once("close", resolveDone);
          stream.once("error", rejectDone);
        }),
    );
  }

  private streamFor(tier: "root" | "character" | "chat" | "message"): WriteStream {
    switch (tier) {
      case "root":
        return this.root;
      case "character":
        return this.characters;
      case "chat":
        return this.chats;
      case "message":
        return this.messages;
    }
  }

  encode(record: LegacyBackupSqlRecord): unknown {
    return this.encodeRecord(record);
  }

  async write(
    tier: "root" | "character" | "chat" | "message",
    record: LegacyBackupSqlRecord,
  ): Promise<void> {
    const line = `${JSON.stringify(this.encode(record))}\n`;
    await writeToStream(this.streamFor(tier), line);
    this.recordCount++;
  }

  async appendRawMessageFile(path: string): Promise<void> {
    for await (const chunk of createReadStream(path)) {
      await writeToStream(this.messages, chunk);
    }
  }

  async closeAndMerge(): Promise<void> {
    this.root.end();
    this.characters.end();
    this.chats.end();
    this.messages.end();
    await Promise.all(this.done);

    const output = createWriteStream(this.outputPath, {
      flags: "wx",
      mode: 0o600,
    });
    const outputDone = new Promise<void>((resolveDone, rejectDone) => {
      output.once("finish", resolveDone);
      output.once("error", rejectDone);
    });
    try {
      for (const path of [
        this.rootPath,
        this.characterPath,
        this.chatPath,
        this.messagePath,
      ]) {
        for await (const chunk of createReadStream(path)) {
          await writeToStream(output, chunk);
        }
      }
      output.end();
      await outputDone;
    } catch (error) {
      output.destroy();
      await fs.rm(this.outputPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    for (const stream of [this.root, this.characters, this.chats, this.messages]) {
      if (!stream.destroyed) stream.destroy();
    }
    await Promise.allSettled(this.done);
    await Promise.all(
      [
        this.rootPath,
        this.characterPath,
        this.chatPath,
        this.messagePath,
      ].map((path) => fs.rm(path, { force: true }).catch(() => {})),
    );
  }
}

async function createMessagePackSource(
  filePath: string,
): Promise<AsyncIterable<Uint8Array>> {
  const handle = await fs.open(filePath, "r");
  const header = Buffer.alloc(COMPRESSED_HEADER.length);
  try {
    const { bytesRead } = await handle.read(
      header,
      0,
      header.length,
      0,
    );
    if (bytesRead < header.length) {
      throw new LegacyBackupStreamingUnsupportedError(
        "Legacy backup database is too short",
      );
    }
  } finally {
    await handle.close();
  }

  if (header.equals(COMPRESSED_HEADER) || header.equals(STREAM_COMPRESSED_HEADER)) {
    return createReadStream(filePath, {
      start: COMPRESSED_HEADER.length,
      highWaterMark: 256 * 1024,
    }).pipe(createUnzip());
  }
  if (header.equals(RAW_HEADER)) {
    return createReadStream(filePath, {
      start: RAW_HEADER.length,
      highWaterMark: 256 * 1024,
    });
  }
  throw new LegacyBackupStreamingUnsupportedError(
    "Legacy backup database format requires the compatibility decoder",
  );
}

interface ParseContext {
  directory: string;
  tiers: RecordTierWriter;
  idFactory: () => string;
  onProgress?: StreamLegacyBackupOptions["onProgress"];
  characterCount: number;
  chatCount: number;
  messageCount: number;
}

async function parseMessagesFile(
  filePath: string,
  chatId: string,
  context: ParseContext,
): Promise<void> {
  const reader = new AsyncByteReader(createReadStream(filePath));
  const count = await readContainerCount(reader, "array");
  const tempPath = join(
    context.directory,
    `legacy-chat-${context.chatCount}-messages.ndjson`,
  );
  const temp = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
  const tempDone = new Promise<void>((resolveDone, rejectDone) => {
    temp.once("finish", resolveDone);
    temp.once("error", rejectDone);
  });
  const seen = new Set<string>();
  const ids: string[] = [];

  try {
    for (let position = 0; position < count; position++) {
      const message = await decodeValue(reader);
      if (!message || typeof message !== "object" || Array.isArray(message)) {
        throw new Error("Legacy chat message must be an object");
      }
      let id = validId(message.chatId) ? message.chatId : context.idFactory();
      while (seen.has(id)) id = context.idFactory();
      seen.add(id);
      ids.push(id);

      const record: LegacyBackupSqlRecord = {
        type: "message",
        chatId,
        id,
        position,
        ...(position > 0 ? { parentMessageId: ids[position - 1] } : {}),
        originBranchId: "root",
        data: messageData(message),
      };
      await writeToStream(
        temp,
        `${JSON.stringify(context.tiers.encode(record))}\n`,
      );
      context.messageCount++;
      if (context.messageCount % 128 === 0) {
        context.onProgress?.({
          records: context.tiers.recordCount + context.messageCount,
          phase: "messages",
        });
      }
    }
    if (await reader.hasMore()) {
      throw new Error("Legacy message array contains trailing data");
    }
    temp.end();
    await tempDone;

    await context.tiers.write("message", {
      type: "branch",
      chatId,
      data: {
        id: "root",
        chatId,
        reason: "root",
        createdAt: 0,
        ...(ids.length > 0 ? { headMessageId: ids[ids.length - 1] } : {}),
      },
    });
    await context.tiers.write("message", {
      type: "active-branch",
      chatId,
      branchId: "root",
    });
    await context.tiers.appendRawMessageFile(tempPath);
    context.tiers.recordCount += count;
  } finally {
    if (!temp.destroyed) temp.destroy();
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function parseChat(
  reader: AsyncByteReader,
  characterId: string,
  position: number,
  context: ParseContext,
): Promise<void> {
  const fields = await readContainerCount(reader, "map");
  const data: Record<string, any> = {};
  let chatId: string | null = null;
  let messagesPath: string | null = null;

  for (let i = 0; i < fields; i++) {
    const key = await readString(reader);
    if (key === "message") {
      messagesPath = join(
        context.directory,
        `legacy-chat-${context.chatCount}-messages.msgpack`,
      );
      await copyValueToFile(reader, messagesPath);
      continue;
    }
    const value = await decodeValue(reader);
    if (key === "id") {
      if (validId(value)) chatId = value;
      continue;
    }
    if (
      key === "messagesLoaded" ||
      key === "messagesFullyLoaded" ||
      key === "detailsLoaded"
    ) {
      continue;
    }
    data[key] = value;
  }

  chatId ??= context.idFactory();
  await context.tiers.write("chat", {
    type: "chat",
    characterId,
    position,
    id: chatId,
    data,
  });
  context.chatCount++;

  if (messagesPath) {
    try {
      await parseMessagesFile(messagesPath, chatId, context);
    } finally {
      await fs.rm(messagesPath, { force: true }).catch(() => {});
    }
  } else {
    await context.tiers.write("message", {
      type: "branch",
      chatId,
      data: {
        id: "root",
        chatId,
        reason: "root",
        createdAt: 0,
      },
    });
    await context.tiers.write("message", {
      type: "active-branch",
      chatId,
      branchId: "root",
    });
  }

  context.onProgress?.({
    records: context.tiers.recordCount,
    phase: "chats",
  });
}

async function parseChatsFile(
  filePath: string,
  characterId: string,
  context: ParseContext,
): Promise<void> {
  const reader = new AsyncByteReader(createReadStream(filePath));
  const count = await readContainerCount(reader, "array");
  for (let position = 0; position < count; position++) {
    await parseChat(reader, characterId, position, context);
  }
  if (await reader.hasMore()) {
    throw new Error("Legacy chat array contains trailing data");
  }
}

async function parseCharacter(
  reader: AsyncByteReader,
  position: number,
  context: ParseContext,
): Promise<void> {
  const fields = await readContainerCount(reader, "map");
  const data: Record<string, any> = {};
  let characterId: string | null = null;
  let chatsPath: string | null = null;
  const characterIndex = context.characterCount++;

  for (let i = 0; i < fields; i++) {
    const key = await readString(reader);
    if (key === "chats") {
      chatsPath = join(
        context.directory,
        `legacy-character-${characterIndex}-chats.msgpack`,
      );
      await copyValueToFile(reader, chatsPath);
      continue;
    }

    const value = await decodeValue(reader);
    if (key === "chaId") {
      if (validId(value)) characterId = value;
      continue;
    }
    if (key === "detailsLoaded") continue;
    data[key] = value;
  }

  characterId ??= context.idFactory();
  await context.tiers.write("character", {
    type: "character",
    position,
    id: characterId,
    data,
  });

  if (chatsPath) {
    try {
      await parseChatsFile(chatsPath, characterId, context);
    } finally {
      await fs.rm(chatsPath, { force: true }).catch(() => {});
    }
  }

  context.onProgress?.({
    records: context.tiers.recordCount,
    phase: "characters",
  });
}

async function parseCharacters(
  reader: AsyncByteReader,
  context: ParseContext,
): Promise<void> {
  const count = await readContainerCount(reader, "array");
  for (let position = 0; position < count; position++) {
    await parseCharacter(reader, position, context);
  }
}

async function parseModules(
  reader: AsyncByteReader,
  context: ParseContext,
): Promise<void> {
  const count = await readContainerCount(reader, "array");
  for (let position = 0; position < count; position++) {
    const data = await decodeValue(reader);
    const id =
      data && typeof data === "object" && validId(data.id)
        ? data.id
        : context.idFactory();
    if (data && typeof data === "object") data.id = id;
    await context.tiers.write("root", {
      type: "module",
      position,
      id,
      data,
    });
  }
}

async function parsePluginStorage(
  reader: AsyncByteReader,
  context: ParseContext,
): Promise<void> {
  const count = await readContainerCount(reader, "map");
  for (let i = 0; i < count; i++) {
    const key = await readString(reader);
    const value = await decodeValue(reader);
    await context.tiers.write("root", {
      type: "plugin-storage",
      key,
      value,
    });
  }
}

function activePresetIndex(value: unknown, count: number): number {
  if (count <= 0) return -1;
  const numeric = Number(value) || 0;
  return Math.max(0, Math.min(numeric, count - 1));
}

async function parseLegacyRoot(
  reader: AsyncByteReader,
  context: ParseContext,
  sourceRevision: number,
): Promise<void> {
  const fields = await readContainerCount(reader, "map");
  const presets: any[] = [];
  let botPresetsId: unknown = 0;
  let existingActivePresetId: unknown = undefined;
  let moduleIntegration: unknown = undefined;
  let portableBranchGraphsPresent = false;

  await context.tiers.write("root", {
    type: "meta",
    formatVersion: 1,
    revision: sourceRevision,
  });

  const excluded = new Set([
    "characters",
    "modules",
    "botPresets",
    "botPresetsId",
    "pluginCustomStorage",
    "isSql",
  ]);

  for (let i = 0; i < fields; i++) {
    const key = await readString(reader);

    if (key === "characters") {
      await parseCharacters(reader, context);
      continue;
    }
    if (key === "modules") {
      await parseModules(reader, context);
      continue;
    }
    if (key === "pluginCustomStorage") {
      await parsePluginStorage(reader, context);
      continue;
    }
    if (key === "botPresets") {
      const count = await readContainerCount(reader, "array");
      for (let position = 0; position < count; position++) {
        presets.push(await decodeValue(reader));
      }
      continue;
    }
    if (key === "botPresetsId") {
      botPresetsId = await decodeValue(reader);
      continue;
    }
    if (key === "activeBotPresetId") {
      existingActivePresetId = await decodeValue(reader);
      continue;
    }
    if (key === "haejeokBranchGraphs") {
      portableBranchGraphsPresent = true;
      await consumeValue(reader, async () => {});
      continue;
    }

    const value = await decodeValue(reader);
    if (key === "moduleIntergration") moduleIntegration = value;
    if (
      excluded.has(key) ||
      LEGACY_PERSONA_MIRROR_KEYS.has(key) ||
      value === undefined
    ) {
      continue;
    }
    await context.tiers.write("root", {
      type: "setting",
      key,
      value,
    });
  }

  if (portableBranchGraphsPresent) {
    throw new LegacyBackupStreamingUnsupportedError(
      "Portable branch graphs require the compatibility decoder",
      "portable_branch_graphs_present",
    );
  }

  if (presets.length > 0) {
    const ids = presets.map(() => context.idFactory());
    const active = activePresetIndex(botPresetsId, presets.length);
    await context.tiers.write("root", {
      type: "setting",
      key: "activeBotPresetId",
      value: ids[active],
    });
    for (let position = 0; position < presets.length; position++) {
      const original = presets[position];
      const data =
        position === active && typeof moduleIntegration === "string"
          ? { ...original, moduleIntergration: moduleIntegration }
          : original;
      await context.tiers.write("root", {
        type: "preset",
        position,
        id: ids[position],
        data,
      });
    }
  } else if (existingActivePresetId !== undefined) {
    await context.tiers.write("root", {
      type: "setting",
      key: "activeBotPresetId",
      value: existingActivePresetId,
    });
  }
}

export async function streamLegacyBackupDatabaseToSqlNdjson(
  filePath: string,
  options: StreamLegacyBackupOptions,
): Promise<StreamLegacyBackupResult> {
  const sourceRevision = Math.max(
    0,
    Number.isSafeInteger(options.sourceRevision)
      ? Number(options.sourceRevision)
      : 0,
  );
  const directory = await fs.mkdtemp(
    join(
      filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/") + 1) : "",
      ".legacy-risu-stream-",
    ),
  );
  const tiers = new RecordTierWriter(
    directory,
    options.outputPath,
    options.encodeRecord,
  );
  const context: ParseContext = {
    directory,
    tiers,
    idFactory: options.idFactory,
    onProgress: options.onProgress,
    characterCount: 0,
    chatCount: 0,
    messageCount: 0,
  };

  try {
    const source = await createMessagePackSource(filePath);
    const reader = new AsyncByteReader(source);
    options.onProgress?.({ records: 0, phase: "reading" });
    await parseLegacyRoot(reader, context, sourceRevision);
    if (await reader.hasMore()) {
      throw new Error("Legacy backup database contains trailing MessagePack data");
    }
    options.onProgress?.({
      records: tiers.recordCount,
      phase: "finalizing",
    });
    await tiers.closeAndMerge();
    await tiers.cleanup();
    return {
      sourceRevision,
      recordCount: tiers.recordCount,
      outputPath: options.outputPath,
    };
  } catch (error) {
    await tiers.cleanup().catch(() => {});
    await fs.rm(options.outputPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
