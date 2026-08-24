import { describe, expect, it } from "vitest";
import { RegexCompileCache } from "./regexCompileCache";

describe("RegexCompileCache", () => {
  it("reuses compiled regexes while resetting global lastIndex", () => {
    const cache = new RegexCompileCache();
    const first = cache.get("a", "g");
    expect(first.test("a a")).toBe(true);
    expect(first.lastIndex).toBeGreaterThan(0);

    const second = cache.get("a", "g");
    expect(second).toBe(first);
    expect(second.lastIndex).toBe(0);
    expect(second.test("a a")).toBe(true);
  });

  it("keeps source and flags as separate cache identities", () => {
    const cache = new RegexCompileCache();
    expect(cache.get("a", "g")).not.toBe(cache.get("a", "i"));
  });

  it("evicts the least recently used entry at the bound", () => {
    const cache = new RegexCompileCache(2);
    const first = cache.get("first", "g");
    cache.get("second", "g");
    cache.get("third", "g");
    expect(cache.size).toBe(2);
    expect(cache.get("first", "g")).not.toBe(first);
  });
});
