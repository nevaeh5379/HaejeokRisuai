import { describe, expect, it } from "vitest";
import {
  LOCAL_BACKUP_PROGRESS_STAGES,
  validateLocalBackupExportJobProgress,
} from "./api";

describe("local backup progress contract", () => {
  it("shares the canonical export stage order", () => {
    expect(LOCAL_BACKUP_PROGRESS_STAGES).toEqual([
      "selectingDestination",
      "preparing",
      "database",
      "coldStorage",
      "assets",
      "inlays",
      "finalizing",
    ]);
  });

  it("validates progress against the shared stage list", () => {
    expect(
      validateLocalBackupExportJobProgress({
        status: "streaming",
        progress: { stage: "assets", current: 2, total: 3 },
      }),
    ).toMatchObject({ status: "streaming" });
    expect(() =>
      validateLocalBackupExportJobProgress({
        status: "streaming",
        progress: { stage: "unknown" },
      }),
    ).toThrow("invalid export progress data");
  });
});
