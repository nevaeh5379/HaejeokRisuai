import { describe, expect, it } from "vitest";
import { TaskRateLimiter } from "./taskRateLimiter";

describe("TaskRateLimiter", () => {
  it("executes tasks in batch and tracks success/failure counts without allocation leaks", async () => {
    const limiter = new TaskRateLimiter({
      tasksPerMinute: 60,
      maxConcurrentTasks: 5,
    });

    const tasks = [
      async () => "result1",
      async () => {
        throw new Error("fail");
      },
      async () => "result3",
    ];

    const batch = await limiter.executeBatch(tasks);

    expect(batch.results).toHaveLength(3);
    expect(batch.successCount).toBe(2);
    expect(batch.failureCount).toBe(1);
    expect(batch.allSucceeded).toBe(false);
    expect(batch.results[0].data).toBe("result1");
    expect(batch.results[1].success).toBe(false);
    expect(batch.results[2].data).toBe("result3");
  });

  it("reports allSucceeded true when every task succeeds", async () => {
    const limiter = new TaskRateLimiter({
      tasksPerMinute: 60,
      maxConcurrentTasks: 5,
    });

    const tasks = [async () => 10, async () => 20];
    const batch = await limiter.executeBatch(tasks);

    expect(batch.successCount).toBe(2);
    expect(batch.failureCount).toBe(0);
    expect(batch.allSucceeded).toBe(true);
  });
});
