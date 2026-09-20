import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_ENCRYPTION_ENTRY_NAME,
  classifyBackupEntry,
  getColdStorageBackupKey,
  getInlayBackupKey,
  getInlayBackupName,
  INLAY_BACKUP_PREFIX,
  INLAY_BACKUP_SUFFIX,
  LEGACY_DATABASE_ENTRY_NAME,
  normalizeBackupAssetPath,
  normalizeBackupEntryName,
} from "./entryPolicy";

describe("backup entry format names", () => {
  it("keeps legacy database and encryption entry names stable", () => {
    expect(LEGACY_DATABASE_ENTRY_NAME).toBe("database.risudat");
    expect(ACCOUNT_ENCRYPTION_ENTRY_NAME).toBe("encryption.risudat");
  });

  it("round-trips canonical inlay entry names", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const name = getInlayBackupName(id);
    expect(INLAY_BACKUP_PREFIX).toBe("inlay_");
    expect(INLAY_BACKUP_SUFFIX).toBe(".risuinlay");
    expect(name).toBe(`inlay_${id}.risuinlay`);
    expect(getInlayBackupKey(name)).toBe(id);
  });
});

describe("normalizeBackupEntryName", () => {
  it("converts Windows separators to slashes", () => {
    expect(normalizeBackupEntryName("a\\b\\c.bin")).toBe("a/b/c.bin");
  });

  it("rejects traversal, empty, and absolute segments", () => {
    for (const name of [
      "../escape.bin",
      "fork//item.bin",
      "/absolute.bin",
      "trailing/../bin",
      "a/./b.bin",
      ".hidden/..//x",
    ]) {
      expect(normalizeBackupEntryName(name)).toBeNull();
    }
    // A dot-prefixed filename segment is a valid name.
    expect(normalizeBackupEntryName("trailing/.bin")).toBe("trailing/.bin");
  });

  it("rejects non-string input", () => {
    expect(normalizeBackupEntryName(undefined as unknown as string)).toBeNull();
  });
});

describe("classifyBackupEntry kinds", () => {
  it("classifies the reserved entry names first", () => {
    expect(classifyBackupEntry(LEGACY_DATABASE_ENTRY_NAME)).toEqual({
      kind: "database",
      normalized: "database.risudat",
    });
    expect(classifyBackupEntry(ACCOUNT_ENCRYPTION_ENTRY_NAME)).toEqual({
      kind: "encryption",
      normalized: "encryption.risudat",
    });
    expect(classifyBackupEntry("database.stream/manifest.risudat")).toEqual({
      kind: "databaseStream",
      normalized: "database.stream/manifest.risudat",
    });
  });

  it("classifies numbered streaming fragments before the asset fallback", () => {
    expect(classifyBackupEntry("database.stream/000000000042.risudat")).toEqual(
      {
        kind: "databaseStream",
        normalized: "database.stream/000000000042.risudat",
      },
    );
  });

  it("classifies cold storage names with or without the coldstorage prefix", () => {
    const key = "22222222-3333-4444-8444-555555555555";
    for (const name of [
      `${key}.json`,
      `coldstorage/${key}.json`,
      `coldstorage_${key}.json`,
    ]) {
      expect(classifyBackupEntry(name)).toEqual({
        kind: "coldStorage",
        normalized: name,
      });
    }
    expect(classifyBackupEntry(`coldstorage\\${key}.json`)).toEqual({
      kind: "coldStorage",
      normalized: `coldstorage/${key}.json`,
    });
  });

  it("classifies inlay names before the bare-name asset fallback", () => {
    const id = "99999999-8888-4777-8777-666666666666";
    expect(classifyBackupEntry(getInlayBackupName(id))).toEqual({
      kind: "inlay",
      normalized: getInlayBackupName(id),
    });
  });

  it("classifies bare and assets/-prefixed names as assets", () => {
    expect(classifyBackupEntry("avatar.png")).toEqual({
      kind: "asset",
      normalized: "avatar.png",
    });
    expect(classifyBackupEntry("assets/avatar.png")).toEqual({
      kind: "asset",
      normalized: "assets/avatar.png",
    });
    expect(classifyBackupEntry("assets\\folder\\avatar.png")).toEqual({
      kind: "asset",
      normalized: "assets/folder/avatar.png",
    });
  });

  it("marks multi-segment non-reserved names as extension entries", () => {
    for (const name of [
      "docs/readme.txt",
      "extra/data.bin",
      "cold/other.json",
    ]) {
      expect(classifyBackupEntry(name)).toEqual({
        kind: "extension",
        normalized: name,
      });
    }
  });

  it("rejects unsafe names as invalid with a null normalized value", () => {
    for (const name of [
      "../escape.bin",
      "assets/../secret.png",
      "fork//item.bin",
      "/absolute.bin",
      "a/./b.bin",
      "..\\windows\\escape",
    ]) {
      expect(classifyBackupEntry(name)).toEqual({
        kind: "invalid",
        normalized: null,
      });
    }
  });

  it("does not log during classification", () => {
    const info = vi.spyOn(console, "info");
    const warn = vi.spyOn(console, "warn");
    const log = vi.spyOn(console, "log");
    classifyBackupEntry("assets/avatar.png");
    classifyBackupEntry("../escape.bin");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

describe("backup asset path resolution", () => {
  it("resolves bare, prefixed, nested, and Windows paths", () => {
    expect(normalizeBackupAssetPath("avatar.png")).toBe("assets/avatar.png");
    expect(normalizeBackupAssetPath("assets/avatar.png")).toBe(
      "assets/avatar.png",
    );
    expect(normalizeBackupAssetPath("assets/folder/avatar.png")).toBe(
      "assets/folder/avatar.png",
    );
    expect(normalizeBackupAssetPath("assets\\nested\\image.png")).toBe(
      "assets/nested/image.png",
    );
  });

  it("rejects asset paths that escape the assets directory", () => {
    expect(() => normalizeBackupAssetPath("assets")).toThrow(
      "Invalid backup asset path: assets",
    );
    expect(() => normalizeBackupAssetPath("assets/assets")).toThrow(
      "Invalid backup asset path: assets/assets",
    );
  });
});

describe("focused restore target helpers", () => {
  it("extracts inlay keys only from valid inlay entry names", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(getInlayBackupKey(getInlayBackupName(id))).toBe(id);
    expect(getInlayBackupKey("plain.bin")).toBeNull();
    expect(getInlayBackupKey("inlay_not-a-uuid.risuinlay")).toBeNull();
    expect(
      getInlayBackupKey(
        "../inlay_11111111-1111-4111-8111-111111111111.risuinlay",
      ),
    ).toBeNull();
  });

  it("extracts cold storage keys, preserving the double-backslash quirk", () => {
    const key = "33333333-4444-4555-8555-666666666666";
    for (const name of [
      `${key}.json`,
      `coldstorage/${key}.json`,
      `coldstorage_${key}.json`,
    ]) {
      expect(getColdStorageBackupKey(name)).toBe(key);
    }
    expect(getColdStorageBackupKey(`coldstorage\\\\${key}.json`)).toBe(key);
    expect(getColdStorageBackupKey(`coldstorage\\${key}.json`)).toBe(key);
  });
});
