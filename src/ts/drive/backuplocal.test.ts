import { describe, expect, it } from "vitest";
import type { Database } from "../storage/database.svelte";
import { normalizeLocalBackupAssetPath } from "./backuplocal";

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
