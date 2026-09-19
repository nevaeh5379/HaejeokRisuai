import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ENCRYPTION_ENTRY_NAME,
  classifyBackupEntry,
  getInlayBackupKey,
  getInlayBackupName,
  INLAY_BACKUP_PREFIX,
  LEGACY_DATABASE_ENTRY_NAME,
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
    expect(name).toBe(`inlay_${id}.risuinlay`);
    expect(getInlayBackupKey(name)).toBe(id);
  });

  it("classifies the centralized entry names", () => {
    expect(classifyBackupEntry(LEGACY_DATABASE_ENTRY_NAME).kind).toBe(
      "database",
    );
    expect(classifyBackupEntry(ACCOUNT_ENCRYPTION_ENTRY_NAME).kind).toBe(
      "encryption",
    );
  });
});
