import { describe, expect, it } from "vitest";
import type { LegacyBackupSqlRecord } from "../legacyRecords.ts";
import {
  DB_STREAM_VERSION,
  MANIFEST_NAME,
  MAX_FRAGMENT_RECORDS,
  PREFIX,
  Fragment,
  Manifest,
} from "./databaseBackup.ts";

describe("database backup entry names", () => {
  it("round-trips canonical positive fragment names", () => {
    expect(PREFIX).toBe("database.stream/");
    expect(MANIFEST_NAME).toBe("database.stream/manifest.risudat");
    expect(Fragment.parseName(Fragment.name(7))).toBe(7);
    expect(
      Fragment.parseName("database.stream/000000000000.risudat"),
    ).toBeNull();
    expect(Fragment.parseName("database.stream/7.risudat")).toBeNull();
    expect(() => Fragment.name(0)).toThrow("positive");
    expect(() => Fragment.name(1.5)).toThrow("positive");
  });
});

const summary = {
  revision: 7,
  totalFragments: 2,
  totalRecords: 5,
  counts: { setting: 3, message: 2 },
};
const legacyManifest = {
  ...summary,
  format: "risu-portable-database-stream",
  version: 1,
  complete: true,
};

describe("Manifest.read", () => {
  const valid = Manifest.create(summary);

  it("round-trips the current format with its exact version", () => {
    expect(valid.format).toBe("haejeok-stream-manifest");
    expect(valid.version).toBe(DB_STREAM_VERSION);
    expect(Manifest.read(valid)).toEqual(valid);
  });

  it.each([undefined, null, 1, 1.1, "1", "1.0", "9.9", true])(
    "rejects unsupported or missing current-format version %s",
    (version) => {
      expect(Manifest.read({ ...valid, version })).toBeNull();
    },
  );

  it("normalizes a valid v1 manifest without mutating it or copying counts", () => {
    const parsed = Manifest.read(legacyManifest);
    expect(parsed).toEqual(valid);
    expect(parsed?.counts).toBe(legacyManifest.counts);
    expect(legacyManifest.format).toBe("risu-portable-database-stream");
    expect(legacyManifest.version).toBe(1);
  });

  it.each([undefined, null, "1", 1.1, "1.1", 2])(
    "rejects unsupported or missing legacy version %s",
    (version) => {
      expect(Manifest.read({ ...legacyManifest, version })).toBeNull();
    },
  );

  it.each([undefined, false, "true", 1])(
    "rejects a legacy manifest without a true completion flag: %s",
    (complete) => {
      expect(Manifest.read({ ...legacyManifest, complete })).toBeNull();
    },
  );

  it("rejects malformed metadata and incomplete current-format manifests", () => {
    for (const value of [null, undefined, "manifest", [], {}]) {
      expect(Manifest.read(value)).toBeNull();
    }
    for (const patch of [
      { format: { toString: () => valid.format } },
      { format: "nope" },
      { complete: false },
      { revision: -1 },
      { revision: 1.5 },
      { revision: Number.MAX_SAFE_INTEGER + 1 },
      { totalFragments: 0 },
      { totalRecords: 0 },
      { counts: null },
      { counts: [] },
      { counts: { setting: "3" } },
      { counts: { setting: undefined } },
      { counts: { setting: -1 } },
      { counts: { setting: 0.5 } },
      { counts: { setting: NaN } },
      { counts: { setting: Infinity } },
      { counts: { setting: Number.MAX_SAFE_INTEGER + 1 } },
      { counts: { unknownType: 1 } },
    ]) {
      expect(Manifest.read({ ...valid, ...patch })).toBeNull();
    }
  });

  it("leaves aggregate count reconciliation to the restore consumers", () => {
    expect(Manifest.read({ ...valid, counts: {} })).not.toBeNull();
    expect(
      Manifest.read({ ...valid, counts: { futureType: 0 } }),
    ).not.toBeNull();
  });
});

describe("Fragment.read", () => {
  const records: LegacyBackupSqlRecord[] = [
    { type: "meta", formatVersion: 1, revision: 7 },
    { type: "setting", key: "k", value: 1 },
  ];
  const valid = Fragment.create(3, records);
  const legacy = {
    format: "risu-portable-database-fragment",
    version: 1,
    index: 3,
    records,
  };

  it("round-trips the current envelope and enforces the expected index", () => {
    expect(valid.format).toBe("haejeok-stream-fragment");
    expect(Fragment.read(valid, { expectedIndex: 3 })).toEqual(valid);
    expect(Fragment.read(valid, { expectedIndex: 4 })).toBeNull();
  });

  it("normalizes v1 envelopes while retaining the exact record array", () => {
    const parsed = Fragment.read(legacy);
    expect(parsed).toEqual(valid);
    expect(parsed?.records).toBe(records);
    expect(parsed?.records[0]).toBe(records[0]);
    expect(parsed).not.toHaveProperty("version");
    expect(legacy.format).toBe("risu-portable-database-fragment");
  });

  it.each([undefined, null, "1", 1.1, "1.1", 99])(
    "rejects unsupported or missing legacy fragment version %s",
    (version) => {
      expect(Fragment.read({ ...legacy, version })).toBeNull();
    },
  );

  it("rejects versioned current fragments instead of silently ignoring a version", () => {
    expect(Fragment.read({ ...valid, version: "1.1" })).toBeNull();
    expect(Fragment.read({ ...valid, version: "9.9" })).toBeNull();
  });

  it("rejects malformed and oversized fragment envelopes", () => {
    for (const value of [null, undefined, "fragment", [], {}]) {
      expect(Fragment.read(value)).toBeNull();
    }
    for (const patch of [
      { format: "nope" },
      { format: { toString: () => valid.format } },
      { index: 0 },
      { index: 4.5 },
      { index: Number.MAX_SAFE_INTEGER + 1 },
      { records: [] },
      { records: undefined },
      { records: Array(MAX_FRAGMENT_RECORDS + 1).fill(records[0]) },
    ]) {
      expect(Fragment.read({ ...valid, ...patch })).toBeNull();
    }
    const atBound = Array<LegacyBackupSqlRecord>(MAX_FRAGMENT_RECORDS).fill(
      records[0],
    );
    expect(Fragment.read(Fragment.create(1, atBound))?.records).toBe(atBound);
  });
});
