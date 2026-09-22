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

    reporter.start();
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
      [80, 98],
      [80, 98],
      [80, 98],
    ]);
    for (let index = 1; index < updates.length; index += 1) {
      expect(updates[index].progress).toBeGreaterThanOrEqual(
        updates[index - 1].progress,
      );
    }
  });

  it("never exposes a server entry name and finishes both bars", () => {
    const updates: CapturedProgress[] = [];
    const reporter = createNodeLocalBackupRestoreProgressReporter(
      (message, progress, stepState): void => {
        updates.push({ message, progress, stepState });
      },
    );

    reporter.updateRemote({
      stage: "assets",
      current: 7,
      total: 0,
      detail: "assets/private/secret-name.png",
    });
    reporter.complete();

    expect(JSON.stringify(updates)).not.toContain("secret-name.png");
    expect(updates.at(-1)?.progress).toBe(100);
    expect(barsByLabel(updates.at(-1)?.stepState.bars ?? [])).toEqual([
      100, 100,
    ]);
  });
});
