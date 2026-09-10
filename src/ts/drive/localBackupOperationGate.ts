export type LocalBackupOperationKind = "save" | "partial-save" | "restore";

export class LocalBackupOperationBusyError extends Error {
  constructor(
    readonly activeKind: LocalBackupOperationKind,
    readonly requestedKind: LocalBackupOperationKind,
  ) {
    super(
      `A local backup ${activeKind} operation is already in progress. Wait for it to finish before starting ${requestedKind}.`,
    );
    this.name = "LocalBackupOperationBusyError";
  }
}

type ActiveOperation = {
  kind: LocalBackupOperationKind;
  startedAt: number;
};

let activeOperation: ActiveOperation | null = null;

export function getActiveLocalBackupOperation(): ActiveOperation | null {
  return activeOperation ? { ...activeOperation } : null;
}

export async function runExclusiveLocalBackupOperation<T>(
  kind: LocalBackupOperationKind,
  operation: () => Promise<T>,
): Promise<T> {
  if (activeOperation) {
    throw new LocalBackupOperationBusyError(activeOperation.kind, kind);
  }
  activeOperation = { kind, startedAt: Date.now() };
  try {
    return await operation();
  } finally {
    activeOperation = null;
  }
}
