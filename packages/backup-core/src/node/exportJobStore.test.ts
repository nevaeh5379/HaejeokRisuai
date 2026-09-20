import { describe, expect, it } from "vitest";
import {
  LocalBackupExportJobError,
  LocalBackupExportJobStore,
} from "./exportJobStore";

describe("LocalBackupExportJobStore", () => {
  it("owns the export job lifecycle without exposing completion internals", async () => {
    const store = new LocalBackupExportJobStore(60_000, () => "job-1");
    const created = store.create({
      mode: "native",
      streamOptions: { pageSize: 128, fragmentRecords: 64 },
    });

    expect(created).toMatchObject({
      id: "job-1",
      status: "pending",
      mode: "native",
      progress: { stage: "preparing", current: 0, total: 0 },
    });
    expect(created).not.toHaveProperty("completion");

    const streaming = store.beginStreaming(created.id);
    expect(streaming.status).toBe("streaming");

    store.updateProgress(created.id, {
      stage: "database",
      current: 50,
      total: 100,
    });
    expect(store.progress(created.id)).toEqual({
      status: "streaming",
      progress: { stage: "database", current: 50, total: 100 },
    });

    const completion = store.wait(created.id);
    store.settle(created.id, "complete");
    await expect(completion).resolves.toEqual({
      status: "complete",
      error: null,
    });
  });

  it("rejects starting the same download twice", () => {
    const store = new LocalBackupExportJobStore(60_000, () => "job-2");
    store.create({
      mode: "partial",
      streamOptions: { pageSize: 32, fragmentRecords: 16 },
    });
    store.beginStreaming("job-2");

    expect(() => store.beginStreaming("job-2")).toThrow(
      LocalBackupExportJobError,
    );
    try {
      store.beginStreaming("job-2");
    } catch (error) {
      expect(error).toMatchObject({ code: "job_already_started" });
    }
  });

  it("removes completed jobs explicitly after the waiter consumes them", async () => {
    const store = new LocalBackupExportJobStore(60_000, () => "job-3");
    store.create({
      mode: "compatible",
      streamOptions: { pageSize: 128, fragmentRecords: 128 },
    });
    store.beginStreaming("job-3");
    store.settle("job-3", "error", "boom");

    await expect(store.wait("job-3")).resolves.toEqual({
      status: "error",
      error: "boom",
    });
    store.remove("job-3");
    expect(store.get("job-3")).toBeNull();
  });
});
