import { language } from "src/lang";
import {
  LOCAL_BACKUP_PROGRESS_STAGES,
  type LocalBackupImportJobStatus,
  type LocalBackupImportProgress,
  type LocalBackupProgressStage,
} from "@risuai/backup-core/api";
import { classifyBackupEntry } from "@risuai/backup-core/entryPolicy";
import {
  createBackupProgressReporter,
  type BackupProgressInput,
  type BackupProgressView,
} from "@risuai/backup-core/progress";

export type LocalBackupRestoreStage =
  "selectingSource" | "reading" | "database" | "branches" | "finalizing";

export interface LocalBackupProgressStepState {
  steps: string[];
  currentStep: number;
  currentStepRatio?: number;
  bars?: LocalBackupProgressBar[];
}

export interface LocalBackupProgressBar {
  label: string;
  progress: number;
  detail?: string;
}

export type LocalBackupProgressOutput = (
  message: string,
  progress: number,
  stepState: LocalBackupProgressStepState,
) => void;

export interface LocalBackupProgressReporters {
  exportProgress(
    stage: LocalBackupProgressStage,
    input?: BackupProgressInput,
  ): void;
  restoreProgress(
    stage: LocalBackupRestoreStage,
    input?: BackupProgressInput,
  ): void;
}

export interface NodeLocalBackupRestoreProgressReporter {
  start(totalBytes?: number): void;
  updateUpload(current: number, total: number): void;
  updateRemote(
    progress: LocalBackupImportProgress | undefined,
    status?: LocalBackupImportJobStatus,
  ): void;
  complete(): void;
}

const EXPORT_RANGES: Record<
  LocalBackupProgressStage,
  readonly [number, number]
> = {
  selectingDestination: [0, 2],
  preparing: [2, 5],
  database: [5, 60],
  coldStorage: [60, 68],
  assets: [68, 92],
  inlays: [92, 97],
  finalizing: [97, 100],
};

const RESTORE_STAGES: readonly LocalBackupRestoreStage[] = [
  "selectingSource",
  "reading",
  "database",
  "branches",
  "finalizing",
];

const RESTORE_RANGES: Record<
  LocalBackupRestoreStage,
  readonly [number, number]
> = {
  selectingSource: [0, 2],
  reading: [2, 90],
  database: [90, 98],
  branches: [98, 99.5],
  finalizing: [99.5, 100],
};

function exportLabel(stage: LocalBackupProgressStage): string {
  const labels: Record<LocalBackupProgressStage, string> = {
    selectingDestination: language.localBackupProgressSelectingDestination,
    preparing: language.localBackupProgressPreparing,
    database: language.localBackupProgressDatabase,
    coldStorage: language.localBackupProgressColdStorage,
    assets: language.localBackupProgressAssets,
    inlays: language.localBackupProgressInlays,
    finalizing: language.localBackupProgressFinalizing,
  };
  return labels[stage];
}

function restoreLabel(stage: LocalBackupRestoreStage): string {
  const labels: Record<LocalBackupRestoreStage, string> = {
    selectingSource: language.localBackupRestoreSelectingSource,
    reading: language.localBackupRestoreReading,
    database: language.localBackupRestoreDatabase,
    branches: language.localBackupRestoreBranches,
    finalizing: language.localBackupRestoreFinalizing,
  };
  return labels[stage];
}

function emitProgress<TStage extends string>(
  output: LocalBackupProgressOutput,
  view: BackupProgressView<TStage>,
): void {
  const count: string =
    view.total > 0 ? ` (${view.current} / ${view.total})` : "";
  const detail: string = view.detail ? `\n${view.detail}` : "";
  output(`${view.label}${count}${detail}`, view.percent, {
    steps: view.steps,
    currentStep: view.currentStep,
    currentStepRatio: view.currentStepRatio,
  });
}

export function createLocalBackupProgressReporters(
  output: LocalBackupProgressOutput,
): LocalBackupProgressReporters {
  return {
    exportProgress: createBackupProgressReporter({
      stages: LOCAL_BACKUP_PROGRESS_STAGES,
      ranges: EXPORT_RANGES,
      label: exportLabel,
      report(view: BackupProgressView<LocalBackupProgressStage>): void {
        emitProgress(output, view);
      },
    }),
    restoreProgress: createBackupProgressReporter({
      stages: RESTORE_STAGES,
      ranges: RESTORE_RANGES,
      label: restoreLabel,
      report(view: BackupProgressView<LocalBackupRestoreStage>): void {
        emitProgress(output, view);
      },
    }),
  };
}

function boundedProgressRatio(current: number, total: number): number | null {
  const safeCurrent: number = Math.max(0, Number(current) || 0);
  const safeTotal: number = Math.max(0, Number(total) || 0);
  if (safeTotal <= 0) return null;
  return Math.max(0, Math.min(1, safeCurrent / safeTotal));
}

/**
 * Keeps the client upload and server restore lanes independent. Their updates
 * can arrive out of order while a remote Node restore is running, so each lane
 * is monotonic and the mascot follows only their monotonic aggregate.
 */
export function createNodeLocalBackupRestoreProgressReporter(
  output: LocalBackupProgressOutput,
  startPercent = 2,
): NodeLocalBackupRestoreProgressReporter {
  let uploadRatio: number = 0;
  let restoreRatio: number = 0;
  let uploadBytes: number = 0;
  let uploadTotalBytes: number = 0;
  let restoreBytes: number = 0;
  let restoreTotalBytes: number = 0;
  let completed: boolean = false;
  let message: string = language.localBackupRestoreReading;

  const byteDetail = (current: number, total: number): string | undefined =>
    total > 0
      ? `${formatBackupBytes(current)} / ${formatBackupBytes(total)}`
      : undefined;

  const emit = (): void => {
    const aggregateRatio: number = (uploadRatio + restoreRatio) / 2;
    const percent: number = completed
      ? 100
      : startPercent + (99.5 - startPercent) * aggregateRatio;
    output(message, percent, {
      steps: RESTORE_STAGES.map(restoreLabel),
      currentStep: completed ? RESTORE_STAGES.indexOf("finalizing") : 1,
      currentStepRatio: completed ? 1 : aggregateRatio,
      bars: [
        {
          label: language.localBackupRestoreUploading,
          progress: uploadRatio * 100,
          detail: byteDetail(uploadBytes, uploadTotalBytes),
        },
        {
          label: language.localBackupRestoreProcessing,
          progress: restoreRatio * 100,
          detail: byteDetail(restoreBytes, restoreTotalBytes),
        },
      ],
    });
  };

  return {
    start(totalBytes = 0): void {
      const safeTotal: number = Math.max(0, Number(totalBytes) || 0);
      uploadTotalBytes = safeTotal;
      restoreTotalBytes = safeTotal;
      emit();
    },
    updateUpload(current: number, total: number): void {
      const ratio: number | null = boundedProgressRatio(current, total);
      if (ratio !== null && ratio >= uploadRatio) {
        uploadRatio = ratio;
        uploadTotalBytes = Math.max(0, Number(total) || 0);
        uploadBytes = Math.min(
          uploadTotalBytes,
          Math.max(0, Number(current) || 0),
        );
      }
      emit();
    },
    updateRemote(
      progress: LocalBackupImportProgress | undefined,
      status?: LocalBackupImportJobStatus,
    ): void {
      if (status === "complete") {
        uploadRatio = 1;
        restoreRatio = 1;
        uploadBytes = uploadTotalBytes;
        restoreBytes = restoreTotalBytes;
        completed = true;
        message = language.localBackupRestoreFinalizing;
        emit();
        return;
      }
      if (!progress?.stage) return;

      if (progress.stage === "uploading" || progress.stage === "reading") {
        const ratio: number | null = boundedProgressRatio(
          progress.current ?? 0,
          progress.total ?? 0,
        );
        if (ratio !== null && ratio >= restoreRatio) {
          restoreRatio = ratio;
          restoreTotalBytes = Math.max(0, Number(progress.total) || 0);
          restoreBytes = Math.min(
            restoreTotalBytes,
            Math.max(0, Number(progress.current) || 0),
          );
        }
      } else if (progress.stage === "database") {
        message = language.localBackupRestoreDatabase;
        const ratio: number | null = boundedProgressRatio(
          progress.current ?? 0,
          progress.total ?? 0,
        );
        if (ratio === 1) {
          restoreRatio = 1;
          restoreBytes = restoreTotalBytes;
        }
      } else if (progress.stage === "finalizing") {
        message = language.localBackupRestoreFinalizing;
        restoreRatio = 1;
        restoreBytes = restoreTotalBytes;
      } else {
        message = language.localBackupRestoreReading;
      }
      emit();
    },
    complete(): void {
      uploadRatio = 1;
      restoreRatio = 1;
      uploadBytes = uploadTotalBytes;
      restoreBytes = restoreTotalBytes;
      completed = true;
      message = language.localBackupRestoreFinalizing;
      emit();
    },
  };
}

export function formatBackupBytes(bytes: number): string {
  const value: number = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${Math.round(value)} B`;
  const units: readonly string[] = ["KiB", "MiB", "GiB", "TiB"];
  let scaled: number = value / 1024;
  let unitIndex: number = 0;
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024;
    unitIndex += 1;
  }
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[unitIndex]}`;
}

function restoreEntryLabel(name: string): string {
  const labels: Partial<
    Record<ReturnType<typeof classifyBackupEntry>["kind"], string>
  > = {
    database: language.localBackupRestoreReadingDatabase,
    databaseStream: language.localBackupRestoreReadingDatabase,
    asset: language.localBackupRestoreReadingAssets,
    inlay: language.localBackupRestoreReadingInlays,
    coldStorage: language.localBackupRestoreReadingColdStorage,
  };
  return labels[classifyBackupEntry(name).kind] ?? "";
}

export function formatLocalBackupReadProgress(
  entryName: string,
  bytesRead: number,
  totalBytes: number,
): string {
  const entryLabel: string = entryName ? restoreEntryLabel(entryName) : "";
  const byteProgress: string =
    totalBytes > 0
      ? `${formatBackupBytes(bytesRead)} / ${formatBackupBytes(totalBytes)}`
      : formatBackupBytes(bytesRead);
  return entryLabel ? `${byteProgress} · ${entryLabel}` : byteProgress;
}
