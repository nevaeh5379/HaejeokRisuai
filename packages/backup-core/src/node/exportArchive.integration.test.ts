import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BackupImportStagingStore,
  type BackupImportEntryWriter,
  type StagedBackupContainer,
  type StagedBackupEntry,
  type StreamedBackupEntry,
} from "./importStagingStore";
import { buildBackupImportPlan } from "./importPlan";
import { streamLocalBackupArchive } from "./exportArchive";
import {
  PortableDatabaseExportWriter,
  writeBackupContainerEntry,
} from "./exportStream";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "risu-export-import-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function stageChunks(
  chunks: Uint8Array[],
): Promise<StagedBackupContainer> {
  const staging = new BackupImportStagingStore(await tempRoot());
  const entries: StagedBackupEntry[] = [];
  const session = await staging.createSession("integrationjob", {
    async onBufferedEntry(entry): Promise<void> {
      entries.push({ ...entry });
    },
    async openAssetEntry(
      entry: StreamedBackupEntry,
    ): Promise<BackupImportEntryWriter> {
      entries.push({ ...entry, filePath: "streamed-directly" });
      return {
        async write(): Promise<void> {},
        async close(): Promise<void> {},
        async abort(): Promise<void> {},
      };
    },
  });
  for (const chunk of chunks) await session.write(chunk);
  const result = await session.finish();
  return {
    entries,
    bytesRead: result.bytesRead,
    ignoredExtensionEntries: result.ignoredExtensionEntries,
  };
}

function containerWriter(target: Uint8Array[]) {
  return async (
    name: string,
    source: Uint8Array | AsyncIterable<Uint8Array>,
    size: number,
  ) => {
    await writeBackupContainerEntry(
      async (chunk) => {
        target.push(new Uint8Array(chunk));
      },
      name,
      source,
      size,
    );
  };
}

describe("local backup export/import container integration", () => {
  it("round-trips compatible archive entries into a legacy import plan", async () => {
    const chunks: Uint8Array[] = [];
    const writeEntry = containerWriter(chunks);
    await streamLocalBackupArchive({
      mode: "compatible",
      adapter: {
        writeEntry,
        async prepareCompatibleDatabase() {
          return {
            source: new Uint8Array([1, 2, 3]),
            size: 3,
            coldStorageKeys: ["11111111-1111-1111-1111-111111111111"],
            async loadColdStorage() {
              return { exists: true, value: [] };
            },
          };
        },
        async streamNativeDatabase() {
          throw new Error("native export should not run");
        },
        async listColdStorageKeys() {
          return [];
        },
        async loadColdStorage() {
          return { exists: false };
        },
        async assertDatabaseRevision() {},
        async listAssetKeys() {
          return ["assets/avatar.png"];
        },
        async listInlayKeys() {
          return [];
        },
        async openStorageEntry() {
          return {
            exists: true,
            source: new Uint8Array([9]),
            size: 1,
          };
        },
        async encodeDatabase() {
          throw new Error("native manifest encoding should not run");
        },
      },
    });

    const staged = await stageChunks(chunks);
    const plan = buildBackupImportPlan(staged);

    expect(plan.databaseMode).toBe("legacy");
    expect(plan.legacyDatabase?.name).toBe("database.risudat");
    expect(plan.coldStorage.map((entry) => entry.name)).toEqual([
      "coldstorage_11111111-1111-1111-1111-111111111111.json",
    ]);
    expect(plan.assets.map((entry) => entry.name)).toEqual([
      "assets/avatar.png",
    ]);
    expect(plan.inlays).toHaveLength(0);
  });
  it("round-trips native fragments and manifest into a stream import plan", async () => {
    const chunks: Uint8Array[] = [];
    const writeEntry = containerWriter(chunks);
    const encoder = new TextEncoder();

    await streamLocalBackupArchive({
      mode: "native",
      adapter: {
        writeEntry,
        async prepareCompatibleDatabase() {
          throw new Error("compatible export should not run");
        },
        async streamNativeDatabase(options) {
          const writer = new PortableDatabaseExportWriter({
            revision: 3,
            expectedRecords: 1,
            fragmentRecords: 1,
            encodeDatabase: async (value) =>
              encoder.encode(JSON.stringify(value)),
            writeEntry,
            onRecord: options.onRecord,
            onProgress(current, total) {
              options.onProgress({
                stage: "database",
                current,
                total,
              });
            },
          });
          await writer.emit({
            type: "character",
            position: 0,
            id: "char-1",
            data: { name: "Bot", image: "assets/avatar.png" },
          });
          return await writer.finalize();
        },
        async listColdStorageKeys() {
          return [];
        },
        async loadColdStorage() {
          return { exists: false };
        },
        async assertDatabaseRevision(revision) {
          expect(revision).toBe(3);
        },
        async listAssetKeys() {
          return ["assets/avatar.png"];
        },
        async listInlayKeys() {
          return ["inlay_11111111-1111-4111-8111-111111111111.risuinlay"];
        },
        async openStorageEntry() {
          return {
            exists: true,
            source: new Uint8Array([7]),
            size: 1,
          };
        },
        async encodeDatabase(value) {
          return encoder.encode(JSON.stringify(value));
        },
      },
    });

    const staged = await stageChunks(chunks);
    const plan = buildBackupImportPlan(staged);

    expect(plan.databaseMode).toBe("stream");
    expect(plan.streamFragments.map((entry) => entry.name)).toEqual([
      "database.stream/000000000001.risudat",
    ]);
    expect(plan.streamManifest?.name).toBe("database.stream/manifest.risudat");
    expect(plan.assets.map((entry) => entry.name)).toEqual([
      "assets/avatar.png",
    ]);
    expect(plan.inlays.map((entry) => entry.name)).toEqual([
      "inlay_11111111-1111-4111-8111-111111111111.risuinlay",
    ]);
    expect(staged.entries.at(-1)?.name).toBe(
      "database.stream/manifest.risudat",
    );
  });
});
