import { describe, it, expect, vi } from "vitest";
import { TaskRateLimiter, TaskCanceledError } from "./taskRateLimiter";

describe("TaskRateLimiter", () => {
  it("executes tasks successfully within concurrency limits", async () => {
    const limiter = new TaskRateLimiter({
      tasksPerMinute: 10,
      maxConcurrentTasks: 2,
    });

    let running = 0;
    let maxRunning = 0;

    const makeTask = (id: number, delayMs: number) => async () => {
      running++;
      if (running > maxRunning) maxRunning = running;
      await new Promise((r) => setTimeout(r, delayMs));
      running--;
      return `result-${id}`;
    };

    const results = await limiter.executeBatch([
      makeTask(1, 10),
      makeTask(2, 10),
      makeTask(3, 10),
    ]);

    expect(results.allSucceeded).toBe(true);
    expect(results.results.map((r) => r.data)).toEqual([
      "result-1",
      "result-2",
      "result-3",
    ]);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it("handles failing tasks and respects failFast", async () => {
    const limiter = new TaskRateLimiter({
      tasksPerMinute: 10,
      maxConcurrentTasks: 1,
      failFast: true,
    });

    const task1 = async () => "ok";
    const task2 = async () => {
      throw new Error("fail");
    };
    const task3 = async () => "should-be-canceled";

    const res1 = await limiter.executeTask(task1);
    expect(res1.success).toBe(true);
    expect(res1.data).toBe("ok");

    const [res2, res3] = await Promise.all([
      limiter.executeTask(task2),
      limiter.executeTask(task3),
    ]);

    expect(res2.success).toBe(false);
    expect(res2.error?.message).toBe("fail");

    expect(res3.success).toBe(false);
    expect(res3.error).toBeInstanceOf(TaskCanceledError);
  });

  it("cancels pending tasks with cancelPendingTasks", async () => {
    const limiter = new TaskRateLimiter({
      tasksPerMinute: 10,
      maxConcurrentTasks: 1,
    });

    let releaseFirst: () => void = () => {};
    const firstTask = () =>
      new Promise<string>((resolve) => {
        releaseFirst = () => resolve("first");
      });

    const p1 = limiter.executeTask(firstTask);
    const p2 = limiter.executeTask(async () => "second");

    expect(limiter.queuedTaskCount).toBe(1);

    limiter.cancelPendingTasks("custom cancel");

    releaseFirst();

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.success).toBe(true);
    expect(r1.data).toBe("first");
    expect(r2.success).toBe(false);
    expect(r2.error?.message).toBe("custom cancel");
  });
});
