import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeInlayAssetBackup } from "../inlayCodec";
import { createLocalBackupEntryHeader } from "./legacyFormat";
import { LocalBackupImportJobStore } from "./importJobStore";
import { BackupImportStagingStore } from "./importStagingStore";
import {
  LocalBackupImportService,
  type LocalBackupImportAdapter,
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
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
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
      async restoreDatabase(plan, sourceClientId, onProgress) {
        order.push("database");
        expect(plan.databaseMode).toBe("legacy");
        expect(plan.legacyDatabase?.name).toBe("database.risudat");
        expect(sourceClientId).toBe("client-1");
        onProgress(11, 11, "database.risudat");
        observedStages.push(service.progress("import_001").progress.stage);
        return { revision: 7, recordCount: 11 };
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
    const parts = [
      framed("database.risudat", new Uint8Array([1, 2, 3])),
      framed(
        "coldstorage_11111111-1111-1111-1111-111111111111.json",
        new TextEncoder().encode('{"character":[]}'),
      ),
      framed("assets/a.png", new Uint8Array([4, 5])),
      framed(
        "inlay_22222222-2222-2222-2222-222222222222.risuinlay",
        inlay,
      ),
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
      recordCount: 11,
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
      async restoreDatabase() {
        throw new Error("database restore failed");
      },
    };
    const service = new LocalBackupImportService(jobs, staging, adapter);
    const job = service.createJob();
    const payload = framed(
      "database.risudat",
      new Uint8Array([1, 2, 3]),
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

  it("preserves encrypted-backup rejection and marks the job failed", async () => {
    const { root, jobs, staging } = await makeStores("import_003");
    const adapter: LocalBackupImportAdapter = {
      async writeColdStorage() {},
      async writeAsset() {},
      async restoreDatabase() {
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
});
