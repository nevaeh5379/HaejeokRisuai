import { describe, expect, it } from "vitest";
import {
  createNodeLocalBackupRestoreProgressReporter,
  type LocalBackupProgressBar,
  type LocalBackupProgressStepState,
} from "./localBackupProgress";

interface CapturedProgress {
  message: string;
  progress: number;
  stepState: LocalBackupProgressStepState;
}

function barsByLabel(bars: LocalBackupProgressBar[]): number[] {
  return bars.map((bar) => bar.progress);
}

describe("Node local backup restore progress", () => {
  it("tracks upload and server restore independently without regressions", () => {
    const updates: CapturedProgress[] = [];
    const reporter = createNodeLocalBackupRestoreProgressReporter(
      (message, progress, stepState): void => {
        updates.push({ message, progress, stepState });
      },
    );

    reporter.start(100);
    reporter.updateUpload(80, 100);
    reporter.updateRemote({ stage: "reading", current: 50, total: 100 });
    reporter.updateRemote({ stage: "database", current: 1, total: 1 });
    reporter.updateUpload(20, 100);
    reporter.updateRemote({ stage: "reading", current: 10, total: 100 });

    expect(
      updates.map((update) => barsByLabel(update.stepState.bars ?? [])),
    ).toEqual([
      [0, 0],
      [80, 0],
      [80, 50],
      [80, 100],
      [80, 100],
      [80, 100],
    ]);
    for (let index = 1; index < updates.length; index += 1) {
      expect(updates[index].progress).toBeGreaterThanOrEqual(
        updates[index - 1].progress,
      );
    }
    expect(updates[1].stepState.bars?.[0].detail).toBe("80 B / 100 B");
    expect(updates[2].stepState.bars?.[1].detail).toBe("50 B / 100 B");
  });

  it("never exposes a server entry name and finishes both bars", () => {
    const updates: CapturedProgress[] = [];
    const reporter = createNodeLocalBackupRestoreProgressReporter(
      (message, progress, stepState): void => {
        updates.push({ message, progress, stepState });
      },
    );

    reporter.start(1024);
    reporter.updateRemote({
      stage: "assets",
      current: 7,
      total: 0,
      detail: "assets/private/secret-name.png",
    });
    reporter.complete();

    expect(JSON.stringify(updates)).not.toContain("secret-name.png");
    expect(updates.at(-1)?.stepState.bars?.[0].detail).toBe(
      "1.0 KiB / 1.0 KiB",
    );
    expect(updates.at(-1)?.progress).toBe(100);
    expect(barsByLabel(updates.at(-1)?.stepState.bars ?? [])).toEqual([
      100, 100,
    ]);
  });
});
