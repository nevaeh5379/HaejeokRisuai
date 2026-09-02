import type { ISqlStorage } from "./ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "./sqlCommit";
import { beginSave } from "./saveActivity.svelte";

const storageQueues = new WeakMap<ISqlStorage, Promise<void>>();

function conflictRevision(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "currentRevision" in error &&
    Number.isSafeInteger((error as { currentRevision?: unknown }).currentRevision)
  ) {
    return (error as { currentRevision: number }).currentRevision;
  }
  return null;
}

/**
 * Serializes commits that share a backend and rebases them at the moment they
 * are written. A single retry handles a revision advanced by another client.
 */
export function commitSqlChanges(
  storage: ISqlStorage,
  commit: SqlCommit,
): Promise<SqlCommitResult> {
  const finishSave = beginSave();
  const previous = storageQueues.get(storage) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const rebased = { ...commit, baseRevision: storage.getRevision() };
    try {
      return await storage.commit(rebased);
    } catch (error) {
      const currentRevision = conflictRevision(error);
      if (currentRevision === null) throw error;
      return storage.commit({ ...rebased, baseRevision: currentRevision });
    }
  });
  const trackedOperation = operation.finally(finishSave);
  storageQueues.set(
    storage,
    trackedOperation.then(
      () => undefined,
      () => undefined,
    ),
  );
  return trackedOperation;
}
