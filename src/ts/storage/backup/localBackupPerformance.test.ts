import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_BACKUP_PERFORMANCE,
  applyLocalBackupPerformanceDefaults,
  normalizeLocalBackupPerformance,
} from "./localBackupPerformance";

describe("local backup performance settings", () => {
  it("uses explicit numeric defaults", () => {
    expect(normalizeLocalBackupPerformance({})).toEqual(
      DEFAULT_LOCAL_BACKUP_PERFORMANCE,
    );
  });

  it("rounds and bounds user supplied values", () => {
    expect(
      normalizeLocalBackupPerformance({
        localBackupDatabasePageRecords: 999,
        localBackupFragmentRecords: 0,
        localBackupWriterBufferKiB: 4096.4,
        localBackupProgressUpdateMs: 10,
      }),
    ).toEqual({
      databasePageRecords: 500,
      fragmentRecords: 1,
      writerBufferKiB: 4096,
      progressUpdateMs: 50,
    });
  });

  it("writes normalized values back to the settings object", () => {
    const input = { localBackupDatabasePageRecords: "256" };
    applyLocalBackupPerformanceDefaults(input);
    expect(input).toMatchObject({
      localBackupDatabasePageRecords: 256,
      localBackupFragmentRecords: 128,
      localBackupWriterBufferKiB: 1024,
      localBackupProgressUpdateMs: 200,
    });
  });
});
