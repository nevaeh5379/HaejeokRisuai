import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeLegacyBackupDatabase } from "@risuai/backup-core/node/legacyFormat";
import { streamLegacyBackupDatabaseToSqlNdjson } from "@risuai/backup-core/node/legacyStream";
import { encodeRisuSaveLegacyAsync } from "./risuSave";
import {
  decodeStorageSyncValue,
  encodeStorageSyncValue,
} from "../../../../packages/protocol/storageSyncValueCodec.cjs";

const require = createRequire(import.meta.url);
const { readStorageSyncSqlRecords } = require(
  "../../../../server/node/storageSyncSqlRecords.cjs",
);

describe("server legacy backup compatibility", () => {
  it("decodes the same compressed legacy payload produced by the client", async () => {
    const database = {
      language: "ko",
      characters: [
        {
          chaId: "char-1",
          name: "Bot",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              message: [{ chatId: "m1", role: "user", data: "hello" }],
            },
          ],
        },
      ],
    };

    const encoded = await encodeRisuSaveLegacyAsync(
      database as any,
      "compression",
    );
    expect(decodeLegacyBackupDatabase(encoded)).toEqual(database);
  });

  it("streams the current compressed legacy backup into SQL records without whole-database decoding", async () => {
    const directory = await mkdtemp(join(tmpdir(), "risu-legacy-stream-"));
    const input = join(directory, "database.risudat");
    const output = join(directory, "database.sql.ndjson");
    const database = {
      language: "ko",
      theme: "dark",
      pluginCustomStorage: { pluginA: { enabled: true } },
      modules: [{ id: "module-1", name: "Module" }],
      botPresets: [{ name: "Preset" }],
      botPresetsId: 0,
      characters: [
        {
          chaId: "char-1",
          name: "Bot",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              message: Array.from({ length: 512 }, (_, index) => ({
                chatId: `m-${index}`,
                role: index % 2 === 0 ? "user" : "char",
                data: `message-${index}`,
              })),
            },
          ],
        },
      ],
    };

    try {
      await writeFile(
        input,
        await encodeRisuSaveLegacyAsync(database as any, "compression"),
      );
      const result = await streamLegacyBackupDatabaseToSqlNdjson(input, {
        outputPath: output,
        encodeRecord: encodeStorageSyncValue,
        idFactory: (() => {
          let index = 0;
          return () => `generated-${++index}`;
        })(),
      });

      const validation = await readStorageSyncSqlRecords(output, {
        expectedRecordCount: result.recordCount,
        expectedSourceRevision: 0,
      });
      const records = (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .map((line) => decodeStorageSyncValue(JSON.parse(line)));

      expect(validation.recordCount).toBe(result.recordCount);
      expect(validation.sourceRevision).toBe(0);
      expect(result.recordCount).toBe(records.length);
      expect(records[0]).toEqual({
        type: "meta",
        formatVersion: 1,
        revision: 0,
      });
      expect(records).toContainEqual({
        type: "setting",
        key: "language",
        value: "ko",
      });
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "character",
          id: "char-1",
          position: 0,
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "chat",
          id: "chat-1",
          characterId: "char-1",
          position: 0,
        }),
      );
      const messages = records.filter(
        (record: any) => record.type === "message",
      );
      expect(messages).toHaveLength(512);
      expect(messages[0]).toMatchObject({
        chatId: "chat-1",
        id: "m-0",
        originBranchId: "root",
        position: 0,
        data: { role: "user", data: "message-0" },
      });
      expect(messages[511]).toMatchObject({
        id: "m-511",
        parentMessageId: "m-510",
      });

      const branchIndex = records.findIndex(
        (record: any) =>
          record.type === "branch" && record.chatId === "chat-1",
      );
      const firstMessageIndex = records.findIndex(
        (record: any) =>
          record.type === "message" && record.chatId === "chat-1",
      );
      expect(branchIndex).toBeGreaterThan(-1);
      expect(branchIndex).toBeLessThan(firstMessageIndex);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
