import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeInlayAssetBackup } from "../inlayCodec";
import type { LegacyBackupSqlRecord } from "../legacyRecords";
import type { PortableDatabaseStreamManifest } from "../streamFormat";
import {
  createLocalBackupEntryHeader,
  encodeLegacyBackupDatabase,
} from "./legacyFormat";
import { LocalBackupImportJobStore } from "./importJobStore";
import { BackupImportStagingStore } from "./importStagingStore";
import { BackupImportUploadStore } from "./importUploadStore";
import {
  LocalBackupImportService,
  type LocalBackupImportAdapter,
  type LocalBackupImportPreparedState,
  type LocalBackupImportRestoreSession,
} from "./importService";

const roots: string[] = [];

function framed(name: string, data: Uint8Array): Uint8Array {
  const header = createLocalBackupEntryHeader(name, data.length);
  const result = new Uint8Array(header.length + data.length);
  result.set(header);
  result.set(data, header.length);
  return result;
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

async function nativeDatabaseEntries(
  records: LegacyBackupSqlRecord[] = [
    { type: "meta", formatVersion: 1, revision: 4 },
    { type: "setting", key: "language", value: "ko" },
  ],
): Promise<{ fragment: Uint8Array; manifest: Uint8Array }> {
  const counts: Record<string, number> = {};
  for (const record of records)
    counts[record.type] = (counts[record.type] ?? 0) + 1;
  const fragment = await encodeLegacyBackupDatabase({
    format: "risu-portable-database-fragment",
    version: 1,
    index: 1,
    records,
  });
  const manifest: PortableDatabaseStreamManifest = {
    format: "risu-portable-database-stream",
    version: 1,
    revision: 4,
    totalFragments: 1,
    totalRecords: records.length,
    counts,
    complete: true,
  };
  return {
    fragment: framed("database.stream/000000000001.risudat", fragment),
    manifest: framed(
      "database.stream/manifest.risudat",
      await encodeLegacyBackupDatabase(manifest),
    ),
  };
}

interface RestoreState {
  activeAssets: Map<string, number[]>;
  activeRecords: LegacyBackupSqlRecord[];
  activeCold: Map<string, unknown>;
  pendingAssets: Map<string, number[]>;
  aborted: number;
  completed: number;
  writesInFlight: number;
  maxWritesInFlight: number;
  failComplete?: boolean;
}

function restoreState(): RestoreState {
  return {
    activeAssets: new Map([["assets/old.png", [9]]]),
    activeRecords: [{ type: "setting", key: "old", value: true }],
    activeCold: new Map(),
    pendingAssets: new Map(),
    aborted: 0,
    completed: 0,
    writesInFlight: 0,
    maxWritesInFlight: 0,
  };
}

function transactionalAdapter(state: RestoreState): LocalBackupImportAdapter {
  return {
    async beginRestore(): Promise<LocalBackupImportRestoreSession> {
      const records: LegacyBackupSqlRecord[] = [];
      const cold = new Map<string, unknown>();
      let aborted = false;
      return {
        async stageDatabaseRecords(batch): Promise<void> {
          records.push(...batch);
        },
        async stageColdStorage(key, value): Promise<void> {
          cold.set(key, value);
        },
        async openAsset(key, expectedSize) {
          const bytes: number[] = [];
          state.pendingAssets.set(key, bytes);
          return {
            async write(chunk): Promise<void> {
              state.writesInFlight++;
              state.maxWritesInFlight = Math.max(
                state.maxWritesInFlight,
                state.writesInFlight,
              );
              await Promise.resolve();
              bytes.push(...chunk);
              state.writesInFlight--;
            },
            async close(): Promise<void> {
              if (bytes.length !== expectedSize) {
                throw new Error("mock asset size mismatch");
              }
            },
            async abort(): Promise<void> {
              state.pendingAssets.delete(key);
            },
          };
        },
        async complete(
          prepared: LocalBackupImportPreparedState,
        ): Promise<{ revision: number; recordCount: number }> {
          if (state.failComplete) throw new Error("database commit failed");
          expect(prepared.databaseRecordCount).toBe(records.length);
          state.activeAssets = new Map(state.pendingAssets);
          state.activeRecords = [...records];
          state.activeCold = new Map(cold);
          state.pendingAssets.clear();
          state.completed++;
          return { revision: 7, recordCount: records.length };
        },
        async abort(): Promise<void> {
          if (aborted) return;
          aborted = true;
          state.pendingAssets.clear();
          state.aborted++;
        },
      };
    },
  };
}

async function makeService(
  id: string,
  adapter: LocalBackupImportAdapter,
  withUploads = false,
  idleTimeoutMs?: number,
): Promise<{
  root: string;
  service: LocalBackupImportService;
  uploads?: BackupImportUploadStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-import-service-"));
  roots.push(root);
  const uploads = withUploads
    ? new BackupImportUploadStore(path.join(root, "uploads"))
    : undefined;
  return {
    root,
    uploads,
    service: new LocalBackupImportService(
      new LocalBackupImportJobStore(60_000, () => id),
      new BackupImportStagingStore(path.join(root, "entries")),
      adapter,
      uploads,
      { idleTimeoutMs },
    ),
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("LocalBackupImportService streaming restore", () => {
  it("streams asset bytes through the restore adapter and completes the database", async () => {
    const state = restoreState();
    const { root, service } = await makeService(
      "import_success",
      transactionalAdapter(state),
    );
    const job = service.createJob();
    const database = await nativeDatabaseEntries();
    const inlay = await encodeInlayAssetBackup({
      data: "payload",
      ext: "png",
      name: "Inlay",
      type: "image",
    });
    const parts = [
      database.fragment,
      framed(
        "coldstorage_11111111-1111-1111-1111-111111111111.json",
        new TextEncoder().encode('{"character":[]}'),
      ),
      framed("assets/a.png", new Uint8Array([1, 2, 3, 4, 5, 6])),
      framed("inlay_22222222-2222-2222-2222-222222222222.risuinlay", inlay),
      database.manifest,
    ];
    const total = parts.reduce((sum, part) => sum + part.length, 0);

    await expect(
      service.importStream(job.id, chunked(parts, 3), {
        totalBytes: total,
        sourceClientId: "client-1",
      }),
    ).resolves.toMatchObject({
      status: "complete",
      revision: 7,
      recordCount: 2,
    });

    expect(state.completed).toBe(1);
    expect(state.activeAssets.get("assets/a.png")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      state.activeAssets.get(
        "inlay_22222222-2222-2222-2222-222222222222.risuinlay",
      ),
    ).toEqual([...inlay]);
    expect(state.activeRecords).toHaveLength(2);
    expect(
      state.activeCold.get("11111111-1111-1111-1111-111111111111"),
    ).toEqual({
      character: [],
    });
    expect(state.maxWritesInFlight).toBe(1);
    await expect(fs.readdir(path.join(root, "entries"))).resolves.toEqual([]);
  });

  it("does not activate streamed assets when a later database fragment is malformed", async () => {
    const state = restoreState();
    const { service } = await makeService(
      "import_bad_late_db",
      transactionalAdapter(state),
    );
    const job = service.createJob();
    const database = await nativeDatabaseEntries();
    const corruptLaterFragment = framed(
      "database.stream/000000000002.risudat",
      new Uint8Array([1, 2, 3]),
    );

    await expect(
      service.importStream(
        job.id,
        chunked([
          database.fragment,
          framed("assets/new.png", new Uint8Array([7, 8, 9])),
          corruptLaterFragment,
        ]),
      ),
    ).rejects.toThrow();

    expect(state.activeAssets).toEqual(new Map([["assets/old.png", [9]]]));
    expect(state.activeRecords).toEqual([
      { type: "setting", key: "old", value: true },
    ]);
    expect(state.pendingAssets.size).toBe(0);
    expect(state.aborted).toBe(1);
  });

  it("aborts adapter-managed pending assets when final database commit fails", async () => {
    const state = restoreState();
    state.failComplete = true;
    const { service } = await makeService(
      "import_commit_fail",
      transactionalAdapter(state),
    );
    const job = service.createJob();
    const database = await nativeDatabaseEntries();

    await expect(
      service.importStream(
        job.id,
        chunked([
          database.fragment,
          framed("assets/new.png", new Uint8Array([1, 2])),
          database.manifest,
        ]),
      ),
    ).rejects.toThrow("database commit failed");
    expect(state.activeAssets).toEqual(new Map([["assets/old.png", [9]]]));
    expect(state.pendingAssets.size).toBe(0);
    expect(state.aborted).toBe(1);
  });

  it("restores the legacy aggregate database compatibility path", async () => {
    const state = restoreState();
    const { service } = await makeService(
      "import_legacy",
      transactionalAdapter(state),
    );
    const job = service.createJob();
    const legacy = await encodeLegacyBackupDatabase({
      language: "ko",
      characters: [],
    });
    await expect(
      service.importStream(
        job.id,
        chunked([framed("database.risudat", legacy)]),
      ),
    ).resolves.toMatchObject({ status: "complete", recordCount: 2 });
    expect(state.activeRecords).toContainEqual({
      type: "setting",
      key: "language",
      value: "ko",
    });
  });

  it("preserves chunk resume and does not parse an accepted replay twice", async () => {
    const state = restoreState();
    const { root, service } = await makeService(
      "import_chunked",
      transactionalAdapter(state),
      true,
    );
    const job = service.createJob();
    const database = await nativeDatabaseEntries();
    const payloadParts = [
      database.fragment,
      framed("assets/new.png", new Uint8Array([3, 4, 5])),
      database.manifest,
    ];
    const payload = new Uint8Array(
      payloadParts.reduce((sum, part) => sum + part.length, 0),
    );
    let cursor = 0;
    for (const part of payloadParts) {
      payload.set(part, cursor);
      cursor += part.length;
    }
    const split = Math.floor(payload.length / 2);
    const first = payload.subarray(0, split);

    await service.appendUploadChunk(
      job.id,
      0,
      chunked([first], 5),
      payload.length,
    );
    await service.appendUploadChunk(
      job.id,
      0,
      chunked([first], 7),
      payload.length,
    );
    await service.appendUploadChunk(
      job.id,
      split,
      chunked([payload.subarray(split)], 9),
      payload.length,
    );
    await expect(
      Promise.all([
        service.finalizeUpload(job.id),
        service.finalizeUpload(job.id),
      ]),
    ).resolves.toEqual([
      expect.objectContaining({ status: "complete", revision: 7 }),
      expect.objectContaining({ status: "complete", revision: 7 }),
    ]);
    await expect(service.finalizeUpload(job.id)).resolves.toMatchObject({
      status: "complete",
      revision: 7,
    });
    expect(state.completed).toBe(1);
    expect(state.activeAssets.get("assets/new.png")).toEqual([3, 4, 5]);
    await expect(fs.readdir(path.join(root, "uploads"))).resolves.toEqual([]);
  });

  it("cancellation aborts the current asset writer", async () => {
    const state = restoreState();
    const { service } = await makeService(
      "import_cancel",
      transactionalAdapter(state),
      true,
    );
    const job = service.createJob();
    const header = createLocalBackupEntryHeader("assets/large.bin", 100);
    const partial = new Uint8Array(header.length + 3);
    partial.set(header);
    partial.set([1, 2, 3], header.length);
    await service.appendUploadChunk(
      job.id,
      0,
      chunked([partial]),
      partial.length + 97,
    );
    expect(state.pendingAssets.get("assets/large.bin")).toEqual([1, 2, 3]);
    await service.cancel(job.id);
    expect(state.pendingAssets.size).toBe(0);
    expect(state.activeAssets).toEqual(new Map([["assets/old.png", [9]]]));
  });

  it("aborts the current destination when finalize finds a truncated entry", async () => {
    const state = restoreState();
    const { service } = await makeService(
      "import_truncated",
      transactionalAdapter(state),
      true,
    );
    const job = service.createJob();
    const header = createLocalBackupEntryHeader("assets/large.bin", 100);
    const partial = new Uint8Array(header.length + 3);
    partial.set(header);
    partial.set([1, 2, 3], header.length);
    await service.appendUploadChunk(
      job.id,
      0,
      chunked([partial]),
      partial.length,
    );

    await expect(service.finalizeUpload(job.id)).rejects.toThrow(
      "incomplete entry",
    );
    expect(state.pendingAssets.size).toBe(0);
    expect(state.aborted).toBe(1);
    expect(state.activeAssets).toEqual(new Map([["assets/old.png", [9]]]));
  });

  it("expires an abandoned resumable upload and cleans adapter state", async () => {
    const state = restoreState();
    const { service } = await makeService(
      "import_idle",
      transactionalAdapter(state),
      true,
      10,
    );
    const job = service.createJob();
    const header = createLocalBackupEntryHeader("assets/large.bin", 100);
    const partial = new Uint8Array(header.length + 3);
    partial.set(header);
    partial.set([1, 2, 3], header.length);
    await service.appendUploadChunk(
      job.id,
      0,
      chunked([partial]),
      partial.length + 97,
    );

    await expect.poll(() => state.aborted).toBe(1);
    expect(state.pendingAssets.size).toBe(0);
    expect(() => service.progress(job.id)).toThrow("not found or expired");
  });

  it("bounds whole-save import concurrency to one active stream", async () => {
    const state = restoreState();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "risu-import-service-"),
    );
    roots.push(root);
    let id = 0;
    const service = new LocalBackupImportService(
      new LocalBackupImportJobStore(60_000, () => `import_limit_${++id}`),
      new BackupImportStagingStore(path.join(root, "entries")),
      transactionalAdapter(state),
      new BackupImportUploadStore(path.join(root, "uploads")),
    );
    const first = service.createJob();
    const second = service.createJob();
    const header = createLocalBackupEntryHeader("assets/large.bin", 100);
    await service.appendUploadChunk(
      first.id,
      0,
      chunked([header]),
      header.length + 100,
    );

    await expect(
      service.appendUploadChunk(
        second.id,
        0,
        chunked([new Uint8Array([1])]),
        1,
      ),
    ).rejects.toThrow("already active");
    expect(service.hasActiveImports()).toBe(true);

    await service.cancel(first.id);
    await service.cancel(second.id);
    expect(service.hasActiveImports()).toBe(false);
  });

  it("waits for an in-flight commit instead of rolling it back", async () => {
    const state = restoreState();
    const base = transactionalAdapter(state);
    let announceCommit!: () => void;
    let releaseCommit!: () => void;
    const commitStarted = new Promise<void>((resolve) => {
      announceCommit = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const adapter: LocalBackupImportAdapter = {
      async beginRestore(id) {
        const restore = await base.beginRestore(id);
        return {
          ...restore,
          async complete(prepared, sourceClientId) {
            announceCommit();
            await commitGate;
            return await restore.complete(prepared, sourceClientId);
          },
        };
      },
    };
    const { service } = await makeService("import_commit_cancel", adapter);
    const job = service.createJob();
    const database = await nativeDatabaseEntries();
    const importing = service.importStream(
      job.id,
      chunked([
        database.fragment,
        framed("assets/new.png", new Uint8Array([4, 5, 6])),
        database.manifest,
      ]),
    );
    await commitStarted;
    const cancelling = service.cancel(job.id);
    releaseCommit();

    await expect(importing).resolves.toMatchObject({
      status: "complete",
      revision: 7,
    });
    await expect(cancelling).resolves.toBeUndefined();
    expect(state.completed).toBe(1);
    expect(state.aborted).toBe(0);
    expect(state.activeAssets.get("assets/new.png")).toEqual([4, 5, 6]);
  });

  it("rejects a missing database without activating pending assets", async () => {
    const state = restoreState();
    const { service } = await makeService(
      "import_no_db",
      transactionalAdapter(state),
    );
    const job = service.createJob();
    await expect(
      service.importStream(
        job.id,
        chunked([framed("assets/new.png", new Uint8Array([1]))]),
      ),
    ).rejects.toThrow("does not contain a database");
    expect(state.activeAssets).toEqual(new Map([["assets/old.png", [9]]]));
    expect(state.aborted).toBe(1);
  });
});
