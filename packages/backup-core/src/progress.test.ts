import { describe, expect, it, vi } from "vitest";
import { createBackupProgressReporter } from "./progress";

type Stage = "read" | "write";

describe("createBackupProgressReporter", (): void => {
  it("maps item progress into the configured stage range", (): void => {
    const report = vi.fn();
    const update = createBackupProgressReporter<Stage>({
      stages: ["read", "write"],
      ranges: { read: [0, 40], write: [40, 100] },
      label: (stage: Stage): string => stage.toUpperCase(),
      report,
    });

    update("write", { current: 1, total: 4, detail: "asset" });

    expect(report).toHaveBeenCalledWith({
      stage: "write",
      label: "WRITE",
      percent: 55,
      steps: ["READ", "WRITE"],
      currentStep: 1,
      currentStepRatio: 0.25,
      current: 1,
      total: 4,
      detail: "asset",
    });
  });

  it("clamps counts and an explicit percent to the stage ratio", (): void => {
    const views: Array<{ current: number; currentStepRatio: number }> = [];
    const update = createBackupProgressReporter<Stage>({
      stages: ["read", "write"],
      ranges: { read: [0, 40], write: [40, 100] },
      label: (stage: Stage): string => stage,
      report: (view): void => {
        views.push(view);
      },
    });

    update("read", { current: 9, total: 2 });
    update("write", { percent: 130 });

    expect(
      views.map(
        (view): { current: number; currentStepRatio: number } => ({
          current: view.current,
          currentStepRatio: view.currentStepRatio,
        }),
      ),
    ).toEqual([
      { current: 2, currentStepRatio: 1 },
      { current: 0, currentStepRatio: 1 },
    ]);
  });
});
