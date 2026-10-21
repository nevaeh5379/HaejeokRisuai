import { describe, expect, it } from "vitest";
import { TaskRateLimiter } from "./taskRateLimiter";

describe("TaskRateLimiter", () => {
  it("executes batch and correctly aggregates success and failure counts without intermediate arrays", async () => {
    const limiter = new TaskRateLimiter({
      tasksPerMinute: 20,
      maxConcurrentTasks: 5,
    });

    const tasks = [
      () => Promise.resolve("ok1"),
      () => Promise.reject(new Error("fail")),
      () => Promise.resolve("ok2"),
    ];

    const result = await limiter.executeBatch(tasks);
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(1);
    expect(result.allSucceeded).toBe(false);
    expect(result.results.length).toBe(3);
    expect(result.results[0].success).toBe(true);
    expect(result.results[0].data).toBe("ok1");
    expect(result.results[1].success).toBe(false);
    expect(result.results[2].success).toBe(true);
    expect(result.results[2].data).toBe("ok2");
  });

  it("handles empty batch", async () => {
    const limiter = new TaskRateLimiter({
      tasksPerMinute: 20,
      maxConcurrentTasks: 5,
    });

    const result = await limiter.executeBatch([]);
    expect(result.successCount).toBe(0);
    expect(result.failureCount).toBe(0);
    expect(result.allSucceeded).toBe(true);
    expect(result.results).toEqual([]);
  });
});
