export const LOCAL_BACKUP_PERFORMANCE_LIMITS = {
  databasePageRecords: { min: 1, max: 500 },
  fragmentRecords: { min: 1, max: 256 },
  writerBufferKiB: { min: 256, max: 16 * 1024 },
  progressUpdateMs: { min: 50, max: 2_000 },
} as const;

export const DEFAULT_LOCAL_BACKUP_PERFORMANCE = {
  databasePageRecords: 128,
  fragmentRecords: 128,
  writerBufferKiB: 1024,
  progressUpdateMs: 200,
} as const;

export interface LocalBackupPerformanceSettings {
  databasePageRecords: number;
  fragmentRecords: number;
  writerBufferKiB: number;
  progressUpdateMs: number;
}

export interface LocalBackupPerformanceInput {
  localBackupDatabasePageRecords?: unknown;
  localBackupFragmentRecords?: unknown;
  localBackupWriterBufferKiB?: unknown;
  localBackupProgressUpdateMs?: unknown;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  limits: { readonly min: number; readonly max: number },
): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(limits.min, Math.min(limits.max, Math.round(numeric)));
}

export function normalizeLocalBackupPerformance(
  input: LocalBackupPerformanceInput,
): LocalBackupPerformanceSettings {
  return {
    databasePageRecords: boundedInteger(
      input.localBackupDatabasePageRecords,
      DEFAULT_LOCAL_BACKUP_PERFORMANCE.databasePageRecords,
      LOCAL_BACKUP_PERFORMANCE_LIMITS.databasePageRecords,
    ),
    fragmentRecords: boundedInteger(
      input.localBackupFragmentRecords,
      DEFAULT_LOCAL_BACKUP_PERFORMANCE.fragmentRecords,
      LOCAL_BACKUP_PERFORMANCE_LIMITS.fragmentRecords,
    ),
    writerBufferKiB: boundedInteger(
      input.localBackupWriterBufferKiB,
      DEFAULT_LOCAL_BACKUP_PERFORMANCE.writerBufferKiB,
      LOCAL_BACKUP_PERFORMANCE_LIMITS.writerBufferKiB,
    ),
    progressUpdateMs: boundedInteger(
      input.localBackupProgressUpdateMs,
      DEFAULT_LOCAL_BACKUP_PERFORMANCE.progressUpdateMs,
      LOCAL_BACKUP_PERFORMANCE_LIMITS.progressUpdateMs,
    ),
  };
}

export function applyLocalBackupPerformanceDefaults(
  input: LocalBackupPerformanceInput,
): LocalBackupPerformanceSettings {
  const normalized = normalizeLocalBackupPerformance(input);
  input.localBackupDatabasePageRecords = normalized.databasePageRecords;
  input.localBackupFragmentRecords = normalized.fragmentRecords;
  input.localBackupWriterBufferKiB = normalized.writerBufferKiB;
  input.localBackupProgressUpdateMs = normalized.progressUpdateMs;
  return normalized;
}
