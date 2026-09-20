import { describe, expect, it } from "vitest";
import { BoundedAssetBatch } from "./restoreBatch";

function payload(length: number, fill = 1): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe("BoundedAssetBatch thresholds", () => {
  it("signals full at the file-count limit", () => {
    const batch = new BoundedAssetBatch(3, 1000);
    expect(batch.add("a", payload(1))).toBe(false);
    expect(batch.add("b", payload(1))).toBe(false);
    expect(batch.add("c", payload(1))).toBe(true);
    expect(batch.size).toBe(3);
  });

  it("does not fire before the file-count limit", () => {
    const batch = new BoundedAssetBatch(2, 1_000_000);
    expect(batch.add("a", payload(10))).toBe(false);
    expect(batch.size).toBe(1);
  });

  it("signals full at the exact byte threshold", () => {
    const batch = new BoundedAssetBatch(100, 16);
    expect(batch.add("a", payload(16))).toBe(true);
    expect(batch.byteSize).toBe(16);
  });

  it("does not fire below the byte threshold", () => {
    const batch = new BoundedAssetBatch(100, 16);
    expect(batch.add("a", payload(15))).toBe(false);
    expect(batch.byteSize).toBe(15);
  });

  it("accepts zero-length payloads, counting them toward files only", () => {
    const batch = new BoundedAssetBatch(2, 1);
    expect(batch.add("a", payload(0))).toBe(false);
    expect(batch.byteSize).toBe(0);
    expect(batch.add("b", payload(0))).toBe(true);
    expect(batch.byteSize).toBe(0);
  });

  it("rejects nonsensical limits", () => {
    expect(() => new BoundedAssetBatch(0, 1)).toThrow(RangeError);
    expect(() => new BoundedAssetBatch(1.5, 1)).toThrow(RangeError);
    expect(() => new BoundedAssetBatch(1, 0)).toThrow(RangeError);
    expect(() => new BoundedAssetBatch(1, -1)).toThrow(RangeError);
    expect(() => new BoundedAssetBatch(1, 2 ** 53)).not.toThrow();
  });
});

describe("BoundedAssetBatch duplicate replacement", () => {
  it("subtracts the replaced payload when the new one is smaller", () => {
    const batch = new BoundedAssetBatch(10, 40);
    batch.add("a", payload(30));
    expect(batch.add("a", payload(10))).toBe(false);
    expect(batch.size).toBe(1);
    expect(batch.byteSize).toBe(10);
  });

  it("fires the threshold when the replacement is larger", () => {
    const batch = new BoundedAssetBatch(10, 20);
    expect(batch.add("a", payload(5))).toBe(false);
    expect(batch.add("a", payload(25))).toBe(true);
    expect(batch.size).toBe(1);
    expect(batch.byteSize).toBe(25);
  });

  it("does not double-count repeated same-size replacement", () => {
    const batch = new BoundedAssetBatch(10, 50);
    batch.add("a", payload(10));
    batch.add("a", payload(10));
    batch.add("a", payload(10));
    expect(batch.byteSize).toBe(10);
    expect(batch.size).toBe(1);
  });
});

describe("BoundedAssetBatch drain", () => {
  it("transfers ownership without copying payloads", () => {
    const batch = new BoundedAssetBatch(10, 1000);
    const first = payload(4, 1);
    const second = payload(6, 2);
    batch.add("assets/a.png", first);
    batch.add("assets/b.png", second);

    const drained = batch.drain();

    expect([...drained.keys()]).toEqual(["assets/a.png", "assets/b.png"]);
    expect(drained.get("assets/a.png")).toBe(first);
    expect(drained.get("assets/b.png")).toBe(second);
  });

  it("resets count and bytes atomically for reuse", () => {
    const batch = new BoundedAssetBatch(2, 10);
    batch.add("a", payload(9));
    expect(batch.drain().size).toBe(1);

    expect(batch.size).toBe(0);
    expect(batch.byteSize).toBe(0);
    expect(batch.full).toBe(false);

    expect(batch.add("b", payload(5))).toBe(false);
    expect(batch.size).toBe(1);
    expect(batch.byteSize).toBe(5);
  });

  it("returns an empty map for an empty drain without breaking state", () => {
    const batch = new BoundedAssetBatch(2, 10);
    const drained = batch.drain();
    expect(drained.size).toBe(0);
    expect(batch.size).toBe(0);
    expect(batch.byteSize).toBe(0);

    expect(batch.add("a", payload(1))).toBe(false);
    expect(batch.size).toBe(1);
  });

  it("is unaffected by mutating a previously drained map", () => {
    const batch = new BoundedAssetBatch(10, 1000);
    batch.add("a", payload(4));
    const drained = batch.drain();
    drained.set("injected", payload(1000));
    drained.delete("a");

    expect(batch.size).toBe(0);
    expect(batch.byteSize).toBe(0);
    expect(batch.add("b", payload(1))).toBe(false);
    expect(batch.size).toBe(1);
  });

  it("clears without transferring contents", () => {
    const batch = new BoundedAssetBatch(10, 1000);
    batch.add("a", payload(4));
    batch.clear();
    expect(batch.size).toBe(0);
    expect(batch.byteSize).toBe(0);
    expect(batch.full).toBe(false);
  });
});
