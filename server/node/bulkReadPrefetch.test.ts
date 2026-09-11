import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  normalizePrefetchConcurrency,
  prefetchInOrder,
} = require("./bulkReadPrefetch.cjs");

describe("bulk read prefetch", () => {
  it("opens several assets ahead while yielding them in request order", async () => {
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    let active = 0;
    let maxActive = 0;

    const iterator = prefetchInOrder(
      ["first", "second", "third", "fourth"],
      async (key: string) => {
        started.push(key);
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.set(key, resolve));
        active -= 1;
        return key.toUpperCase();
      },
      2,
    )[Symbol.asyncIterator]();

    const firstResult = iterator.next();
    await viWaitFor(() => expect(started).toEqual(["first", "second"]));

    releases.get("second")?.();
    await Promise.resolve();
    expect(started).toEqual(["first", "second"]);

    releases.get("first")?.();
    await expect(firstResult).resolves.toEqual({
      done: false,
      value: { item: "first", value: "FIRST" },
    });
    await viWaitFor(() =>
      expect(started).toEqual(["first", "second", "third"]),
    );

    const secondResult = iterator.next();
    await expect(secondResult).resolves.toEqual({
      done: false,
      value: { item: "second", value: "SECOND" },
    });
    await viWaitFor(() =>
      expect(started).toEqual(["first", "second", "third", "fourth"]),
    );

    releases.get("fourth")?.();
    releases.get("third")?.();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { item: "third", value: "THIRD" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { item: "fourth", value: "FOURTH" },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true });
    expect(maxActive).toBe(2);
  });

  it("returns per-asset failures without rejecting the iterator", async () => {
    const error = new Error("missing asset");
    const results = [];

    for await (const result of prefetchInOrder(
      ["good", "bad"],
      async (key: string) => {
        if (key === "bad") throw error;
        return "ok";
      },
      2,
    )) {
      results.push(result);
    }

    expect(results).toEqual([
      { item: "good", value: "ok" },
      { item: "bad", error },
    ]);
  });

  it("keeps configured concurrency within a small memory-safe range", () => {
    expect(normalizePrefetchConcurrency(undefined)).toBe(4);
    expect(normalizePrefetchConcurrency("0")).toBe(1);
    expect(normalizePrefetchConcurrency("3")).toBe(3);
    expect(normalizePrefetchConcurrency("999")).toBe(8);
    expect(normalizePrefetchConcurrency("invalid")).toBe(4);
  });
});

async function viWaitFor(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await Promise.resolve();
    }
  }
  assertion();
}
