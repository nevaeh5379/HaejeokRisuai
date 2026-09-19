import { describe, expect, it } from "vitest";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  parsePortableDatabaseStreamFragmentName,
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

  it("parses only canonical positive fragment names", () => {
    expect(
      parsePortableDatabaseStreamFragmentName(
        "database.stream/000000000007.risudat",
      ),
    ).toBe(7);
    expect(
      parsePortableDatabaseStreamFragmentName(
        "database.stream/000000000000.risudat",
      ),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamFragmentName("database.stream/7.risudat"),
    ).toBeNull();
  });

  it("rejects invalid fragment indexes", () => {
    expect(() => portableDatabaseStreamFragmentName(0)).toThrow("positive");
    expect(() => portableDatabaseStreamFragmentName(1.5)).toThrow("positive");
  });
});
