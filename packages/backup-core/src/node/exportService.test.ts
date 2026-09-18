import { describe, expect, it } from "vitest";
import {
  LocalBackupExportJobError,
  LocalBackupExportJobStore,
} from "./exportJobStore";
import {
  LocalBackupExportService,
  type LocalBackupExportAdapter,
} from "./exportService";

describe("LocalBackupExportService", () => {
  it("normalizes job creation options", () => {
    const jobs = new LocalBackupExportJobStore(60_000, () => "export-1");
    const adapter: LocalBackupExportAdapter = {
      async stream() {},
    };
    const service = new LocalBackupExportService(jobs, adapter);

    const created = service.createJob({
      mode: "partial",
      pageSize: 9999,
      fragmentRecords: 0,
    });
    expect(created).toEqual({ id: "export-1" });
    expect(jobs.get(created.id)).toMatchObject({
      mode: "partial",
      streamOptions: {
        pageSize: 500,
        fragmentRecords: 1,
      },
    });
  });

  it("owns streaming progress and successful completion", async () => {
    const jobs = new LocalBackupExportJobStore(60_000, () => "export-2");
    const seen: string[] = [];
    const adapter: LocalBackupExportAdapter = {
      async stream(job, _context, onProgress) {
        seen.push(job.mode);
        onProgress({ stage: "database", current: 2, total: 4 });
      },
    };
    const service = new LocalBackupExportService(jobs, adapter);
    const { id } = service.createJob({
      mode: "compatible",
      pageSize: 64,
      fragmentRecords: 32,
    });

    await service.stream(id, undefined);

    expect(seen).toEqual(["compatible"]);
    expect(service.progress(id)).toEqual({
      status: "complete",
      progress: { stage: "finalizing", current: 1, total: 1 },
    });
    await expect(service.wait(id)).resolves.toEqual({
      status: "complete",
      error: null,
    });
  });

  it("settles failures and removes completed jobs on wait", async () => {
    const jobs = new LocalBackupExportJobStore(60_000, () => "export-3");
    const adapter: LocalBackupExportAdapter = {
      async stream(_job, _context, onProgress) {
        onProgress({ stage: "assets", current: 1, total: 3 });
        throw new Error("stream failed");
      },
    };
    const service = new LocalBackupExportService(jobs, adapter);
    const { id } = service.createJob();

    await expect(service.stream(id, undefined)).rejects.toThrow(
      "stream failed",
    );
    await expect(service.waitAndRemove(id)).resolves.toEqual({
      status: "error",
      error: "stream failed",
    });
    expect(() => service.progress(id)).toThrow(LocalBackupExportJobError);
  });
});
