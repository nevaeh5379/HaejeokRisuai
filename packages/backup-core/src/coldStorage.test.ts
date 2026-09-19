import { describe, expect, it } from "vitest";
import {
  COLD_STORAGE_HEADER,
  getColdStorageBackupName,
  isColdStorageBackupData,
} from "./coldStorage";
import { getColdStorageBackupKey } from "./entryPolicy";

describe("cold storage backup format", () => {
  it("shares the canonical header and backup filename", () => {
    const key = "11111111-1111-1111-1111-111111111111";
    expect(COLD_STORAGE_HEADER).toBe("\uEF01COLDSTORAGE\uEF01");
    expect(getColdStorageBackupName(key)).toBe(`coldstorage_${key}.json`);
    expect(getColdStorageBackupKey(getColdStorageBackupName(key))).toBe(key);
  });

  it("accepts supported cold storage payload shapes", () => {
    expect(isColdStorageBackupData([])).toBe(true);
    expect(isColdStorageBackupData({ character: {} })).toBe(true);
    expect(isColdStorageBackupData({ message: [] })).toBe(true);
    expect(isColdStorageBackupData({ nope: true })).toBe(false);
    expect(isColdStorageBackupData(null)).toBe(false);
  });
});
