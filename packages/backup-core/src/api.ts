export type LocalBackupMode = "native" | "compatible" | "partial";

export type LocalBackupProgressStage =
  | "selectingDestination"
  | "preparing"
  | "database"
  | "coldStorage"
  | "assets"
  | "inlays"
  | "finalizing";

export interface LocalBackupProgress {
  stage: LocalBackupProgressStage;
  current?: number;
  total?: number;
}

export interface LocalBackupDatabaseStreamSession {
  id: string;
  nextFragmentIndex: number;
  recordCount: number;
  createdAt: number;
  expiresAt: number;
}

export interface LocalBackupDatabaseStreamAppendInput {
  fragmentIndex: number;
  records: unknown[];
  fragmentComplete: boolean;
}

export interface LocalBackupDatabaseStreamFinalizeResult {
  status: "completed";
  revision: number;
  revisionId: number | string;
  sourceRevision: number;
  recordCount: number;
}

export interface LocalBackupExportJobCreateInput {
  mode: LocalBackupMode;
  pageSize: number;
  fragmentRecords: number;
}

export interface LocalBackupExportJobCreated {
  id: string;
}

export type LocalBackupExportJobStatus =
  | "pending"
  | "streaming"
  | "complete"
  | "error";

export interface LocalBackupExportJobProgress {
  status: LocalBackupExportJobStatus;
  progress?: LocalBackupProgress;
}

export interface LocalBackupExportJobCompletion {
  status: LocalBackupExportJobStatus;
  error?: string | null;
}

export class BackupApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupApiContractError";
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function validateLocalBackupDatabaseStreamSession(
  value: unknown,
): LocalBackupDatabaseStreamSession {
  const session =
    value as Partial<LocalBackupDatabaseStreamSession> | null;
  if (
    !session ||
    typeof session.id !== "string" ||
    session.id.length === 0 ||
    !isNonNegativeSafeInteger(session.nextFragmentIndex) ||
    session.nextFragmentIndex < 1 ||
    !isNonNegativeSafeInteger(session.recordCount) ||
    !isNonNegativeSafeInteger(session.createdAt) ||
    !isNonNegativeSafeInteger(session.expiresAt)
  ) {
    throw new BackupApiContractError(
      "The backup API returned an invalid database stream session.",
    );
  }
  return session as LocalBackupDatabaseStreamSession;
}

export function validateLocalBackupDatabaseStreamFinalizeResult(
  value: unknown,
): LocalBackupDatabaseStreamFinalizeResult {
  const result =
    value as Partial<LocalBackupDatabaseStreamFinalizeResult> | null;
  if (
    !result ||
    result.status !== "completed" ||
    !isNonNegativeSafeInteger(result.revision) ||
    !(
      typeof result.revisionId === "string" ||
      isNonNegativeSafeInteger(result.revisionId)
    ) ||
    !isNonNegativeSafeInteger(result.sourceRevision) ||
    !isNonNegativeSafeInteger(result.recordCount)
  ) {
    throw new BackupApiContractError(
      "The backup API returned an invalid database stream finalize result.",
    );
  }
  return result as LocalBackupDatabaseStreamFinalizeResult;
}

export function validateLocalBackupExportJobCreated(
  value: unknown,
): LocalBackupExportJobCreated {
  const result = value as Partial<LocalBackupExportJobCreated> | null;
  if (!result || typeof result.id !== "string" || result.id.length === 0) {
    throw new BackupApiContractError(
      "The backup API returned an invalid export job.",
    );
  }
  return result as LocalBackupExportJobCreated;
}

export function validateLocalBackupExportJobProgress(
  value: unknown,
): LocalBackupExportJobProgress {
  const result = value as Partial<LocalBackupExportJobProgress> | null;
  const validStatuses: LocalBackupExportJobStatus[] = [
    "pending",
    "streaming",
    "complete",
    "error",
  ];
  if (!result || !validStatuses.includes(result.status as LocalBackupExportJobStatus)) {
    throw new BackupApiContractError(
      "The backup API returned an invalid export progress response.",
    );
  }
  const progress = result.progress;
  if (progress !== undefined) {
    const stages: LocalBackupProgressStage[] = [
      "selectingDestination",
      "preparing",
      "database",
      "coldStorage",
      "assets",
      "inlays",
      "finalizing",
    ];
    if (
      !progress ||
      !stages.includes(progress.stage as LocalBackupProgressStage) ||
      (progress.current !== undefined &&
        !isNonNegativeSafeInteger(progress.current)) ||
      (progress.total !== undefined &&
        !isNonNegativeSafeInteger(progress.total))
    ) {
      throw new BackupApiContractError(
        "The backup API returned invalid export progress data.",
      );
    }
  }
  return result as LocalBackupExportJobProgress;
}

export function validateLocalBackupExportJobCompletion(
  value: unknown,
): LocalBackupExportJobCompletion {
  const result = value as Partial<LocalBackupExportJobCompletion> | null;
  const validStatuses: LocalBackupExportJobStatus[] = [
    "pending",
    "streaming",
    "complete",
    "error",
  ];
  if (
    !result ||
    !validStatuses.includes(result.status as LocalBackupExportJobStatus) ||
    !(
      result.error === undefined ||
      result.error === null ||
      typeof result.error === "string"
    )
  ) {
    throw new BackupApiContractError(
      "The backup API returned an invalid export completion response.",
    );
  }
  return result as LocalBackupExportJobCompletion;
}
