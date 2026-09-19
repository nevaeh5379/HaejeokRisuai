import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ENCRYPTION_ENTRY_NAME,
  classifyBackupEntry,
  LEGACY_DATABASE_ENTRY_NAME,
} from "./entryPolicy";

describe("backup entry format names", () => {
  it("keeps legacy database and encryption entry names stable", () => {
    expect(LEGACY_DATABASE_ENTRY_NAME).toBe("database.risudat");
    expect(ACCOUNT_ENCRYPTION_ENTRY_NAME).toBe("encryption.risudat");
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
