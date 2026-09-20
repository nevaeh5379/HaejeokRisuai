import { BaseDirectory, mkdir, writeFile } from "@tauri-apps/plugin-fs";
import {
  BoundedAssetBatchWriter,
  writeItemsConcurrently,
  type RestoredAssetBatch,
} from "@risuai/backup-core/restoreBatch";
import { forageStorage } from "../globalApi.svelte";
import { NodeStorage } from "../storage/files/nodeStorage";

export type LocalBackupAssetRestoreMode = "node" | "tauri" | "browser";

async function writeTauriAssetBatch(
  batch: RestoredAssetBatch,
  createdDirectories: Set<string>,
): Promise<void> {
  const entries: Array<[string, Uint8Array]> = Array.from(batch);
  const directories: Set<string> = new Set<string>(
    entries.map(([assetPath]: [string, Uint8Array]): string =>
      assetPath.slice(0, assetPath.lastIndexOf("/")),
    ),
  );
  await Promise.all(
    Array.from(directories)
      .filter(
        (directory: string): boolean => !createdDirectories.has(directory),
      )
      .map(async (directory: string): Promise<void> => {
        await mkdir(directory, {
          baseDir: BaseDirectory.AppData,
          recursive: true,
        });
        createdDirectories.add(directory);
      }),
  );
  await writeItemsConcurrently(
    entries,
    8,
    async (entry: [string, Uint8Array]): Promise<void> => {
      const [assetPath, data]: [string, Uint8Array] = entry;
      await writeFile(assetPath, data, { baseDir: BaseDirectory.AppData });
    },
  );
}

async function getLocalForageIdb(): Promise<{
  db: IDBDatabase;
  storeName: string;
} | null> {
  try {
    const storage: {
      ready?: () => Promise<void>;
      _dbInfo?: { db?: IDBDatabase; storeName?: string };
    } = forageStorage.realStorage as {
      ready?: () => Promise<void>;
      _dbInfo?: { db?: IDBDatabase; storeName?: string };
    };
    if (typeof storage.ready !== "function") return null;
    await storage.ready();
    const dbInfo: { db?: IDBDatabase; storeName?: string } | undefined =
      storage._dbInfo;
    return dbInfo?.db && dbInfo.storeName
      ? { db: dbInfo.db, storeName: dbInfo.storeName }
      : null;
  } catch {
    return null;
  }
}

async function writeBrowserAssetEntries(
  entries: Array<[string, Uint8Array]>,
): Promise<void> {
  await writeItemsConcurrently(
    entries,
    8,
    async ([key, data]: [string, Uint8Array]): Promise<void> => {
      await forageStorage.setItem(key, data);
    },
  );
}

async function writeBrowserAssetBatch(
  batch: RestoredAssetBatch,
): Promise<void> {
  const entries: Array<[string, Uint8Array]> = Array.from(batch);
  try {
    const idb: { db: IDBDatabase; storeName: string } | null =
      await getLocalForageIdb();
    if (idb) {
      await new Promise<void>((resolve, reject): void => {
        const transaction: IDBTransaction = idb.db.transaction(
          idb.storeName,
          "readwrite",
        );
        const store: IDBObjectStore = transaction.objectStore(idb.storeName);
        for (const [key, data] of entries) store.put(data, key);
        transaction.oncomplete = (): void => resolve();
        transaction.onerror = (): void =>
          reject(transaction.error ?? new Error("IndexedDB bulk write failed"));
        transaction.onabort = (): void =>
          reject(
            transaction.error ?? new Error("IndexedDB bulk write aborted"),
          );
      });
      return;
    }
  } catch (error: unknown) {
    console.warn(
      "IndexedDB bulk asset write failed, falling back to per-item writes:",
      error,
    );
  }
  await writeBrowserAssetEntries(entries);
}

export function createLocalBackupAssetBatchWriter(
  mode: LocalBackupAssetRestoreMode,
): BoundedAssetBatchWriter {
  if (mode === "tauri") {
    const createdDirectories: Set<string> = new Set<string>();
    return new BoundedAssetBatchWriter(
      128,
      64 * 1024 * 1024,
      async (batch: RestoredAssetBatch): Promise<void> =>
        await writeTauriAssetBatch(batch, createdDirectories),
    );
  }
  if (mode === "node") {
    return new BoundedAssetBatchWriter(
      64,
      64 * 1024 * 1024,
      async (batch: RestoredAssetBatch): Promise<void> => {
        await (forageStorage.realStorage as NodeStorage).setItems(batch);
      },
    );
  }
  return new BoundedAssetBatchWriter(
    256,
    64 * 1024 * 1024,
    writeBrowserAssetBatch,
  );
}
