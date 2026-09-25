import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupImportUploadStore } from "./importUploadStore";

const roots: string[] = [];

async function makeStore(): Promise<{
  root: string;
  store: BackupImportUploadStore;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-upload-store-"));
  roots.push(root);
  return { root, store: new BackupImportUploadStore(root) };
}

async function* chunks(...values: number[][]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield new Uint8Array(value);
}

function consumer(target: number[], calls: { count: number }) {
  return async (source: AsyncIterable<Uint8Array>): Promise<void> => {
    calls.count++;
    for await (const chunk of source) target.push(...chunk);
  };
}

afterEach(async (): Promise<void> => {
  await Promise.all(
    roots
      .splice(0)
      .map((root: string) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("BackupImportUploadStore", (): void => {
  it("keeps only one bounded request spool and consumes it immediately", async () => {
    const { root, store } = await makeStore();
    const id = "import_001";
    const accepted: number[] = [];
    const calls = { count: 0 };
    const consume = consumer(accepted, calls);

    await store.append(id, 0, chunks([1, 2], [3]), 6, consume);
    const [directoryName] = await fs.readdir(root);
    await expect(fs.readdir(path.join(root, directoryName))).resolves.toEqual(
      [],
    );
    await store.append(id, 3, chunks([4, 5, 6]), 6, consume);
    await expect(store.finalize(id)).resolves.toEqual({
      receivedBytes: 6,
      totalBytes: 6,
      complete: true,
    });

    expect(accepted).toEqual([1, 2, 3, 4, 5, 6]);
    expect(calls.count).toBe(2);
    await store.cleanup(id);
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("accepts an identical replay after an accepted response was lost", async () => {
    const { store } = await makeStore();
    const accepted: number[] = [];
    const calls = { count: 0 };
    const consume = consumer(accepted, calls);

    await store.append("import_002", 0, chunks([1, 2, 3]), 6, consume);
    await expect(
      store.append("import_002", 0, chunks([1, 2, 3]), 6, consume),
    ).resolves.toMatchObject({ receivedBytes: 3 });
    expect(accepted).toEqual([1, 2, 3]);
    expect(calls.count).toBe(1);
  });

  it("rejects a different replay at an already accepted offset", async () => {
    const { store } = await makeStore();
    const consume = consumer([], { count: 0 });
    await store.append("import_003", 0, chunks([1, 2, 3]), 6, consume);
    await expect(
      store.append("import_003", 0, chunks([1, 2, 4]), 6, consume),
    ).rejects.toMatchObject({
      code: "upload_offset_mismatch",
      expectedOffset: 3,
    });
  });

  it("rolls back a partially received request so the offset can retry", async () => {
    const { store } = await makeStore();
    const accepted: number[] = [];
    const calls = { count: 0 };
    const consume = consumer(accepted, calls);

    async function* broken(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array([1, 2]);
      throw new Error("network interrupted");
    }
    await expect(
      store.append("import_004", 0, broken(), 4, consume),
    ).rejects.toMatchObject({ code: "upload_error" });
    expect(calls.count).toBe(0);
    await expect(
      store.append("import_004", 0, chunks([1, 2, 3, 4]), 4, consume),
    ).resolves.toMatchObject({ receivedBytes: 4, complete: true });
    expect(accepted).toEqual([1, 2, 3, 4]);
  });

  it("rejects a request larger than the configured bounded spool", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-upload-store-"));
    roots.push(root);
    const store = new BackupImportUploadStore(root, 4);
    const consume = consumer([], { count: 0 });

    await expect(
      store.append("import_009", 0, chunks([1, 2, 3], [4, 5]), 10, consume),
    ).rejects.toMatchObject({ code: "upload_request_too_large" });
    const [directoryName] = await fs.readdir(root);
    await expect(fs.readdir(path.join(root, directoryName))).resolves.toEqual(
      [],
    );
  });

  it("refuses incomplete and duplicate finalize calls", async () => {
    const { store } = await makeStore();
    const consume = consumer([], { count: 0 });
    await store.append("import_005", 0, chunks([1, 2]), 4, consume);
    await expect(store.finalize("import_005")).rejects.toMatchObject({
      code: "upload_incomplete",
      expectedOffset: 2,
    });
    await store.append("import_005", 2, chunks([3, 4]), 4, consume);
    await store.finalize("import_005");
    await expect(store.finalize("import_005")).rejects.toMatchObject({
      code: "upload_finalized",
    });
    await expect(
      store.append("import_005", 4, chunks(), 4, consume),
    ).rejects.toMatchObject({ code: "upload_finalized" });
  });
});
