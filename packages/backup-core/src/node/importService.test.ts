import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeInlayAssetBackup } from "../inlayCodec";
import {
  createLocalBackupEntryHeader,
  encodeLegacyBackupDatabase,
} from "./legacyFormat";
import { LEGACY_COMPRESSED_DATABASE_HEADER_BYTES } from "../legacyHeaders";
import type { LegacyBackupSqlRecord } from "../legacyRecords";
import type { PreparedLocalBackupDatabase } from "./importDatabase";
import { LocalBackupImportJobStore } from "./importJobStore";
import { BackupImportStagingStore } from "./importStagingStore";
import { BackupImportUploadStore } from "./importUploadStore";
import {
  LocalBackupImportService,
  type LocalBackupImportAdapter,
  type LocalBackupImportRestoreResult,
} from "./importService";

const roots: string[] = [];

function framed(name: string, data: Uint8Array): Uint8Array {
  const header = createLocalBackupEntryHeader(name, data.length);
  const result = new Uint8Array(header.length + data.length);
  result.set(header);
  result.set(data, header.length);
  return result;
}

function jsonBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface CountingAdapterState {
  coldStorageKeys: string[];
  assetKeys: string[];
  inlayEntryNames: string[];
  databaseApplyCount: number;
}

function countingAdapter(
  state: CountingAdapterState,
): LocalBackupImportAdapter {
  return {
    writeColdStorage: async (key: string, _value: unknown): Promise<void> => {
      state.coldStorageKeys.push(key);
    },
    writeAsset: async (
      key: string,
      _filePath: string,
      _size: number,
    ): Promise<void> => {
      if (key.startsWith("inlay_")) {
        state.inlayEntryNames.push(key);
      } else {
        state.assetKeys.push(key);
      }
    },
    encodeDatabaseRecord: (record: LegacyBackupSqlRecord): unknown => record,
    applyPreparedDatabase: async (
      _prepared: PreparedLocalBackupDatabase,
      _sourceClientId: unknown,
    ): Promise<LocalBackupImportRestoreResult> => {
      state.databaseApplyCount += 1;
      return { revision: 1, recordCount: 0 };
    },
  };
}

async function* chunked(parts: Uint8Array[], size = 11) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    payload.set(part, offset);
    offset += part.length;
  }
  for (let cursor = 0; cursor < payload.length; cursor += size) {
    yield payload.subarray(cursor, Math.min(payload.length, cursor + size));
  }
}

async function makeStores(id: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-import-service-"));
  roots.push(root);
  return {
    root,
    jobs: new LocalBackupImportJobStore(60_000, () => id),
    staging: new BackupImportStagingStore(root),
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("LocalBackupImportService", () => {
  it("owns import orchestration, progress, and cleanup", async () => {
    const { root, jobs, staging } = await makeStores("import_001");
    const order: string[] = [];
    const observedStages: string[] = [];
    let service!: LocalBackupImportService;

    const adapter: LocalBackupImportAdapter = {
      async writeColdStorage(key, value) {
        order.push("coldStorage");
        expect(key).toBe("11111111-1111-1111-1111-111111111111");
        expect(value).toEqual({ character: [] });
        observedStages.push(service.progress("import_001").progress.stage);
      },
      async writeAsset(key, filePath, size) {
        expect(filePath).toContain("import_001");
        expect(size).toBeGreaterThan(0);
        if (key === "assets/a.png") {
          order.push("assets");
        } else {
          expect(key).toBe(
            "inlay_22222222-2222-2222-2222-222222222222.risuinlay",
          );
          order.push("inlays");
        }
        observedStages.push(service.progress("import_001").progress.stage);
      },
      encodeDatabaseRecord(record) {
        return record;
      },
      async applyPreparedDatabase(prepared, sourceClientId) {
        order.push("database");
        expect(sourceClientId).toBe("client-1");
        expect(prepared.sourceRevision).toBe(0);
        expect(prepared.recordCount).toBeGreaterThan(0);
        const records = (await fs.readFile(prepared.filePath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
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
        observedStages.push(service.progress("import_001").progress.stage);
        return { revision: 7, recordCount: prepared.recordCount };
      },
    };
    service = new LocalBackupImportService(jobs, staging, adapter);
    const job = service.createJob();

    const inlay = await encodeInlayAssetBackup({
      data: "payload",
      ext: "png",
      name: "Inlay",
      type: "image",
    });
    const database = await encodeLegacyBackupDatabase({
      language: "ko",
      characters: [],
    });
    const parts = [
      framed("database.risudat", database),
      framed(
        "coldstorage_11111111-1111-1111-1111-111111111111.json",
        new TextEncoder().encode('{"character":[]}'),
      ),
      framed("assets/a.png", new Uint8Array([4, 5])),
      framed("inlay_22222222-2222-2222-2222-222222222222.risuinlay", inlay),
    ];
    const totalBytes = parts.reduce((sum, part) => sum + part.length, 0);
    await expect(
      service.importStream(job.id, chunked(parts), {
        totalBytes,
        sourceClientId: "client-1",
      }),
    ).resolves.toEqual({
      status: "complete",
      error: null,
      revision: 7,
      recordCount: 2,
    });

    expect(order).toEqual(["coldStorage", "assets", "inlays", "database"]);
    expect(observedStages).toEqual([
      "coldStorage",
      "assets",
      "inlays",
      "database",
    ]);
    expect(service.progress(job.id)).toEqual({
      status: "complete",
      progress: { stage: "finalizing", current: 1, total: 1 },
    });
    await expect(fs.stat(path.join(root, job.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("settles an error and cleans staging when an adapter fails", async () => {
    const { root, jobs, staging } = await makeStores("import_002");
    const adapter: LocalBackupImportAdapter = {
      async writeColdStorage() {},
      async writeAsset() {},
      encodeDatabaseRecord(record) {
        return record;
      },
      async applyPreparedDatabase() {
        throw new Error("database restore failed");
      },
    };
    const service = new LocalBackupImportService(jobs, staging, adapter);
    const job = service.createJob();
    const payload = framed(
      "database.risudat",
      await encodeLegacyBackupDatabase({ characters: [] }),
    );

    await expect(
      service.importStream(job.id, chunked([payload])),
    ).rejects.toThrow("database restore failed");
    await expect(service.wait(job.id)).resolves.toEqual({
      status: "error",
      error: "database restore failed",
      revision: undefined,
      recordCount: undefined,
    });
    await expect(fs.stat(path.join(root, job.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("restores a backup after multiple offset upload requests", async () => {
    const { root, jobs, staging } = await makeStores("import_004");
    const uploads = new BackupImportUploadStore(path.join(root, "uploads"));
    const adapter: LocalBackupImportAdapter = {
      async writeColdStorage() {},
      async writeAsset() {},
      encodeDatabaseRecord(record) {
        return record;
      },
      async applyPreparedDatabase(prepared, sourceClientId) {
        expect(sourceClientId).toBe("client-chunked");
        expect(prepared.recordCount).toBe(2);
        return { revision: 12, recordCount: prepared.recordCount };
      },
    };
    const service = new LocalBackupImportService(
      jobs,
      staging,
      adapter,
      uploads,
    );
    const job = service.createJob();
    const payload = framed(
      "database.risudat",
      await encodeLegacyBackupDatabase({
        language: "ko",
        characters: [],
      }),
    );
    const split = Math.floor(payload.length / 2);

    await expect(
      service.appendUploadChunk(
        job.id,
        0,
        chunked([payload.subarray(0, split)], 7),
        payload.length,
      ),
    ).resolves.toMatchObject({
      receivedBytes: split,
      totalBytes: payload.length,
      complete: false,
    });
    await expect(
      service.appendUploadChunk(
        job.id,
        split,
        chunked([payload.subarray(split)], 9),
        payload.length,
      ),
    ).resolves.toMatchObject({
      receivedBytes: payload.length,
      complete: true,
    });

    await expect(
      service.finalizeUpload(job.id, { sourceClientId: "client-chunked" }),
    ).resolves.toEqual({
      status: "complete",
      error: null,
      revision: 12,
      recordCount: 2,
    });
    await expect(
      fs.stat(path.join(root, "uploads", `${job.id}.upload`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves encrypted-backup rejection and marks the job failed", async () => {
    const { root, jobs, staging } = await makeStores("import_003");
    const adapter: LocalBackupImportAdapter = {
      async writeColdStorage() {},
      async writeAsset() {},
      encodeDatabaseRecord(record) {
        return record;
      },
      async applyPreparedDatabase() {
        throw new Error("database adapter must not run");
      },
    };
    const service = new LocalBackupImportService(jobs, staging, adapter);
    const job = service.createJob();
    const encrypted = framed(
      "encryption.risudat",
      new TextEncoder().encode('{"type":"account","time":1}'),
    );

    await expect(
      service.importStream(job.id, chunked([encrypted])),
    ).rejects.toMatchObject({
      code: "encrypted_backup_unsupported",
    });
    await expect(service.wait(job.id)).resolves.toMatchObject({
      status: "error",
      error: "Account-encrypted backups are intentionally unsupported.",
    });
    await expect(fs.stat(path.join(root, job.id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  async function runImport(
    service: LocalBackupImportService,
    jobId: string,
    parts: Uint8Array[],
  ): Promise<void> {
    await expect(
      service.importStream(jobId, chunked(parts), {}),
    ).rejects.toThrow();
    await expect(service.wait(jobId)).resolves.toMatchObject({
      status: "error",
    });
  }

  it("writes nothing when the backup is missing a database entry", async (): Promise<void> => {
    const { jobs, staging } = await makeStores("import_no_db");
    const state: CountingAdapterState = {
      coldStorageKeys: [],
      assetKeys: [],
      inlayEntryNames: [],
      databaseApplyCount: 0,
    };
    const service = new LocalBackupImportService(
      jobs,
      staging,
      countingAdapter(state),
    );
    const job = service.createJob();

    await runImport(service, job.id, [
      framed(
        "coldstorage_11111111-1111-1111-1111-111111111111.json",
        jsonBytes('{"character":[]}'),
      ),
    ]);

    expect(state.coldStorageKeys).toHaveLength(0);
    expect(state.assetKeys).toHaveLength(0);
    expect(state.inlayEntryNames).toHaveLength(0);
    expect(state.databaseApplyCount).toBe(0);
  });

  it("writes nothing when the staged database payload cannot be decoded", async (): Promise<void> => {
    const { jobs, staging } = await makeStores("import_bad_db");
    const state: CountingAdapterState = {
      coldStorageKeys: [],
      assetKeys: [],
      inlayEntryNames: [],
      databaseApplyCount: 0,
    };
    const service = new LocalBackupImportService(
      jobs,
      staging,
      countingAdapter(state),
    );
    const job = service.createJob();

    const corruptDatabase: Uint8Array = new Uint8Array([
      ...LEGACY_COMPRESSED_DATABASE_HEADER_BYTES,
      ...new TextEncoder().encode("not gzip"),
    ]);
    await runImport(service, job.id, [
      framed(
        "coldstorage_11111111-1111-1111-1111-111111111111.json",
        jsonBytes('{"character":[]}'),
      ),
      framed("database.risudat", corruptDatabase),
    ]);

    expect(state.coldStorageKeys).toHaveLength(0);
    expect(state.assetKeys).toHaveLength(0);
    expect(state.inlayEntryNames).toHaveLength(0);
    expect(state.databaseApplyCount).toBe(0);
  });

  it("writes nothing when a later cold storage payload is malformed", async (): Promise<void> => {
    const { jobs, staging } = await makeStores("import_bad_cold");
    const state: CountingAdapterState = {
      coldStorageKeys: [],
      assetKeys: [],
      inlayEntryNames: [],
      databaseApplyCount: 0,
    };
    const service = new LocalBackupImportService(
      jobs,
      staging,
      countingAdapter(state),
    );
    const job = service.createJob();

    await runImport(service, job.id, [
      framed(
        "coldstorage_11111111-1111-1111-1111-111111111111.json",
        jsonBytes('{"character":[]}'),
      ),
      framed(
        "coldstorage_22222222-2222-2222-2222-222222222222.json",
        jsonBytes("not json"),
      ),
    ]);

    expect(state.coldStorageKeys).toHaveLength(0);
    expect(state.assetKeys).toHaveLength(0);
    expect(state.inlayEntryNames).toHaveLength(0);
    expect(state.databaseApplyCount).toBe(0);
  });

  it("writes nothing when a staged inlay payload is malformed", async (): Promise<void> => {
    const { jobs, staging } = await makeStores("import_bad_inlay");
    const state: CountingAdapterState = {
      coldStorageKeys: [],
      assetKeys: [],
      inlayEntryNames: [],
      databaseApplyCount: 0,
    };
    const service = new LocalBackupImportService(
      jobs,
      staging,
      countingAdapter(state),
    );
    const job = service.createJob();

    await runImport(service, job.id, [
      framed(
        "inlay_22222222-2222-2222-2222-222222222222.risuinlay",
        new Uint8Array([1]),
      ),
    ]);

    expect(state.coldStorageKeys).toHaveLength(0);
    expect(state.assetKeys).toHaveLength(0);
    expect(state.inlayEntryNames).toHaveLength(0);
    expect(state.databaseApplyCount).toBe(0);
  });

  it("writes nothing when an asset entry name cannot be resolved", async (): Promise<void> => {
    const { jobs, staging } = await makeStores("import_bad_asset");
    const state: CountingAdapterState = {
      coldStorageKeys: [],
      assetKeys: [],
      inlayEntryNames: [],
      databaseApplyCount: 0,
    };
    const service = new LocalBackupImportService(
      jobs,
      staging,
      countingAdapter(state),
    );
    const job = service.createJob();

    await runImport(service, job.id, [framed("assets", new Uint8Array([1]))]);

    expect(state.coldStorageKeys).toHaveLength(0);
    expect(state.assetKeys).toHaveLength(0);
    expect(state.inlayEntryNames).toHaveLength(0);
    expect(state.databaseApplyCount).toBe(0);
  });
});
