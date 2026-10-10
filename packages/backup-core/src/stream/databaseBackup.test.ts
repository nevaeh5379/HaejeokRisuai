import { describe, expect, it } from "vitest";
import type { LegacyBackupSqlRecord } from "../legacyRecords.ts";
import {
  MANIFEST_NAME,
  MAX_FRAGMENT_RECORDS,
  PREFIX,
  Fragment,
  Manifest,
} from "./databaseBackup.ts";

describe("portable database stream format", (): void => {
  it("uses the canonical stream entry names", (): void => {
    expect(PREFIX).toBe("database.stream/");
    expect(MANIFEST_NAME).toBe("database.stream/manifest.risudat");
    expect(Fragment.name(7)).toBe("database.stream/000000000007.risudat");
  });

  it("parses only canonical positive fragment names", (): void => {
    expect(Fragment.parseName("database.stream/000000000007.risudat")).toBe(7);
    expect(
      Fragment.parseName("database.stream/000000000000.risudat"),
    ).toBeNull();
    expect(Fragment.parseName("database.stream/7.risudat")).toBeNull();
  });

  it("rejects invalid fragment indexes", (): void => {
    expect(() => Fragment.name(0)).toThrow("positive");
    expect(() => Fragment.name(1.5)).toThrow("positive");
  });
});

describe("Manifest.read", (): void => {
  const validManifest: Manifest = {
    format: "risu-portable-database-stream",
    revision: 7,
    totalFragments: 2,
    totalRecords: 5,
    counts: { setting: 3, message: 2 },
    complete: true,
  };

  it("returns the manifest when the shape is valid", (): void => {
    expect(Manifest.read(validManifest)).toEqual(validManifest);
  });

  it("returns null for non-object and malformed payloads", (): void => {
    expect(Manifest.read(null)).toBeNull();
    expect(Manifest.read(undefined)).toBeNull();
    expect(Manifest.read("manifest")).toBeNull();
    expect(Manifest.read([])).toBeNull();
    expect(Manifest.read({ ...validManifest, format: "nope" })).toBeNull();
    expect(
      Manifest.read({
        ...validManifest,
        complete: false,
      }),
    ).toBeNull();
    expect(Manifest.read({ ...validManifest, revision: -1 })).toBeNull();
    expect(Manifest.read({ ...validManifest, revision: 1.5 })).toBeNull();
    expect(
      Manifest.read({
        ...validManifest,
        totalFragments: 0,
      }),
    ).toBeNull();
    expect(
      Manifest.read({
        ...validManifest,
        totalRecords: 0,
      }),
    ).toBeNull();
    expect(Manifest.read({ ...validManifest, counts: null })).toBeNull();
  });

  it("tolerates empty and unknown-key counts objects", (): void => {
    expect(
      Manifest.read({
        ...validManifest,
        counts: {},
      }),
    ).toEqual({ ...validManifest, counts: {} });
    expect(
      Manifest.read({
        ...validManifest,
        counts: { unknownType: 0 },
      }),
    ).not.toBeNull();
  });
});

describe("Fragment.read", (): void => {
  const validFragment: Fragment = {
    format: "risu-portable-database-fragment",
    index: 3,
    records: [
      { type: "meta", formatVersion: 1, revision: 7 },
      { type: "setting", key: "k", value: 1 },
    ],
  };

  it("returns the fragment when the shape is valid", (): void => {
    expect(Fragment.read(validFragment)).toEqual(validFragment);
  });

  it("enforces the expected index when provided", (): void => {
    expect(Fragment.read(validFragment, { expectedIndex: 3 })).toEqual(
      validFragment,
    );
    expect(Fragment.read(validFragment, { expectedIndex: 4 })).toBeNull();
  });

  it("returns null for malformed fragments", (): void => {
    expect(Fragment.read(null)).toBeNull();
    expect(Fragment.read("fragment")).toBeNull();
    const wrongFormat: Record<string, unknown> = {
      ...validFragment,
      format: "nope",
    };
    expect(Fragment.read(wrongFormat)).toBeNull();
    const zeroIndex: Record<string, unknown> = {
      ...validFragment,
      index: 0,
    };
    expect(Fragment.read(zeroIndex)).toBeNull();
    const fractionalIndex: Record<string, unknown> = {
      ...validFragment,
      index: 4.5,
    };
    expect(Fragment.read(fractionalIndex)).toBeNull();
    const emptyRecords: Record<string, unknown> = {
      ...validFragment,
      records: [],
    };
    expect(Fragment.read(emptyRecords)).toBeNull();
    const missingRecords: Record<string, unknown> = {
      ...validFragment,
      records: undefined,
    };
    expect(Fragment.read(missingRecords)).toBeNull();
  });

  it("rejects fragments exceeding the shared max record bound", (): void => {
    const oversizedRecords: LegacyBackupSqlRecord[] = Array.from(
      { length: MAX_FRAGMENT_RECORDS + 1 },
      (): LegacyBackupSqlRecord => ({ type: "setting", key: "k", value: 1 }),
    );
    const oversized: Fragment = {
      ...validFragment,
      records: oversizedRecords,
    };
    expect(Fragment.read(oversized)).toBeNull();
    const atBoundRecords: LegacyBackupSqlRecord[] = Array.from(
      { length: MAX_FRAGMENT_RECORDS },
      (): LegacyBackupSqlRecord => ({ type: "setting", key: "k", value: 1 }),
    );
    const atBound: Fragment = {
      ...validFragment,
      records: atBoundRecords,
    };
    expect(Fragment.read(atBound)).toEqual(atBound);
  });

  it("preserves the record references without copying payloads", (): void => {
    const records: LegacyBackupSqlRecord[] = [
      { type: "setting", key: "k", value: 1 },
    ];
    const parsed: Fragment | null = Fragment.read({
      format: "risu-portable-database-fragment",
      index: 1,
      records,
    });
    expect(parsed?.records[0]).toBe(records[0]);
  });
});
