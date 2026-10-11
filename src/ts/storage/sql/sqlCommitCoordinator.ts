import type { ISqlStorage } from "./ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "./sqlCommit";
import { beginSave } from "./saveActivity.svelte";

const storageQueues = new WeakMap<ISqlStorage, Promise<void>>();

function conflictRevision(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "currentRevision" in error &&
    Number.isSafeInteger(
      (error as { currentRevision?: unknown }).currentRevision,
    )
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
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
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

/**
 * Serializes an illustration message mutation with other SQL saves and rebuilds it on conflicts.
 *
 * 한국어: 다른 SQL 저장과 삽화 메시지 변경을 순차 처리하고 충돌 시 변경 내용을 다시 준비하는 함수.
 *
 * @param storage - Storage instance whose save queue and revision are used. / 저장 큐·리비전을 사용할 저장소.
 * @param prepare - Fresh read/validation producing a commit and result, or null when invalidated. / 최신 조회·검증 후 저장·결과를 만들거나 무효화 시 null을 반환하는 함수.
 * @returns The durably committed result, or null when preparation rejects the target. / 영구 저장한 결과 또는 준비 단계에서 대상 무효화 시 null.
 * @remarks
 * Captures the revision before reading, retries at most three times and reruns prepare each time.
 * Never rebases an already prepared message body onto a newer revision.
 * 한국어: 조회 전에 리비전을 확보하고 최대 3회 시도하며 매번 prepare를 다시 실행.
 * 이미 준비한 메시지 본문을 새 리비전에 그대로 적용하지 않는 방식.
 */
export function mutateSqlMessage<T>(
  storage: ISqlStorage,
  prepare: () => Promise<{ commit: SqlCommit; result: T } | null>,
): Promise<T | null> {
  const finishSave = beginSave();
  const previous = storageQueues.get(storage) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      let previousConflict = 0;
      for (let attempt = 0; attempt < 3; attempt++) {
        const revision = Math.max(storage.getRevision(), previousConflict);
        const prepared = await prepare();
        if (!prepared) return null;
        try {
          await storage.commit({
            ...prepared.commit,
            action: "illustration",
            baseRevision: revision,
          });
          return prepared.result;
        } catch (error) {
          const revision = conflictRevision(error);
          if (revision === null || attempt === 2) throw error;
          previousConflict = revision;
        }
      }
      return null;
    })
    .finally(finishSave);
  storageQueues.set(
    storage,
    operation.then(
      () => undefined,
      () => undefined,
    ),
  );
  return operation;
}
