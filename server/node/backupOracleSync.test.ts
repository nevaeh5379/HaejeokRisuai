import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as fflate from "fflate";
import { Packr, Unpackr } from "msgpackr/index-no-eval";

const require = createRequire(import.meta.url);
const {
  OracleStorage,
  normalizeEmptyStringBinds,
  toOracleColumn,
  COLUMN_NAME_MAP,
} = require("./oracleStorage.cjs");
const {
  splitCharacter,
  splitChat,
  splitMessage,
} = require("./postgresRelationalCodec.cjs");
const { splitSetting } = require("./postgresSettingsCodec.cjs");
const { projectSettings } = require("./postgresSettingRelations.cjs");

const packr = new Packr({ int64AsType: "number", useRecords: false });
const unpackr = new Unpackr({ int64AsType: "number", useRecords: false });

const magicCompressedHeader = new Uint8Array([
  0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8,
]);
const magicHeader = new Uint8Array([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);

function encodeRisuDb(dbObject: any): Uint8Array {
  const packed = packr.encode(dbObject);
  const compressed = fflate.compressSync(packed);
  const result = new Uint8Array(
    magicCompressedHeader.length + compressed.length,
  );
  result.set(magicCompressedHeader, 0);
  result.set(compressed, magicCompressedHeader.length);
  return result;
}

function decodeRisuDb(data: Uint8Array): any {
  let isCompressed = true;
  for (let i = 0; i < magicCompressedHeader.length; i++) {
    if (data[i] !== magicCompressedHeader[i]) {
      isCompressed = false;
      break;
    }
  }
  if (isCompressed) {
    const raw = data.slice(magicCompressedHeader.length);
    const decompressed = fflate.decompressSync(raw);
    return unpackr.decode(decompressed);
  }

  let isRaw = true;
  for (let i = 0; i < magicHeader.length; i++) {
    if (data[i] !== magicHeader[i]) {
      isRaw = false;
      break;
    }
  }
  if (isRaw) {
    const raw = data.slice(magicHeader.length);
    return unpackr.decode(raw);
  }

  return unpackr.decode(data);
}

function createMockArchiveBuffer(
  entries: { name: string; data: Uint8Array }[],
): Buffer {
  const buffers: Buffer[] = [];
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const nameLenBuf = Buffer.alloc(4);
    nameLenBuf.writeUInt32LE(nameBuf.length, 0);

    const dataLenBuf = Buffer.alloc(4);
    dataLenBuf.writeUInt32LE(entry.data.length, 0);

    buffers.push(nameLenBuf, nameBuf, dataLenBuf, Buffer.from(entry.data));
  }
  return Buffer.concat(buffers);
}

function parseBackupArchiveFromBuffer(buf: Buffer): {
  dbData: Buffer;
  entryCount: number;
} {
  let offset = 0;
  let dbData: Buffer | null = null;
  let entryCount = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) break;
    const nameLen = buf.readUInt32LE(offset);
    offset += 4;
    const name = buf.toString("utf8", offset, offset + nameLen);
    offset += nameLen;

    const dataLen = buf.readUInt32LE(offset);
    offset += 4;

    if (name === "database.risudat") {
      dbData = buf.subarray(offset, offset + dataLen);
    }
    entryCount++;
    offset += dataLen;
  }
  if (!dbData) {
    throw new Error("database.risudat not found in archive");
  }
  return { dbData: Buffer.from(dbData), entryCount };
}

describe("Oracle Backup Archive Sync Test", () => {
  it("creates, decodes, and validates full backup archive sync with OracleStorage", async () => {
    // 1. Create a complete synthetic backup database structure
    const sampleDb = {
      botPresets: [
        {
          name: "Default",
          prompt: "You are an AI assistant.",
          temperature: 0.7,
        },
      ],
      botPresetsId: 0,
      personas: {
        "persona-1": {
          name: "UserPersona",
          prompt: "User description",
        },
      },
      characters: [
        {
          chaId: "char-test-1",
          name: "Test Character",
          firstMessage: "Hello there!",
          description: "A helpful bot",
          personality: "Kind and thoughtful",
          scenario: "Testing scenario",
          exampleMessage: "<START>\nUser: Hi\nBot: Hello",
          tags: ["assistant", "ai", "test"],
          alternateGreetings: ["Hey!", "Greetings!"],
          bias: [["forbidden", -100]],
          emotionImages: [["smile", "smile.png"]],
          customScript: [
            {
              comment: "test script",
              in: "input",
              out: "output",
              type: "regex",
              flag: "g",
              ableFlag: true,
            },
          ],
          lorebook: {
            entries: [
              {
                id: "lore-1",
                key: "world",
                content: "The world is vast.",
                mode: "constant",
                alwaysActive: true,
              },
            ],
          },
          chats: [
            {
              id: "chat-test-1",
              name: "First Chat Session",
              message: [
                {
                  id: "msg-1",
                  role: "user",
                  data: "Hello, testing Oracle sync.",
                  time: Date.now(),
                  promptInfo: {
                    info: "main_prompt",
                    toggles: { systemPrompt: true, jailbreak: false },
                    items: [{ name: "item1", content: "payload" }],
                  },
                },
                {
                  id: "msg-2",
                  role: "char",
                  data: "Oracle sync test response.",
                  time: Date.now() + 1000,
                  generationInfo: {
                    model: "claude-3-5-sonnet",
                    generationId: "gen-123",
                    inputTokens: 120,
                    outputTokens: 45,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const encodedDbData = encodeRisuDb(sampleDb);
    const archiveBuffer = createMockArchiveBuffer([
      { name: "database.risudat", data: encodedDbData },
      { name: "assets/smile.png", data: new Uint8Array([137, 80, 78, 71]) },
    ]);

    // 2. Parse archive buffer
    const { dbData, entryCount } = parseBackupArchiveFromBuffer(archiveBuffer);
    expect(entryCount).toBe(2);
    expect(dbData).toBeDefined();

    const decodedDb = decodeRisuDb(new Uint8Array(dbData));
    expect(decodedDb).toBeDefined();
    expect(decodedDb.characters.length).toBe(1);
    expect(decodedDb.characters[0].name).toBe("Test Character");

    // 3. Validate decomposition and bulk insert logic
    const storage = new OracleStorage({});
    const executedCalls: { sql: string; binds: any }[] = [];
    const mockConn = {
      execute: vi.fn(async (sql: string, binds: any) => {
        executedCalls.push({ sql, binds });
        return {};
      }),
      executeMany: vi.fn(async (sql: string, binds: any) => {
        executedCalls.push({ sql, binds });
        return {};
      }),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
    };

    const splitCharacters = decodedDb.characters.map((char: any, i: number) =>
      splitCharacter({
        id: char.chaId || `char-${i}`,
        position: i,
        data: char,
      }),
    );
    expect(splitCharacters.length).toBe(1);

    // Character attributes
    const charAttributes = splitCharacters.flatMap((item: any) =>
      item.attributes.map((r: any) => ({
        character_id: item.core.id,
        key_value: r.key,
        value: r.value,
      })),
    );
    await storage._bulkInsertRows(
      mockConn,
      "character_attributes",
      ["character_id", "key_value", "value"],
      charAttributes,
    );
    expect(executedCalls.length).toBeGreaterThan(0);
    expect(executedCalls[0].sql.toUpperCase()).toContain(
      "INSERT INTO CHARACTER_ATTRIBUTES",
    );

    // 4. Test storage.sync() with mock connection pool
    const allChars = decodedDb.characters.map((char: any, i: number) => ({
      id: char.chaId,
      position: i,
      data: char,
    }));

    const allChatsForSync: any[] = [];
    const allMessagesForSync: any[] = [];
    for (const char of decodedDb.characters) {
      for (let j = 0; j < char.chats.length; j++) {
        const c = char.chats[j];
        allChatsForSync.push({
          id: c.id,
          characterId: char.chaId,
          position: j,
          data: c,
        });
        for (let k = 0; k < c.message.length; k++) {
          allMessagesForSync.push({
            id: c.message[k].id,
            chatId: c.id,
            position: k,
            data: c.message[k],
          });
        }
      }
    }

    const rootKeys = Object.keys(decodedDb).filter(
      (k) => !["characters", "botPresets", "botPresetsId"].includes(k),
    );
    const rootUpserts = rootKeys.map((k) => ({
      key: k,
      value: (decodedDb as any)[k],
    }));

    const syncPayload = {
      baseRevision: 0,
      replaceAll: true,
      root: { upserts: rootUpserts, deletes: [] },
      presets: {
        upserts: [
          {
            id: "123e4567-e89b-42d3-a456-426614174000",
            position: 0,
            data: decodedDb.botPresets[0],
          },
        ],
        deletes: [],
        order: ["123e4567-e89b-42d3-a456-426614174000"],
        activeId: "123e4567-e89b-42d3-a456-426614174000",
      },
      characters: allChars,
      characterIds: allChars.map((c) => c.id),
      chats: allChatsForSync,
      chatManifests: [],
      messages: allMessagesForSync,
      messageManifests: [],
    };

    const mockPoolConn = {
      execute: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT revision FROM system_storage_meta")) {
          return { rows: [{ REVISION: 0 }] };
        }
        if (sql.includes("SELECT id FROM character_characters")) {
          return { rows: [] };
        }
        if (
          sql.includes("SELECT preset_id, position FROM system_bot_presets")
        ) {
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO system_revisions")) {
          return { outBinds: { 6: [1] } };
        }
        return {};
      }),
      executeMany: vi.fn(async () => ({})),
      commit: vi.fn(async () => {}),
      rollback: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    storage.enabled = true;
    storage.pool = {
      getConnection: vi.fn(async () => mockPoolConn),
    };

    const syncResult = await storage.sync(syncPayload);
    expect(syncResult).toBeDefined();
    expect(syncResult.revision).toBe(1);
    expect(syncResult.changed.characters).toBe(1);
    expect(syncResult.changed.chats).toBe(1);
    expect(syncResult.changed.messages).toBe(2);

    // 5. Test storage.loadStartupData()
    const splitSettingRows = rootUpserts.map((u: any) =>
      splitSetting(u.key, u.value),
    );
    const allSettingRows = splitSettingRows.map((s: any) => ({
      KEY: s.setting.key,
      VALUE_TYPE: s.setting.value_type,
      UPDATED_AT: Date.now(),
    }));
    const allSettingValueRows = splitSettingRows.flatMap((s: any) =>
      s.values.map((v: any) => ({
        SETTING_KEY: v.setting_key,
        NODE_ID: v.node_id,
        PARENT_NODE_ID: v.parent_node_id,
        MEMBER_KEY: v.member_key,
        ENCODED_MEMBER_KEY: v.encoded_member_key,
        POSITION: v.position,
        VALUE_TYPE: v.value_type,
        BOOLEAN_VALUE: v.boolean_value ? 1 : 0,
        NUMBER_VALUE: v.number_value,
        TEXT_VALUE: v.text_value,
        ENCODED_TEXT_VALUE: v.encoded_text_value,
        UPDATED_AT: Date.now(),
      })),
    );

    const mockLoadConn = {
      execute: vi.fn(async (sql: string) => {
        if (
          sql.includes("SELECT revision, initialized FROM system_storage_meta")
        ) {
          return { rows: [{ REVISION: 1, INITIALIZED: 1 }] };
        }
        if (sql.includes("FROM system_settings")) {
          return { rows: allSettingRows };
        }
        if (sql.includes("FROM system_setting_values")) {
          return { rows: allSettingValueRows };
        }
        if (sql.includes("FROM character_characters")) {
          return {
            rows: [
              {
                ID: "char-test-1",
                NAME: "Test Character",
                POSITION: 0,
                UPDATED_AT: Date.now(),
                IMAGE: "",
              },
            ],
          };
        }
        if (sql.includes("FROM chat_chats")) {
          return {
            rows: [
              {
                ID: "chat-test-1",
                CHARACTER_ID: "char-test-1",
                POSITION: 0,
                UPDATED_AT: Date.now(),
                NAME: "First Chat Session",
              },
            ],
          };
        }
        return { rows: [] };
      }),
      rollback: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };

    storage.pool.getConnection = vi.fn(async () => mockLoadConn);
    const startup = await storage.loadStartupData();
    expect(startup).toBeDefined();
    expect(startup.status).toBe("ready");
    expect(startup.characters).toHaveLength(1);
    expect(startup.characters[0].name).toBe("Test Character");
  });
});
