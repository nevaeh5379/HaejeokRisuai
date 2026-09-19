import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBackupEntryHeader } from "./legacyFormat";
import {
  BackupImportStagingError,
  BackupImportStagingStore,
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

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-import-stage-"));
  roots.push(root);
  return new BackupImportStagingStore(root);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("BackupImportStagingStore", () => {
  it("stages supported entries without buffering the container", async () => {
    const store = await makeStore();
    const result = await store.stage(
      "import_job_1",
      chunks([
        framed("database.risudat", new Uint8Array([1, 2, 3])),
        framed("assets/a.png", new Uint8Array([4, 5, 6, 7])),
        framed("future/extension.bin", new Uint8Array([9, 9])),
      ]),
    );

    expect(result.ignoredExtensionEntries).toBe(1);
    expect(result.entries.map((entry) => [entry.name, entry.kind])).toEqual([
      ["database.risudat", "database"],
      ["assets/a.png", "asset"],
    ]);
    expect(
      new Uint8Array(await fs.readFile(result.entries[0].filePath)),
    ).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects account-encrypted backups explicitly", async () => {
    const store = await makeStore();
    await expect(
      store.stage(
        "import_job_2",
        chunks([
          framed(
            "encryption.risudat",
            new TextEncoder().encode('{"type":"account","time":1}'),
          ),
        ]),
      ),
    ).rejects.toMatchObject({
      code: "encrypted_backup_unsupported",
    });
  });

  it("cleans staged files when parsing fails", async () => {
    const store = await makeStore();
    const invalid = framed("database.risudat", new Uint8Array([1, 2, 3]));
    await expect(
      store.stage(
        "import_job_3",
        (async function* () {
          yield invalid.subarray(0, invalid.length - 1);
        })(),
      ),
    ).rejects.toBeInstanceOf(BackupImportStagingError);
  });
});
