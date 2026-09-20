import { describe, expect, it } from "vitest";
import {
  filterEssentialBackupAssetKeys,
  findBackupAssetInfo,
  isEssentialBackupAsset,
} from "./assetScope";

function sampleMap() {
  return new Map([
    ["assets/a.png", { charName: "Alice", assetName: "Profile Image" }],
    ["b.png", { charName: "Bob", assetName: "Main Image" }],
  ]);
}

describe("findBackupAssetInfo", () => {
  it("matches keys stored with the assets/ prefix", () => {
    expect(findBackupAssetInfo(sampleMap(), "assets/a.png")).toEqual({
      charName: "Alice",
      assetName: "Profile Image",
    });
  });

  it("matches keys stored without the assets/ prefix", () => {
    expect(findBackupAssetInfo(sampleMap(), "b.png")).toEqual({
      charName: "Bob",
      assetName: "Main Image",
    });
  });

  it("strips the assets/ prefix when the inventory key lacks it", () => {
    expect(findBackupAssetInfo(sampleMap(), "assets/b.png")).toEqual({
      charName: "Bob",
      assetName: "Main Image",
    });
    expect(findBackupAssetInfo(sampleMap(), "a.png")).toEqual({
      charName: "Alice",
      assetName: "Profile Image",
    });
  });

  it("adds the assets/ prefix when the inventory key has it", () => {
    const assetMap = new Map([
      ["assets/c.png", { charName: "Carol", assetName: "Icon" }],
    ]);
    expect(findBackupAssetInfo(assetMap, "c.png")).toEqual({
      charName: "Carol",
      assetName: "Icon",
    });
  });

  it("returns undefined for unknown keys", () => {
    expect(findBackupAssetInfo(sampleMap(), "missing.png")).toBeUndefined();
    expect(findBackupAssetInfo(new Map(), "")).toBeUndefined();
  });
});

describe("isEssentialBackupAsset", () => {
  it("admits only PNG keys present in the inventory", () => {
    expect(isEssentialBackupAsset(sampleMap(), "assets/a.png")).toBe(true);
    expect(isEssentialBackupAsset(sampleMap(), "b.png")).toBe(true);
  });

  it("rejects non-PNG keys even when inventoried", () => {
    const assetMap = new Map([
      ["assets/song.mp3", { charName: "Alice", assetName: "Voice" }],
    ]);
    expect(isEssentialBackupAsset(assetMap, "assets/song.mp3")).toBe(false);
  });

  it("rejects PNG keys missing from the inventory", () => {
    expect(isEssentialBackupAsset(sampleMap(), "assets/unknown.png")).toBe(
      false,
    );
  });

  it("applies the same prefix-flexible matching as findBackupAssetInfo", () => {
    expect(isEssentialBackupAsset(sampleMap(), "assets/b.png")).toBe(true);
    expect(isEssentialBackupAsset(sampleMap(), "a.png")).toBe(true);
  });
});

describe("filterEssentialBackupAssetKeys", () => {
  it("keeps only essential keys in input order", () => {
    const keys = [
      "assets/a.png",
      "assets/song.mp3",
      "b.png",
      "assets/unknown.png",
      "a.png",
    ];
    expect(filterEssentialBackupAssetKeys(keys, sampleMap())).toEqual([
      "assets/a.png",
      "b.png",
      "a.png",
    ]);
  });

  it("does not mutate the input array", () => {
    const keys = ["assets/a.png", "assets/song.mp3"];
    const snapshot = [...keys];
    filterEssentialBackupAssetKeys(keys, sampleMap());
    expect(keys).toEqual(snapshot);
  });

  it("returns an empty array for an empty inventory or key list", () => {
    expect(filterEssentialBackupAssetKeys(["assets/a.png"], new Map())).toEqual(
      [],
    );
    expect(filterEssentialBackupAssetKeys([], sampleMap())).toEqual([]);
  });
});