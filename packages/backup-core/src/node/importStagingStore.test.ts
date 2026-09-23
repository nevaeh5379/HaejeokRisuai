import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBackupEntryHeader } from "./legacyFormat";
import {
  BACKUP_IMPORT_MAX_NATIVE_DATABASE_ENTRY_BYTES,
  BackupImportStagingError,
  BackupImportStagingStore,
  type BackupImportEntryWriter,
  type BufferedBackupEntry,
} from "./importStagingStore";

const roots: string[] = [];

function framed(name: string, data: Uint8Array): Uint8Array {
  const header = createLocalBackupEntryHeader(name, data.length);
  const result = new Uint8Array(header.length + data.length);
  result.set(header);
  result.set(data, header.length);
  return result;
}

async function* chunks(parts: Uint8Array[], size = 7) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const all = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  for (let cursor = 0; cursor < all.length; cursor += size) {
    yield all.subarray(cursor, Math.min(all.length, cursor + size));
  }
}

async function makeStore(): Promise<{
  root: string;
  store: BackupImportStagingStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-import-stage-"));
  roots.push(root);
  return { root, store: new BackupImportStagingStore(root) };
}

function memoryWriter(target: number[]): BackupImportEntryWriter {
  return {
    async write(chunk): Promise<void> {
      target.push(...chunk);
    },
    async close(): Promise<void> {},
    async abort(): Promise<void> {},
  };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("BackupImportStagingStore", () => {
  it("streams assets while retaining only the current buffered entry", async () => {
    const { root, store } = await makeStore();
    const buffered: Array<{ name: string; data: number[] }> = [];
    const asset: number[] = [];
    const session = await store.createSession("import_job_1", {
      async onBufferedEntry(entry: BufferedBackupEntry): Promise<void> {
        const directories = await fs.readdir(root);
        expect(directories).toHaveLength(1);
        const files = await fs.readdir(path.join(root, directories[0]));
        expect(files).toEqual(["current-entry.part"]);
        buffered.push({
          name: entry.name,
          data: [...new Uint8Array(await fs.readFile(entry.filePath))],
        });
      },
      async openAssetEntry(): Promise<BackupImportEntryWriter> {
        return memoryWriter(asset);
      },
    });

    await session.writeAll(
      chunks([
        framed("database.risudat", new Uint8Array([1, 2, 3])),
        framed("assets/a.png", new Uint8Array([4, 5, 6, 7])),
        framed("future/extension.bin", new Uint8Array([9, 9])),
      ]),
    );
    await expect(session.finish()).resolves.toMatchObject({
      entriesHandled: 2,
      ignoredExtensionEntries: 1,
    });
    expect(buffered).toEqual([{ name: "database.risudat", data: [1, 2, 3] }]);
    expect(asset).toEqual([4, 5, 6, 7]);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("keeps scratch usage bounded while a much larger logical asset set streams", async () => {
    const { root, store } = await makeStore();
    const assetCount = 128;
    const assetBody = new Uint8Array(128 * 1024).fill(7);
    let streamedAssetBytes = 0;
    let maxScratchBytes = 0;
    const inspectScratch = async (): Promise<void> => {
      const directories = await fs.readdir(root);
      for (const directory of directories) {
        const directoryPath = path.join(root, directory);
        for (const file of await fs.readdir(directoryPath)) {
          maxScratchBytes = Math.max(
            maxScratchBytes,
            (await fs.stat(path.join(directoryPath, file))).size,
          );
        }
      }
    };
    const session = await store.createSession("import_job_large", {
      async onBufferedEntry(): Promise<void> {
        await inspectScratch();
      },
      async openAssetEntry(): Promise<BackupImportEntryWriter> {
        return {
          async write(chunk): Promise<void> {
            streamedAssetBytes += chunk.byteLength;
          },
          async close(): Promise<void> {
            await inspectScratch();
          },
          async abort(): Promise<void> {},
        };
      },
    });

    async function* logicalBackup(): AsyncGenerator<Uint8Array> {
      yield framed("database.risudat", new Uint8Array([1, 2, 3]));
      for (let index = 0; index < assetCount; index++) {
        yield createLocalBackupEntryHeader(
          `assets/${String(index).padStart(4, "0")}.bin`,
          assetBody.byteLength,
        );
        yield assetBody;
      }
    }

    await session.writeAll(logicalBackup());
    await session.finish();
    expect(streamedAssetBytes).toBe(assetCount * assetBody.byteLength);
    expect(streamedAssetBytes).toBeGreaterThan(16 * 1024 * 1024 - 1);
    expect(maxScratchBytes).toBe(3);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects account-encrypted backups explicitly", async () => {
    const { store } = await makeStore();
    const session = await store.createSession("import_job_2", {
      async onBufferedEntry() {},
      async openAssetEntry() {
        return memoryWriter([]);
      },
    });
    await expect(
      session.writeAll(
        chunks([
          framed(
            "encryption.risudat",
            new TextEncoder().encode('{"type":"account","time":1}'),
          ),
        ]),
      ),
    ).rejects.toMatchObject({ code: "encrypted_backup_unsupported" });
    await session.abort();
  });

  it("rejects duplicate names before opening a second destination", async () => {
    const { store } = await makeStore();
    let opened = 0;
    const session = await store.createSession("import_job_3", {
      async onBufferedEntry() {},
      async openAssetEntry() {
        opened++;
        return memoryWriter([]);
      },
    });
    await expect(
      session.writeAll(
        chunks([
          framed("assets/a.png", new Uint8Array([1])),
          framed("assets/a.png", new Uint8Array([2])),
        ]),
      ),
    ).rejects.toBeInstanceOf(BackupImportStagingError);
    expect(opened).toBe(1);
    await session.abort();
  });

  it("cleans current-entry scratch space when parsing is aborted", async () => {
    const { root, store } = await makeStore();
    const session = await store.createSession("import_job_4", {
      async onBufferedEntry() {},
      async openAssetEntry() {
        return memoryWriter([]);
      },
    });
    const invalid = framed("database.risudat", new Uint8Array([1, 2, 3]));
    await session.write(invalid.subarray(0, invalid.length - 1));
    await expect(session.finish()).rejects.toThrow("incomplete entry");
    await session.abort();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("rejects an oversized buffered entry from its header without receiving the body", async () => {
    const { root, store } = await makeStore();
    const session = await store.createSession("import_job_5", {
      async onBufferedEntry() {},
      async openAssetEntry() {
        return memoryWriter([]);
      },
    });
    const header = createLocalBackupEntryHeader(
      "database.stream/000000000001.risudat",
      BACKUP_IMPORT_MAX_NATIVE_DATABASE_ENTRY_BYTES + 1,
    );

    await expect(session.write(header)).rejects.toMatchObject({
      code: "buffered_entry_too_large",
    });
    await session.abort();
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });
});
