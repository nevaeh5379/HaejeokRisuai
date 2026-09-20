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
  type BackupEntryClassification,
} from "./entryPolicy";
import { PORTABLE_DATABASE_STREAM_MANIFEST } from "./streamFormat";

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

  it("accepts plain names unchanged", () => {
    expect(normalizeBackupEntryName("plain.bin")).toBe("plain.bin");
    expect(normalizeBackupEntryName("a/b.bin")).toBe("a/b.bin");
  });
});

describe("classifyBackupEntry exact entries", () => {
  it("classifies the legacy database entry", () => {
    expect(classifyBackupEntry(LEGACY_DATABASE_ENTRY_NAME)).toEqual({
      kind: "database",
      normalized: "database.risudat",
    });
  });

  it("classifies the account encryption entry", () => {
    expect(classifyBackupEntry(ACCOUNT_ENCRYPTION_ENTRY_NAME)).toEqual({
      kind: "encryption",
      normalized: "encryption.risudat",
    });
  });

  it("classifies the streaming manifest without an index", () => {
    expect(classifyBackupEntry(PORTABLE_DATABASE_STREAM_MANIFEST)).toEqual({
      kind: "databaseStream",
      normalized: PORTABLE_DATABASE_STREAM_MANIFEST,
      stream: { type: "manifest" },
    });
  });

  it("classifies numbered streaming fragments with their index", () => {
    const result = classifyBackupEntry("database.stream/000000000042.risudat");
    expect(result.kind).toBe("databaseStream");
    expect(result).toMatchObject({
      normalized: "database.stream/000000000042.risudat",
      stream: { type: "fragment", index: 42 },
    });
  });

  it("rejects malformed streaming fragment names", () => {
    for (const name of [
      "database.stream/000000000042.risudatx",
      "database.stream/42.risudat",
      "database.stream/99999999999999999999.risudat",
      "database.stream/000000000042.other",
    ]) {
      const result = classifyBackupEntry(name);
      expect(result.kind).not.toBe("databaseStream");
    }
  });
});

describe("classifyBackupEntry cold storage entries", () => {
  const key = "22222222-3333-4444-8444-555555555555";

  it("extracts the key from the plain name", () => {
    expect(classifyBackupEntry(`${key}.json`)).toEqual({
      kind: "coldStorage",
      normalized: `${key}.json`,
      key,
    });
  });

  it("extracts the key from coldstorage-prefixed slash and underscore names", () => {
    expect(classifyBackupEntry(`coldstorage/${key}.json`)).toMatchObject({
      kind: "coldStorage",
      normalized: `coldstorage/${key}.json`,
      key,
    });
    expect(classifyBackupEntry(`coldstorage_${key}.json`)).toMatchObject({
      kind: "coldStorage",
      normalized: `coldstorage_${key}.json`,
      key,
    });
  });

  it("resolves keys through normalized Windows separators", () => {
    const result = classifyBackupEntry(`coldstorage\\${key}.json`);
    expect(result).toMatchObject({
      kind: "coldStorage",
      normalized: `coldstorage/${key}.json`,
      key,
    });
  });

  it("rejects malformed cold storage names", () => {
    expect(classifyBackupEntry("coldstorage/not-a-uuid.json").kind).toBe(
      "extension",
    );
    expect(classifyBackupEntry(`${key.slice(0, 8)}.json`).kind).toBe("asset");
  });
});

describe("classifyBackupEntry inlay entries", () => {
  it("extracts the inlay key", () => {
    const id = "99999999-8888-4777-8777-666666666666";
    const name = getInlayBackupName(id);
    expect(classifyBackupEntry(name)).toEqual({
      kind: "inlay",
      normalized: name,
      key: id,
    });
  });

  it("rejects malformed inlay ids as non-inlay names", () => {
    const result = classifyBackupEntry("inlay_not-a-uuid.risuinlay");
    expect(result.kind).toBe("asset");
    expect(
      classifyBackupEntry(
        `inlay_${"g".repeat(8)}-1111-4111-8111-111111111111.risuinlay`,
      ).kind,
    ).toBe("asset");
  });

  it("returns null keys from getInlayBackupKey for non-inlay names", () => {
    expect(getInlayBackupKey("plain.bin")).toBeNull();
    expect(
      getInlayBackupKey(
        "../inlay_11111111-1111-4111-8111-111111111111.risuinlay",
      ),
    ).toBeNull();
  });
});

describe("classifyBackupEntry asset entries", () => {
  it("resolves bare legacy asset names under assets/", () => {
    expect(classifyBackupEntry("avatar.png")).toEqual({
      kind: "asset",
      normalized: "avatar.png",
      assetPath: "assets/avatar.png",
    });
  });

  it("keeps already-prefixed asset paths canonical", () => {
    expect(classifyBackupEntry("assets/avatar.png")).toEqual({
      kind: "asset",
      normalized: "assets/avatar.png",
      assetPath: "assets/avatar.png",
    });
  });

  it("normalizes nested and backslash asset paths once", () => {
    expect(classifyBackupEntry("assets/folder/avatar.png")).toEqual({
      kind: "asset",
      normalized: "assets/folder/avatar.png",
      assetPath: "assets/folder/avatar.png",
    });
    expect(classifyBackupEntry("assets\\folder\\avatar.png")).toEqual({
      kind: "asset",
      normalized: "assets/folder/avatar.png",
      assetPath: "assets/folder/avatar.png",
    });
    expect(classifyBackupEntry("assets\\nested\\..\\image.png")).toEqual({
      kind: "invalid",
      normalized: null,
    });
  });

  it("collapses repeated leading assets segments", () => {
    expect(
      classifyBackupEntry("assets/assets/folder/avatar.png"),
    ).toMatchObject({
      kind: "asset",
      assetPath: "assets/folder/avatar.png",
    });
  });
});

describe("classifyBackupEntry security and fallback edges", () => {
  it("rejects unsafe names as invalid with no normalized value", () => {
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

  it("throws for asset names whose resolved path is unsafe", () => {
    expect(() => classifyBackupEntry("assets")).toThrow(
      "Invalid backup asset path: assets",
    );
    expect(() => classifyBackupEntry("assets/assets")).toThrow(
      "Invalid backup asset path: assets/assets",
    );
  });

  it("keeps prototype-named entries out of the exact-rule lookup", () => {
    for (const name of ["constructor", "toString", "__proto__"]) {
      expect(classifyBackupEntry(name)).toEqual({
        kind: "asset",
        normalized: name,
        assetPath: `assets/${name}`,
      });
    }
  });

  it("matches getColdStorageBackupKey results from the classification key", () => {
    const key = "33333333-4444-4555-8555-666666666666";
    for (const name of [
      `${key}.json`,
      `coldstorage/${key}.json`,
      `coldstorage_${key}.json`,
    ]) {
      const result = classifyBackupEntry(name);
      expect(result.kind === "coldStorage" && result.key).toBe(
        getColdStorageBackupKey(name),
      );
    }
    // Double-backslash quirk of the standalone helper is preserved.
    expect(getColdStorageBackupKey(`coldstorage\\\\${key}.json`)).toBe(key);
    expect(classifyBackupEntry(`coldstorage\\\\${key}.json`).kind).toBe(
      "invalid",
    );
  });
});

describe("classifyBackupEntry compatibility", () => {
  it("keeps kind and normalized on every variant", () => {
    const results: BackupEntryClassification[] = [
      classifyBackupEntry(LEGACY_DATABASE_ENTRY_NAME),
      classifyBackupEntry("database.stream/000000000001.risudat"),
      classifyBackupEntry(ACCOUNT_ENCRYPTION_ENTRY_NAME),
      classifyBackupEntry(`${"44444444-4444-4555-8555-666666666666"}.json`),
      classifyBackupEntry(
        getInlayBackupName("44444444-4444-4555-8555-666666666666"),
      ),
      classifyBackupEntry("assets/x.png"),
      classifyBackupEntry("extras/x.bin"),
    ];
    for (const result of results) {
      expect(typeof result.kind).toBe("string");
      expect(typeof result.normalized).toBe("string");
    }
    expect(classifyBackupEntry("../bad").normalized).toBeNull();
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
