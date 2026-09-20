import { describe, expect, it } from "vitest";
import {
  LEGACY_COMPRESSED_DATABASE_HEADER_BYTES,
  LEGACY_RAW_DATABASE_HEADER_BYTES,
  LEGACY_STREAM_COMPRESSED_DATABASE_HEADER_BYTES,
  RISU_SAVE_BLOCK_HEADER_BYTES,
} from "./legacyHeaders";

describe("legacy RisuSave headers", () => {
  it("keeps the canonical block and database header bytes stable", () => {
    expect(RISU_SAVE_BLOCK_HEADER_BYTES).toEqual([
      82, 73, 83, 85, 83, 65, 86, 69, 0,
    ]);
    expect(LEGACY_RAW_DATABASE_HEADER_BYTES.at(-1)).toBe(7);
    expect(LEGACY_COMPRESSED_DATABASE_HEADER_BYTES.at(-1)).toBe(8);
    expect(LEGACY_STREAM_COMPRESSED_DATABASE_HEADER_BYTES.at(-1)).toBe(9);
    expect(LEGACY_RAW_DATABASE_HEADER_BYTES.slice(1, -1)).toEqual([
      82, 73, 83, 85, 83, 65, 86, 69, 0,
    ]);
  });
});
