import { describe, expect, it } from "vitest";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  portableDatabaseStreamFragmentName,
} from "./streamFormat";

describe("portable database stream format", () => {
  it("uses the canonical stream entry names", () => {
    expect(PORTABLE_DATABASE_STREAM_VERSION).toBe(1);
    expect(PORTABLE_DATABASE_STREAM_PREFIX).toBe("database.stream/");
    expect(PORTABLE_DATABASE_STREAM_MANIFEST).toBe(
      "database.stream/manifest.risudat",
    );
    expect(portableDatabaseStreamFragmentName(7)).toBe(
      "database.stream/000000000007.risudat",
    );
  });

  it("rejects invalid fragment indexes", () => {
    expect(() => portableDatabaseStreamFragmentName(0)).toThrow("positive");
    expect(() => portableDatabaseStreamFragmentName(1.5)).toThrow("positive");
  });
});
