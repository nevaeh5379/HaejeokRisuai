import { describe, expect, it } from "vitest";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS,
  PORTABLE_DATABASE_STREAM_PREFIX,
  PORTABLE_DATABASE_STREAM_VERSION,
  parsePortableDatabaseStreamFragment,
  parsePortableDatabaseStreamFragmentName,
  parsePortableDatabaseStreamManifest,
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

describe("parsePortableDatabaseStreamManifest", () => {
  const validManifest = {
    format: "risu-portable-database-stream",
    version: 1,
    revision: 7,
    totalFragments: 2,
    totalRecords: 5,
    counts: { setting: 3, message: 2 },
    complete: true,
  };

  it("returns the manifest when the shape is valid", () => {
    expect(parsePortableDatabaseStreamManifest(validManifest)).toEqual(
      validManifest,
    );
  });

  it("returns null for non-object and malformed payloads", () => {
    expect(parsePortableDatabaseStreamManifest(null)).toBeNull();
    expect(parsePortableDatabaseStreamManifest(undefined)).toBeNull();
    expect(parsePortableDatabaseStreamManifest("manifest")).toBeNull();
    expect(parsePortableDatabaseStreamManifest([])).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({ ...validManifest, format: "nope" }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({ ...validManifest, version: 2 }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({
        ...validManifest,
        complete: false,
      }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({ ...validManifest, revision: -1 }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({ ...validManifest, revision: 1.5 }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({
        ...validManifest,
        totalFragments: 0,
      }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({
        ...validManifest,
        totalRecords: 0,
      }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamManifest({ ...validManifest, counts: null }),
    ).toBeNull();
  });

  it("tolerates empty and unknown-key counts objects", () => {
    expect(
      parsePortableDatabaseStreamManifest({
        ...validManifest,
        counts: {},
      }),
    ).toEqual({ ...validManifest, counts: {} });
    expect(
      parsePortableDatabaseStreamManifest({
        ...validManifest,
        counts: { unknownType: 0 },
      }),
    ).not.toBeNull();
  });
});

describe("parsePortableDatabaseStreamFragment", () => {
  const validFragment = {
    format: "risu-portable-database-fragment",
    version: 1,
    index: 3,
    records: [
      { type: "meta", formatVersion: 1, revision: 7 },
      { type: "setting", key: "k", value: 1 },
    ],
  };

  it("returns the fragment when the shape is valid", () => {
    expect(parsePortableDatabaseStreamFragment(validFragment)).toEqual(
      validFragment,
    );
  });

  it("enforces the expected index when provided", () => {
    expect(
      parsePortableDatabaseStreamFragment(validFragment, { expectedIndex: 3 }),
    ).toEqual(validFragment);
    expect(
      parsePortableDatabaseStreamFragment(validFragment, { expectedIndex: 4 }),
    ).toBeNull();
  });

  it("returns null for malformed fragments", () => {
    expect(parsePortableDatabaseStreamFragment(null)).toBeNull();
    expect(parsePortableDatabaseStreamFragment("fragment")).toBeNull();
    expect(
      parsePortableDatabaseStreamFragment({ ...validFragment, format: "nope" }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamFragment({ ...validFragment, version: 2 }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamFragment({ ...validFragment, index: 0 }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamFragment({ ...validFragment, index: 4.5 }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamFragment({ ...validFragment, records: [] }),
    ).toBeNull();
    expect(
      parsePortableDatabaseStreamFragment({
        ...validFragment,
        records: undefined as unknown as unknown[],
      }),
    ).toBeNull();
  });

  it("rejects fragments exceeding the shared max record bound", () => {
    const oversized = {
      ...validFragment,
      records: Array.from(
        { length: PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS + 1 },
        () => ({ type: "setting", key: "k", value: 1 }),
      ),
    };
    expect(parsePortableDatabaseStreamFragment(oversized)).toBeNull();
    const atBound = {
      ...validFragment,
      records: Array.from(
        { length: PORTABLE_DATABASE_STREAM_MAX_FRAGMENT_RECORDS },
        () => ({ type: "setting", key: "k", value: 1 }),
      ),
    };
    expect(parsePortableDatabaseStreamFragment(atBound)).toEqual(atBound);
  });

  it("preserves the record references without copying payloads", () => {
    const records = [{ type: "setting", key: "k", value: 1 }];
    const parsed = parsePortableDatabaseStreamFragment({
      format: "risu-portable-database-fragment",
      version: 1,
      index: 1,
      records,
    });
    expect(parsed?.records[0]).toBe(records[0]);
  });
});
