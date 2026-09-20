import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupImportUploadStore } from "./importUploadStore";

const roots: string[] = [];

async function makeStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "risu-upload-store-"));
  roots.push(root);
  return {
    root,
    store: new BackupImportUploadStore(root),
  };
}

async function* chunks(...values: number[][]) {
  for (const value of values) yield new Uint8Array(value);
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("BackupImportUploadStore", () => {
  it("appends sequential chunks and exposes the completed file as a stream", async () => {
    const { root, store } = await makeStore();
    const id = "import_001";

    await expect(store.append(id, 0, chunks([1, 2], [3]), 6)).resolves.toEqual({
      receivedBytes: 3,
      totalBytes: 6,
      complete: false,
    });
    await expect(store.append(id, 3, chunks([4, 5, 6]), 6)).resolves.toEqual({
      receivedBytes: 6,
      totalBytes: 6,
      complete: true,
    });

    const source = await store.finalize(id);
    const read: number[] = [];
    for await (const chunk of source.stream) {
      read.push(...chunk);
    }
    expect(source.totalBytes).toBe(6);
    expect(read).toEqual([1, 2, 3, 4, 5, 6]);
    expect(path.dirname(source.filePath)).toBe(root);
    expect(path.basename(source.filePath)).not.toContain(id);

    await store.cleanup(id);
    await expect(fs.stat(source.filePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects an unexpected offset without modifying the staged upload", async () => {
    const { store } = await makeStore();
    const id = "import_002";
    await store.append(id, 0, chunks([1, 2, 3]), 5);

    await expect(store.append(id, 2, chunks([9]), 5)).rejects.toMatchObject({
      code: "upload_offset_mismatch",
      expectedOffset: 3,
    });

    await expect(store.append(id, 3, chunks([4, 5]), 5)).resolves.toEqual({
      receivedBytes: 5,
      totalBytes: 5,
      complete: true,
    });

    const source = await store.finalize(id);
    const read: number[] = [];
    for await (const chunk of source.stream) read.push(...chunk);
    expect(read).toEqual([1, 2, 3, 4, 5]);
  });

  it("rolls back a partially received request so the same offset can retry", async () => {
    const { store } = await makeStore();
    const id = "import_003";
    await store.append(id, 0, chunks([1, 2]), 6);

    async function* broken() {
      yield new Uint8Array([3, 4]);
      throw new Error("network interrupted");
    }

    await expect(store.append(id, 2, broken(), 6)).rejects.toMatchObject({
      code: "upload_error",
    });

    await expect(store.append(id, 2, chunks([3, 4, 5, 6]), 6)).resolves.toEqual(
      {
        receivedBytes: 6,

        totalBytes: 6,
        complete: true,
      },
    );

    const source = await store.finalize(id);
    const read: number[] = [];
    for await (const chunk of source.stream) read.push(...chunk);
    expect(read).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("refuses to finalize before the declared upload is complete", async () => {
    const { store } = await makeStore();
    const id = "import_004";
    await store.append(id, 0, chunks([1, 2]), 4);

    await expect(store.finalize(id)).rejects.toMatchObject({
      code: "upload_incomplete",
      expectedOffset: 2,
    });
  });

  it("seals a completed upload against late append requests", async () => {
    const { store } = await makeStore();
    const id = "import_005";
    await store.append(id, 0, chunks([1, 2, 3]), 3);
    await store.finalize(id);

    await expect(store.append(id, 3, chunks(), 3)).rejects.toMatchObject({
      code: "upload_finalized",
    });
  });
});
