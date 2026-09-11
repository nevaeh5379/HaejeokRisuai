export type LocalBackupOperationKind = "save" | "partial-save" | "restore";
export type LocalBackupActiveKind = LocalBackupOperationKind | "other-context";

const LOCAL_BACKUP_LOCK_NAME = "risuai.local-backup-operation.v1";

type CrossContextLockManager = {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: object | null) => Promise<T> | T,
  ): Promise<T>;
};

export class LocalBackupOperationBusyError extends Error {
  constructor(
    readonly activeKind: LocalBackupActiveKind,
    readonly requestedKind: LocalBackupOperationKind,
  ) {
    const activeLabel =
      activeKind === "other-context"
        ? "operation in another window"
        : activeKind;
    super(
      `A local backup ${activeLabel} is already in progress. Wait for it to finish before starting ${requestedKind}.`,
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

function defaultLockManager(): CrossContextLockManager | null {
  const locks = globalThis.navigator?.locks;
  if (!locks || typeof locks.request !== "function") return null;
  return locks as unknown as CrossContextLockManager;
}

async function runInProcess<T>(
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

export async function runExclusiveLocalBackupOperation<T>(
  kind: LocalBackupOperationKind,
  operation: () => Promise<T>,
  lockManager: CrossContextLockManager | null = defaultLockManager(),
): Promise<T> {
  if (activeOperation) {
    throw new LocalBackupOperationBusyError(activeOperation.kind, kind);
  }
  if (!lockManager) return await runInProcess(kind, operation);

  return await lockManager.request(
    LOCAL_BACKUP_LOCK_NAME,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new LocalBackupOperationBusyError("other-context", kind);
      }
      return await runInProcess(kind, operation);
    },
  );
}

export { LOCAL_BACKUP_LOCK_NAME };
