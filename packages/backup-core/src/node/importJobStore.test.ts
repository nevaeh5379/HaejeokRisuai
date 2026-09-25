import { describe, expect, it, vi } from "vitest";
import {
  LocalBackupImportJobError,
  LocalBackupImportJobStore,
} from "./importJobStore";

describe("LocalBackupImportJobStore", () => {
  it("tracks upload, restore, and completion", async () => {
    const store = new LocalBackupImportJobStore(
      60_000,
      () => "import-1",
      () => "upload-1",
    );
    const job = store.create();

    expect(job).toEqual({ id: "import-1", uploadToken: "upload-1" });
    expect(store.authorizeDirectUpload(job.id, job.uploadToken)).toBe(true);
    expect(store.authorizeDirectUpload(job.id, "wrong-token")).toBe(false);
    store.beginUpload(job.id, 1000);
    expect(store.authorizeDirectUpload(job.id, job.uploadToken)).toBe(false);
    store.updateProgress(job.id, {
      stage: "uploading",
      current: 400,
      total: 1000,
    });
    expect(store.progress(job.id)).toEqual({
      status: "uploading",
      progress: { stage: "uploading", current: 400, total: 1000 },
    });

    store.markRestoring(job.id);
    const completion = store.wait(job.id);
    store.settle(job.id, "complete", { revision: 7, recordCount: 99 });
    await expect(completion).resolves.toEqual({
      status: "complete",
      error: null,
      revision: 7,
      recordCount: 99,
    });
  });

  it("rejects a duplicate upload start", () => {
    const store = new LocalBackupImportJobStore(60_000, () => "import-2");
    store.create();
    store.beginUpload("import-2");
    expect(() => store.beginUpload("import-2")).toThrow(
      LocalBackupImportJobError,
    );
  });

  it("rejects direct upload credentials for unknown jobs", () => {
    const store = new LocalBackupImportJobStore(
      60_000,
      () => "import-unknown",
      () => "upload-unknown",
    );
    expect(store.authorizeDirectUpload("missing", "upload-unknown")).toBe(
      false,
    );
  });

  it("keeps pending upload credentials for 24 hours and active uploads indefinitely", () => {
    const startedAt = 1_800_000_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    try {
      const store = new LocalBackupImportJobStore(
        undefined,
        () => "import-long",
        () => "upload-long",
      );
      const job = store.create();

      now.mockReturnValue(startedAt + 23 * 60 * 60 * 1000);
      expect(store.authorizeDirectUpload(job.id, job.uploadToken)).toBe(true);

      store.beginUpload(job.id, 1000);
      now.mockReturnValue(startedAt + 48 * 60 * 60 * 1000);
      expect(store.progress(job.id).status).toBe("uploading");
    } finally {
      now.mockRestore();
    }
  });

  it("releases an in-flight waiter when a job is cancelled", async () => {
    const store = new LocalBackupImportJobStore(60_000, () => "import-3");
    const job = store.create();
    store.beginUpload(job.id, 1000);
    const waiting = store.wait(job.id);

    store.remove(job.id);

    await expect(waiting).resolves.toMatchObject({
      status: "error",
      error: "Local backup import was cancelled",
    });
    expect(() => store.progress(job.id)).toThrow("not found or expired");
  });
});
