import { describe, expect, it } from "vitest";
import type { Database } from "../storage/database.svelte";
import {
  createNativeImportSource,
  normalizeLocalBackupAssetPath,
} from "./backuplocal";

describe("createNativeImportSource", () => {
  it("pulls bounded chunks instead of assembling the native file eagerly", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 17).map(
      (_, index) => index % 251,
    );
    const requests: Array<{ offset: number; length: number }> = [];
    const source = createNativeImportSource(
      {
        async readImportChunk({ offset, length }) {
          requests.push({ offset, length });
          const data = bytes.subarray(offset, offset + length);
          return {
            data: Buffer.from(data).toString("base64"),
            bytesRead: data.byteLength,
            eof: offset + data.byteLength >= bytes.byteLength,
          };
        },
      },
      "import-1",
      bytes.byteLength,
    );

    expect(requests).toEqual([]);
    const reader = source.stream().getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(requests.map(({ length }) => length)).toEqual([
      512 * 1024,
      512 * 1024,
      17,
    ]);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(
      Buffer.from(bytes),
    );
  });

  it("rejects mismatched native chunk metadata", async () => {
    const source = createNativeImportSource(
      {
        async readImportChunk() {
          return { data: "", bytesRead: 1, eof: true };
        },
      },
      "import-2",
      1,
    );

    await expect(source.stream().getReader().read()).rejects.toThrow(
      "incomplete chunk",
    );
  });
});

describe("normalizeLocalBackupAssetPath", () => {
  it("places Tauri backup file names under the assets directory", () => {
    expect(normalizeLocalBackupAssetPath("image.png")).toBe("assets/image.png");
  });

  it("normalizes browser backup keys and Windows separators", () => {
    expect(normalizeLocalBackupAssetPath("assets/image.png")).toBe(
      "assets/image.png",
    );
    expect(normalizeLocalBackupAssetPath("assets\\nested\\image.png")).toBe(
      "assets/nested/image.png",
    );
  });

  it.each(["", "../image.png", "assets/../image.png", "/image.png"])(
    "rejects unsafe backup asset path %j",
    (name) => {
      expect(() => normalizeLocalBackupAssetPath(name)).toThrow(
        "Invalid backup asset path",
      );
    },
  );
});

describe("backup database defaults", () => {
  it("preserves plugin custom storage during normalization", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database.svelte");
    const db = {
      pluginCustomStorage: { pm_store: { version: 5 } },
    } as unknown as Database;

    normalizeDatabaseDefaults(db);

    expect(db.pluginCustomStorage).toEqual({ pm_store: { version: 5 } });
  });

  it("initializes module folders without replacing existing folders", async () => {
    const { normalizeDatabaseDefaults } =
      await import("../storage/database.svelte");
    const emptyDb = {} as Database;
    normalizeDatabaseDefaults(emptyDb);
    expect(emptyDb.moduleFolders).toEqual([]);

    const existingDb = {
      moduleFolders: [{ id: "f1", name: "Folder 1", color: "" }],
    } as unknown as Database;
    normalizeDatabaseDefaults(existingDb);
    expect(existingDb.moduleFolders).toEqual([
      { id: "f1", name: "Folder 1", color: "" },
    ]);
  });
});
