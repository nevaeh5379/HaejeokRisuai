import { afterEach, expect, test, vi } from "vitest";
import {
  isNodeRealtimeConnected,
  publishNodeBackupProgress,
  setNodeRealtimeConnected,
  subscribeNodeBackupProgress,
} from "./nodeRealtimeBackupProgress";

afterEach(() => setNodeRealtimeConnected(false));

test("routes backup progress by job and removes completed subscriptions", () => {
  const listener = vi.fn();
  const unsubscribe = subscribeNodeBackupProgress("job-a", listener);

  publishNodeBackupProgress({
    jobId: "job-b",
    status: "uploading",
    progress: { stage: "uploading", current: 1, total: 2 },
  });
  publishNodeBackupProgress({
    jobId: "job-a",
    status: "restoring",
    progress: { stage: "database", current: 3, total: 4 },
  });
  expect(listener).toHaveBeenCalledOnce();

  unsubscribe();
  publishNodeBackupProgress({ jobId: "job-a", status: "complete" });
  expect(listener).toHaveBeenCalledOnce();
});

test("one failed listener does not block another listener", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const healthy = vi.fn();
  const unsubscribeFailed = subscribeNodeBackupProgress("job-a", () => {
    throw new Error("failed");
  });
  const unsubscribeHealthy = subscribeNodeBackupProgress("job-a", healthy);

  publishNodeBackupProgress({ jobId: "job-a", status: "uploading" });
  expect(healthy).toHaveBeenCalledOnce();

  unsubscribeFailed();
  unsubscribeHealthy();
  error.mockRestore();
});

test("tracks whether realtime delivery is available", () => {
  expect(isNodeRealtimeConnected()).toBe(false);
  setNodeRealtimeConnected(true);
  expect(isNodeRealtimeConnected()).toBe(true);
});
