import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Packr } from "msgpackr";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeLegacyBackupDatabase,
  LEGACY_COMPRESSED_DATABASE_HEADER,
} from "./legacyFormat";
import {
  streamLegacyBackupDatabaseToSqlNdjson,
} from "./legacyStream";

const temporaryDirectories: string[] = [];

async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "risu-legacy-stream-"));
  temporaryDirectories.push(directory);
  return directory;
}

function ids() {
  let value = 0;
  return () => `generated-${++value}`;
}

async function readRecords(path: string) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("streamLegacyBackupSqlRecords", () => {
  it("streams a canonical gzip legacy database into ordered SQL records", async () => {
    const directory = await tempDirectory();
    const inputPath = join(directory, "database.risudat");
    const outputPath = join(directory, "database.sql.ndjson");
    const database = {
      language: "ko",
      pluginCustomStorage: { plugin: { enabled: true } },
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
              message: [
                { chatId: "m1", role: "user", data: "hello" },
                { chatId: "m2", role: "char", data: "world" },
              ],
            },
          ],
        },
      ],
    };

    await writeFile(inputPath, await encodeLegacyBackupDatabase(database));
    const result = await streamLegacyBackupDatabaseToSqlNdjson(inputPath, {
      outputPath,
      encodeRecord: (record) => record,
      idFactory: ids(),
    });
    const records = await readRecords(outputPath);

    expect(result.recordCount).toBe(records.length);
    expect(records.map((record) => record.type)).toEqual([
      "meta",
      "setting",
      "plugin-storage",
      "module",
      "setting",
      "preset",
      "character",
      "chat",
      "branch",
      "active-branch",
      "message",
      "message",
    ]);
    expect(
      records.find(
        (record) =>
          record.type === "setting" &&
          record.key === "activeBotPresetId",
      ),
    ).toMatchObject({ value: "generated-1" });
    expect(
      records.filter((record) => record.type === "message"),
    ).toMatchObject([
      {
        id: "m1",
        position: 0,
        originBranchId: "root",
      },
      {
        id: "m2",
        position: 1,
        parentMessageId: "m1",
        originBranchId: "root",
      },
    ]);
  });

  it("accepts zlib-wrapped backups from transitional server builds", async () => {
    const directory = await tempDirectory();
    const inputPath = join(directory, "database.risudat");
    const outputPath = join(directory, "database.sql.ndjson");
    const packr = new Packr({ useRecords: false });
    const database = {
      language: "en",
      characters: [],
    };
    await writeFile(
      inputPath,
      Buffer.concat([
        LEGACY_COMPRESSED_DATABASE_HEADER,
        deflateSync(packr.encode(database)),
      ]),
    );

    const result = await streamLegacyBackupDatabaseToSqlNdjson(inputPath, {
      outputPath,
      encodeRecord: (record) => record,
      idFactory: ids(),
    });
    expect(result.recordCount).toBe(2);
    expect(await readRecords(outputPath)).toMatchObject([
      { type: "meta", revision: 0 },
      { type: "setting", key: "language", value: "en" },
    ]);
  });

  it("routes native portable branch graphs to the compatibility path", async () => {
    const directory = await tempDirectory();
    const inputPath = join(directory, "database.risudat");
    const outputPath = join(directory, "database.sql.ndjson");
    await writeFile(
      inputPath,
      await encodeLegacyBackupDatabase({
        characters: [],
        haejeokBranchGraphs: {
          "chat-1": {
            branches: [{ id: "root" }],
            messages: [],
            links: [],
          },
        },
      }),
    );

    await expect(
      streamLegacyBackupDatabaseToSqlNdjson(inputPath, {
        outputPath,
        encodeRecord: (record) => record,
        idFactory: ids(),
      }),
    ).rejects.toMatchObject({
      code: "portable_branch_graphs_present",
    });
  });
});
