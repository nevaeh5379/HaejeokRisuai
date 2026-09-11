import { describe, expect, it, vi } from "vitest";
import {
  mergeDatabaseChanges,
  NodeRealtimeChangeQueue,
} from "./nodeRealtimeChangeQueue";

describe("mergeDatabaseChanges", () => {
  it("deduplicates touched records and keeps the newest scalar authority", () => {
    const merged = mergeDatabaseChanges(
      {
        revision: 3,
        rootUpsertKeys: ["theme", "language"],
        charactersChanged: true,
      },
      {
        revision: 5,
        rootUpsertKeys: ["theme"],
        rootDeleteKeys: ["legacy"],
        modulesChanged: true,
        action: "plugin-toggle",
      },
    );

    expect(merged).toMatchObject({
      revision: 5,
      rootUpsertKeys: ["theme", "language"],
      rootDeleteKeys: ["legacy"],
      charactersChanged: true,
      modulesChanged: true,
      pluginsChanged: true,
    });
  });

  it("retains explicit false flags for new-server routing", () => {
    expect(
      mergeDatabaseChanges(null, {
        characterIds: ["chat-parent"],
        charactersChanged: false,
      }).charactersChanged,
    ).toBe(false);
  });
});

describe("NodeRealtimeChangeQueue", () => {
  it("coalesces a burst and never applies batches concurrently", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maxActive = 0;
    const applied: number[] = [];
    const releases: Array<() => void> = [];
    const queue = new NodeRealtimeChangeQueue(
      async (change) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        applied.push(change.revision!);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      },
      (error) => {
        throw error;
      },
      10,
    );

    queue.enqueue({ revision: 1, rootUpsertKeys: ["a"] });
    queue.enqueue({ revision: 2, rootUpsertKeys: ["b"] });
    await vi.advanceTimersByTimeAsync(10);
    expect(applied).toEqual([2]);

    queue.enqueue({ revision: 3, rootUpsertKeys: ["c"] });
    queue.enqueue({ revision: 4, rootUpsertKeys: ["d"] });
    releases.shift()?.();
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
    expect(applied).toEqual([2, 4]);
    expect(maxActive).toBe(1);

    releases.shift()?.();
    await queue.flush();
    queue.close();
    vi.useRealTimers();
  });

  it("retains a failed batch and retries it", async () => {
    vi.useFakeTimers();
    const applied: number[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const queue = new NodeRealtimeChangeQueue(
      async (change) => {
        if (fail) {
          fail = false;
          throw new Error("offline");
        }
        applied.push(change.revision!);
      },
      (error) => errors.push(error),
      10,
      100,
    );

    queue.enqueue({ revision: 7, rootUpsertKeys: ["theme"] });
    await vi.advanceTimersByTimeAsync(10);
    expect(errors).toHaveLength(1);
    expect(applied).toEqual([]);

    await vi.advanceTimersByTimeAsync(100);
    expect(applied).toEqual([7]);
    queue.close();
    vi.useRealTimers();
  });
});
