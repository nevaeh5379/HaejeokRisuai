import { describe, expect, it } from "vitest";
import {
  AsyncSerialQueue,
  normalizeSqliteLimit,
  normalizeSqlitePageEnd,
} from "./sqliteStorageUtils";

describe("sqlite storage utilities", () => {
  it("normalizes invalid SQLite pagination inputs", () => {
    expect(normalizeSqliteLimit(0)).toBe(1);
    expect(normalizeSqliteLimit(3.9)).toBe(3);
    expect(normalizeSqliteLimit(Number.NaN)).toBe(1);
    expect(normalizeSqliteLimit(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizeSqlitePageEnd(undefined, 10)).toBe(10);
    expect(normalizeSqlitePageEnd(8.9, 10)).toBe(8);
    expect(normalizeSqlitePageEnd(Number.NaN, 10)).toBe(10);
    expect(normalizeSqlitePageEnd(-3, 10)).toBe(0);
  });

  it("serializes writes and keeps working after a rejection", async () => {
    const queue = new AsyncSerialQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(async () => {
      events.push("first:start");
      await gate;
      events.push("first:end");
    });
    const second = queue.run(async () => {
      events.push("second");
      throw new Error("expected");
    });
    const third = queue.run(async () => {
      events.push("third");
      return 3;
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow("expected");
    await expect(third).resolves.toBe(3);
    expect(events).toEqual(["first:start", "first:end", "second", "third"]);
  });
});
