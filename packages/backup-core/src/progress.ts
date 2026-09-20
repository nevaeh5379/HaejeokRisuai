export interface BackupProgressInput {
  current?: number;
  total?: number;
  detail?: string;
  percent?: number;
}

export interface BackupProgressView<TStage extends string> {
  stage: TStage;
  label: string;
  percent: number;
  steps: string[];
  currentStep: number;
  currentStepRatio: number;
  current: number;
  total: number;
  detail?: string;
}

export type BackupProgressRanges<TStage extends string> = Record<
  TStage,
  readonly [start: number, end: number]
>;

export interface CreateBackupProgressReporterOptions<TStage extends string> {
  stages: readonly TStage[];
  ranges: BackupProgressRanges<TStage>;
  label(stage: TStage): string;
  report(view: BackupProgressView<TStage>): void;
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Builds a UI-neutral staged progress reporter from injected labels/output. */
export function createBackupProgressReporter<TStage extends string>(
  options: CreateBackupProgressReporterOptions<TStage>,
): (stage: TStage, input?: BackupProgressInput) => void {
  const steps: string[] = options.stages.map((stage: TStage): string =>
    options.label(stage),
  );
  return (stage: TStage, input: BackupProgressInput = {}): void => {
    const [start, end]: readonly [number, number] = options.ranges[stage];
    const total: number = Math.max(0, Math.floor(input.total ?? 0));
    const current: number = Math.max(
      0,
      Math.min(total, Math.floor(input.current ?? 0)),
    );
    const ratio: number = total > 0 ? current / total : 0;
    const percent: number = input.percent ?? start + (end - start) * ratio;
    const currentStepRatio: number =
      total > 0
        ? clampRatio(ratio)
        : end > start
          ? clampRatio((percent - start) / (end - start))
          : 1;
    options.report({
      stage,
      label: options.label(stage),
      percent,
      steps,
      currentStep: options.stages.indexOf(stage),
      currentStepRatio,
      current,
      total,
      detail: input.detail,
    });
  };
}
