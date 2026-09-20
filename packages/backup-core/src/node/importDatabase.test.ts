import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LegacyBackupSqlRecord } from "../legacyRecords";
import {
  prepareLocalBackupDatabaseImport,
} from "./importDatabase";
import {
  encodeLegacyBackupDatabase,
} from "./legacyFormat";
import type { BackupImportPlan } from "./importPlan";

const roots: string[] = [];

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-import-db-"));
  roots.push(root);
  return root;
}

function legacyPlan(filePath: string): BackupImportPlan {
  return {
    databaseMode: "legacy",
    legacyDatabase: {
      index: 0,
      name: "database.risudat",
      size: 1,
      kind: "database",
      filePath,
    },
    streamFragments: [],
    coldStorage: [],
    assets: [],
    inlays: [],
    ignoredExtensionEntries: 0,
    bytesRead: 0,
  };
}

function streamPlan(
  manifestPath: string,
  fragmentPaths: string[],
): BackupImportPlan {
  return {
    databaseMode: "stream",
    streamFragments: fragmentPaths.map((filePath, index) => ({
      index,
      name: `database.stream/${String(index + 1).padStart(12, "0")}.risudat`,
      size: 1,
      kind: "databaseStream",
      filePath,
    })),
    streamManifest: {
      index: fragmentPaths.length,
      name: "database.stream/manifest.risudat",
      size: 1,
      kind: "databaseStream",
      filePath: manifestPath,
    },
    coldStorage: [],
    assets: [],
    inlays: [],
    ignoredExtensionEntries: 0,
    bytesRead: 0,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("prepareLocalBackupDatabaseImport", () => {
  it("prepares ordered portable fragments into NDJSON", async () => {
    const root = await makeRoot();
    const fragment1Path = path.join(root, "fragment-1.risudat");
    const fragment2Path = path.join(root, "fragment-2.risudat");
    const manifestPath = path.join(root, "manifest.risudat");

    const first: LegacyBackupSqlRecord[] = [
      { type: "meta", formatVersion: 1, revision: 5 },
      { type: "setting", key: "language", value: "ko" },
    ];
    const second: LegacyBackupSqlRecord[] = [
      {
        type: "character",
        position: 0,
        id: "char-1",
        data: { name: "Bot" },
      },
    ];

    await fs.writeFile(
      fragment1Path,
      await encodeLegacyBackupDatabase({
        format: "risu-portable-database-fragment",
        version: 1,
        index: 1,
        records: first,
      }),
    );
    await fs.writeFile(
      fragment2Path,
      await encodeLegacyBackupDatabase({
        format: "risu-portable-database-fragment",
        version: 1,
        index: 2,
        records: second,
      }),
    );
    await fs.writeFile(
      manifestPath,
      await encodeLegacyBackupDatabase({
        format: "risu-portable-database-stream",
        version: 1,
        revision: 5,
        totalFragments: 2,
        totalRecords: 3,
        counts: { meta: 1, setting: 1, character: 1 },
        complete: true,
      }),
    );

    const progress: Array<[number, number]> = [];
    const result = await prepareLocalBackupDatabaseImport(
      streamPlan(manifestPath, [fragment1Path, fragment2Path]),
      {
        encodeRecord: (record) => record,
        idFactory: () => "unused",
        onProgress: ({ current, total }) => progress.push([current, total]),
      },
    );

    expect(result).toMatchObject({
      sourceRevision: 5,
      recordCount: 3,
    });
    const records = (await fs.readFile(result.filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual([
      "meta",
      "setting",
      "character",
    ]);
    expect(progress.at(-1)).toEqual([3, 3]);
  });

  it("rejects manifest record-count mismatches and removes partial output", async () => {
    const root = await makeRoot();
    const fragmentPath = path.join(root, "fragment-1.risudat");
    const manifestPath = path.join(root, "manifest.risudat");

    await fs.writeFile(
      fragmentPath,
      await encodeLegacyBackupDatabase({
        format: "risu-portable-database-fragment",
        version: 1,
        index: 1,
        records: [{ type: "meta", formatVersion: 1, revision: 2 }],
      }),
    );
    await fs.writeFile(
      manifestPath,
      await encodeLegacyBackupDatabase({
        format: "risu-portable-database-stream",
        version: 1,
        revision: 2,
        totalFragments: 1,
        totalRecords: 2,
        counts: { meta: 2 },
        complete: true,
      }),
    );

    const outputPath = `${manifestPath}.sql.ndjson`;
    await expect(
      prepareLocalBackupDatabaseImport(
        streamPlan(manifestPath, [fragmentPath]),
        {
          encodeRecord: (record) => record,
          idFactory: () => "unused",
        },
      ),
    ).rejects.toThrow(/record count mismatch/i);
    await expect(fs.stat(outputPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("falls back to compatibility decoding for native branch graphs", async () => {
    const root = await makeRoot();
    const databasePath = path.join(root, "database.risudat");
    await fs.writeFile(
      databasePath,
      await encodeLegacyBackupDatabase({
        characters: [
          {
            chaId: "char-1",
            chats: [
              {
                id: "chat-1",
                name: "Chat",
                message: [
                  { chatId: "m1", role: "user", data: "one" },
                  { chatId: "m2", role: "char", data: "root" },
                ],
              },
            ],
          },
        ],
        haejeokBranchGraphs: {
          "chat-1": {
            branches: [
              {
                id: "root",
                chatId: "chat-1",
                reason: "root",
                createdAt: 0,
                headMessageId: "m2",
              },
              {
                id: "reroll",
                chatId: "chat-1",
                parentBranchId: "root",
                forkMessageId: "m1",
                reason: "reroll",
                createdAt: 1,
                headMessageId: "m3",
              },
            ],
            activeBranchId: "reroll",
            messages: [
              { chatId: "m1", role: "user", data: "one" },
              { chatId: "m2", role: "char", data: "root" },
              { chatId: "m3", role: "char", data: "alternate" },
            ],
            links: [
              { messageId: "m1", originBranchId: "root" },
              {
                messageId: "m2",
                parentMessageId: "m1",
                originBranchId: "root",
              },
              {
                messageId: "m3",
                parentMessageId: "m1",
                originBranchId: "reroll",
              },
            ],
          },
        },
      }),
    );

    const result = await prepareLocalBackupDatabaseImport(
      legacyPlan(databasePath),
      {
        encodeRecord: (record) => record,
        idFactory: () => "generated",
      },
    );
    const records = (await fs.readFile(result.filePath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(records.filter((record) => record.type === "branch")).toHaveLength(2);
    expect(
      records.find((record) => record.type === "active-branch"),
    ).toMatchObject({ chatId: "chat-1", branchId: "reroll" });
    expect(
      records
        .filter((record) => record.type === "message")
        .map((record) => record.id),
    ).toEqual(["m1", "m2", "m3"]);
  });
});
