import type { ISqlStorage } from "./ISqlStorage";
import type { SqlCommit, SqlCommitResult } from "./sqlCommit";
import { isCapacitor, isTauri, isNodeServer } from "../../platform";

let storageSingleton: ISqlStorage | null = null;

export type SqlBranchStorage = ISqlStorage & Required<Pick<
  ISqlStorage,
  "listChatBranches" | "loadBranchMessages" | "createChatBranch" | "activateChatBranch"
>>;

const REQUIRED_BRANCH_STORAGE_METHODS = [
  "listChatBranches",
  "loadBranchMessages",
  "createChatBranch",
  "activateChatBranch",
] as const;

/**
 * Wraps a storage backend so that every `commit()` call is serialised.
 * Multiple domain stores (character, settings, message, adapter) share one
 * `baseRevision`; without serialisation their debounced commits race against
 * each other — the first to reach the server bumps the revision and every
 * subsequent commit in the same flush wave gets a 409 conflict.
 *
 * The wrapper chains commits so each one reads `getRevision()` *after* the
 * previous one has updated it, eliminating same-client conflicts.
 */
function wrapWithSerializedCommits(inner: ISqlStorage): ISqlStorage {
  let commitChain: Promise<unknown> = Promise.resolve();

  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "commit") {
        return async (commit: SqlCommit): Promise<SqlCommitResult> => {
          const run = async (): Promise<SqlCommitResult> => {
            commit.baseRevision = target.getRevision();
            return await target.commit(commit);
          };
          commitChain = commitChain.then(run, run);
          return commitChain as Promise<SqlCommitResult>;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Returns the appropriate SQL storage backend for the current environment.
 *
 * - Node server: NodePostgresStorage (external PostgreSQL/Oracle/Azure)
 * - Tauri desktop: TauriSqliteStorage (local SQLite via tauri-plugin-sql)
 * - Web browser: WebSqliteStorage (SQLite WASM with OPFS)
 *
 * The instance is cached for the lifetime of the page. Commits are serialised
 * so concurrent domain stores don't race on the shared revision.
 */
export async function getSqlStorage(): Promise<ISqlStorage> {
  if (storageSingleton) {
    return storageSingleton;
  }

  if (isNodeServer) {
    // Node server uses NodePostgresStorage via NodeStorage
    const { forageStorage } = await import("../../globalApi.svelte");
    const { NodeStorage } = await import("../files/nodeStorage");
    if (forageStorage.realStorage instanceof NodeStorage) {
      storageSingleton = wrapWithSerializedCommits(
        forageStorage.realStorage.postgres as unknown as ISqlStorage,
      );
      return storageSingleton;
    }
    // Fallback: create a standalone NodePostgresStorage
    const { NodePostgresStorage } = await import("./postgres/nodePostgresStorage");
    storageSingleton = wrapWithSerializedCommits(
      new NodePostgresStorage(async () => "") as unknown as ISqlStorage,
    );
    return storageSingleton;
  }

  if (isCapacitor) {
    const { CapacitorSqliteStorage } = await import("./sqlite/capacitor/capacitorSqliteStorage");
    storageSingleton = wrapWithSerializedCommits(new CapacitorSqliteStorage());
    return storageSingleton;
  }

  if (isTauri) {
    const { TauriSqliteStorage } = await import("./sqlite/tauri/tauriSqliteStorage");
    storageSingleton = wrapWithSerializedCommits(new TauriSqliteStorage());
    return storageSingleton;
  }

  // Web browser
  const { WebSqliteStorage } = await import("./sqlite/web/webSqliteStorage");
  storageSingleton = wrapWithSerializedCommits(new WebSqliteStorage());
  return storageSingleton;
}

/**
 * Returns the branch-capable storage contract. Branch features are not allowed
 * to silently fall back to the legacy in-memory branchState implementation.
 */
export async function getSqlBranchStorage(): Promise<SqlBranchStorage> {
  const storage = await getSqlStorage();
  const missing = REQUIRED_BRANCH_STORAGE_METHODS.filter(
    (method) => typeof storage[method] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `Persistent chat branch storage is required; missing API: ${missing.join(", ")}`,
    );
  }
  return storage as SqlBranchStorage;
}

/**
 * Reset the cached storage instance (used when switching backends, e.g.
 * after configuring SQL on the Node server).
 */
export function resetSqlStorage(): void {
  storageSingleton = null;
}

export function setSqlStorageForTesting(storage: ISqlStorage | null): void {
  storageSingleton = storage ? wrapWithSerializedCommits(storage) : null;
}
