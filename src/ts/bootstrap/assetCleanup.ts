import {
  exists,
  mkdir,
  readDir,
  readFile,
  remove,
  writeFile,
  BaseDirectory,
} from "@tauri-apps/plugin-fs";
import {
  forageStorage,
  getBasename,
  getUncleanables,
} from "../globalApi.svelte";
import { isNodeServer, isTauri } from "../platform";
import {
  getRemoteSaveCleanupAction,
  getRemoteSavePayloadName,
} from "../storage/backup/remoteSaveCleanup";
import type { Database } from "../storage/database/schema";
import { getSqlRuntime } from "../storage/sql/sqlRuntime";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

/**
 * Minimal file operations the startup asset sweep needs. Lets the cleanup
 * algorithm be written once and run against both the Tauri app-data
 * directory and the browser forage storage.
 */
interface StartupFs {
  /** Full keys of all entries below `dir` (e.g. "assets/foo.bin"). */
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, data: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

function createTauriStartupFs(): StartupFs {
  const base = { baseDir: BaseDirectory.AppData };
  return {
    async list(dir) {
      // "remotes" is created on first run so the sweep below sees it.
      // The same guard keeps a missing "assets" dir from throwing.
      if (!(await exists(dir, base))) {
        await mkdir(dir, base);
      }
      const entries = await readDir(dir, base);
      return entries.map((entry) => `${dir}/${entry.name}`);
    },
    async exists(path) {
      return exists(path, base);
    },
    async read(path) {
      return readFile(path, base);
    },
    async write(path, data) {
      await writeFile(path, data, base);
    },
    async remove(path) {
      await remove(path, base);
    },
  };
}

function createForageStartupFs(): StartupFs {
  return {
    async list(dir) {
      const prefix = `${dir}/`;
      return (await forageStorage.keys()).filter((key) =>
        key.startsWith(prefix),
      );
    },
    async exists(path) {
      return (await forageStorage.keys()).includes(path);
    },
    async read(path) {
      return (await forageStorage.getItem(
        path,
      )) as unknown as Uint8Array | null;
    },
    async write(path, data) {
      await forageStorage.setItem(path, data);
    },
    async remove(path) {
      await forageStorage.removeItem(path);
    },
  };
}

/**
 * Deletes every entry under `dir` whose basename is not in `uncleanable`.
 * `uncleanable` is keyed by basename, and `getBasename` normalizes both
 * bare names (Tauri) and full keys (forage), so one loop serves both.
 */
async function sweepUncleanableAssets(
  fs: StartupFs,
  dir: string,
  uncleanable: Set<string>,
): Promise<void> {
  const keys = await fs.list(dir);
  for (const key of keys) {
    try {
      const basename = getBasename(key);
      if (!uncleanable.has(basename)) {
        await fs.remove(key);
      }
    } catch (error) {
      console.log("error", key);
    }
  }
}

/**
 * Removes remote save payloads that are no longer referenced by any
 * character. Stale entries get a `.meta` bookkeeping file on first sight
 * and are only deleted once they stayed unused beyond the cleanup grace
 * period. The policy (including the grace duration) lives in
 * `remoteSaveCleanup.ts` so it stays defined in exactly one place.
 */
async function cleanupRemoteSaves(
  fs: StartupFs,
  activeCharacterIds: Set<string>,
): Promise<void> {
  const keys = await fs.list("remotes");
  for (const key of keys) {
    try {
      const fileName = getBasename(key);
      const payloadName = getRemoteSavePayloadName(fileName);
      if (!payloadName || activeCharacterIds.has(payloadName)) {
        continue;
      }
      const metaPath = `${key}.meta`;
      let hasMeta = false;
      let metaLastUsed: unknown;
      try {
        const meta = await fs.read(metaPath);
        if (meta) {
          hasMeta = true;
          const metaJson = JSON.parse(new TextDecoder().decode(meta));
          metaLastUsed = metaJson.lastUsed;
        }
      } catch (error) {}

      const cleanupAction = getRemoteSaveCleanupAction({
        fileName,
        activeCharacterIds,
        hasMeta,
        metaLastUsed,
      });
      if (cleanupAction === "create-meta") {
        await fs.write(
          metaPath,
          new TextEncoder().encode(JSON.stringify({ lastUsed: Date.now() })),
        );
      } else if (cleanupAction === "delete") {
        await fs.remove(key);
        await fs.remove(metaPath);
      }
    } catch (error) {
      console.log("error", key);
    }
  }
}

/**
 * Purges chunks of data that are not needed.
 */
export async function cleanChunks(): Promise<void> {
  const db = settingsStore.state;
  // SQL startup intentionally keeps character details lazy. A destructive
  // asset sweep cannot prove that images referenced by unhydrated fields
  // (emotionImages/additionalAssets/VITS/etc.) are unused, so never delete
  // local assets from a partial SQL snapshot.
  if (isNodeServer || getSqlRuntime().isSql) {
    return;
  }
  if (db.coldstorage) {
    return;
  }

  const uncleanable = new Set(
    await getUncleanables(db as Database, "basename", {
      chars: characterStore.characters,
    }),
  );

  const fs: StartupFs = isTauri
    ? createTauriStartupFs()
    : createForageStartupFs();
  await sweepUncleanableAssets(fs, "assets", uncleanable);
  await cleanupRemoteSaves(
    fs,
    new Set(characterStore.characters.map((v) => v.chaId)),
  );
}
