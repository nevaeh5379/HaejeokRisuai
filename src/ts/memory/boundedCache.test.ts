import { describe, expect, it, vi } from "vitest";
import { BoundedCache } from "./boundedCache";

describe("BoundedCache", () => {
  it("evicts the least recently used entry", () => {
    const evicted = vi.fn();
    const cache = new BoundedCache<string, string>({
      maxEntries: 2,
      onEvict: evicted,
    });
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C");
    expect(cache.get("b")).toBeUndefined();
    expect(evicted).toHaveBeenCalledWith("B", "b");
  });

  it("enforces a weight budget and releases cleared values", () => {
    const evicted: string[] = [];
    const cache = new BoundedCache<string, string>({
      maxEntries: 10,
      maxWeight: 5,
      weigh: (value) => value.length,
      onEvict: (value) => evicted.push(value),
    });
    cache.set("a", "123");
    cache.set("b", "456");
    expect(cache.has("a")).toBe(false);
    expect(cache.weight).toBe(3);
    cache.clear();
    expect(evicted).toEqual(["123", "456"]);
    expect(cache.weight).toBe(0);
  });

  it("uses the current dynamic limits when inserting entries", () => {
    let lowSpecMode = false;
    const cache = new BoundedCache<string, string>({
      maxEntries: () => (lowSpecMode ? 1 : 3),
      maxWeight: () => (lowSpecMode ? 3 : 9),
      weigh: (value) => value.length,
    });
    cache.set("a", "123");
    cache.set("b", "456");
    expect(cache.size).toBe(2);

    lowSpecMode = true;
    cache.set("c", "789");
    expect(cache.size).toBe(1);
    expect(cache.has("c")).toBe(true);
    expect(cache.weight).toBe(3);
  });
});
