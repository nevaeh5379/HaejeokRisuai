import { describe, expect, it } from "vitest";
import {
  LocalBackupImportJobError,
  LocalBackupImportJobStore,
} from "./importJobStore";

describe("LocalBackupImportJobStore", () => {
  it("tracks upload, restore, and completion", async () => {
    const store = new LocalBackupImportJobStore(60_000, () => "import-1");
    const job = store.create();

    store.beginUpload(job.id, 1000);
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
});
