import {
  BaseDirectory,
  mkdir,
  readFile,
  readDir,
  writeFile,
} from "@tauri-apps/plugin-fs";
import localforage from "localforage";
import {
  alertError,
  alertNormal,
  alertStore,
  alertWait,
  alertMd,
  alertConfirm,
  alertProgress as showProgressAlert,
  alertClear,
} from "../alert";
import { LocalWriter, forageStorage } from "../globalApi.svelte";
import { isNodeServer, isTauri } from "src/ts/platform";
import {
  decodeRisuSave,
  encodeRisuSaveLegacyAsync,
} from "../storage/risuSave";
import {
  getDatabase,
  normalizeDatabaseDefaults,
  setDatabaseLite,
  type Database,
  type PortableDatabase,
} from "../storage/database.svelte";
import { relaunch } from "@tauri-apps/plugin-process";
import { decryptBuffer, encryptBuffer, sleep } from "../util";
import { hubURL } from "../characterCards";
import { language } from "src/lang";
import {
  collectColdStorageBackupPayloads,
  confirmIncompleteColdStorageOperation,
  getColdStorageBackupKey,
  getColdStorageItem,
  isColdStorageBackupData,
  listColdDataKeys,
  setColdStorageItem,
} from "../process/coldstorage.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { NodeStorage } from "../storage/nodeStorage";
import {
  PROMPT_SETTING_KEYS,
  POSTGRES_DOMAINS,
} from "../storage/databaseAdapters.svelte";
import { getSqlStorage } from "../storage/sqlStorageFactory";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { decryptLegacyAccountBackup } from "./legacyBackupEncryption";
import { stripAdditionalAssetFolderMetadata } from "../assetManagerUtils";
import {
  expandCharactersForCompatibility,
  type ColdStorageValueMap,
} from "../backupCompatibility";

const alertProgress = (msg: string, progress: number | string) =>
  showProgressAlert(msg, progress, "backup");

export function normalizeLocalBackupAssetPath(name: string) {
  const normalizedName = name.replace(/\\/g, "/");
  const segments = normalizedName.split("/");

  while (segments[0] === "assets") {
    segments.shift();
  }

  if (
    segments.length === 0 ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Invalid backup asset path: ${name}`);
  }

  return `assets/${segments.join("/")}`;
}

function getLegacyCompatibleBackupValue(
  key: string,
  value: any,
  coldStorageValues?: ColdStorageValueMap,
) {
  if (key !== "characters" || !Array.isArray(value)) return value;
  return expandCharactersForCompatibility(
    value,
    undefined,
    coldStorageValues,
  ).map((character) =>
    character && typeof character === "object"
      ? stripAdditionalAssetFolderMetadata(character)
      : character,
  );
}

export type LocalBackupMode = "native" | "compatible";

export function buildPortableLocalBackupDatabase(
  db: PortableDatabase,
  mode: LocalBackupMode,
  coldStorageValues?: ColdStorageValueMap,
): Record<string, any> {
  const cleanDb: Record<string, any> = {};
  for (const [key, value] of Object.entries(db)) {
    if (
      key === "account" ||
      typeof value === "function" ||
      (mode === "compatible" && key === "moduleFolders")
    ) continue;
    cleanDb[key] = mode === "compatible"
      ? getLegacyCompatibleBackupValue(key, value, coldStorageValues)
      : value;
  }
  cleanDb.pluginCustomStorage ??= {};
  return cleanDb;
}

const SQL_DOMAIN_ROOT_KEYS: Record<
  (typeof POSTGRES_DOMAINS)[number],
  string[]
> = {
  personas: ["personas"],
  loreBook: ["loreBook"],
  modules: ["modules"],
  prompts: [...PROMPT_SETTING_KEYS],
  scripts: ["globalscript"],
};

function formatBackupElapsed(startedAt: number) {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1000),
  );
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function initializeLocalBackupWriter(
  writer: LocalWriter,
  partial = false,
  mode: LocalBackupMode = "native",
) {
  const label = partial
    ? "Saving partial local backup..."
    : mode === "compatible"
      ? "Saving compatible local backup..."
      : "Saving HaejeokRisuAI local backup...";
  const startedAt = Date.now();
  const waitingDetail = isTauri
    ? "Waiting for the system Save dialog. Choose a file or cancel to continue."
    : "Preparing the browser download stream.";
  const update = () =>
    alertProgress(
      `${label} (Selecting destination)\n${waitingDetail}\nElapsed: ${formatBackupElapsed(startedAt)}`,
      1,
    );
  update();
  const timer = setInterval(update, 1000);
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const defaultName = partial
      ? `haejeokrisu_partial_backup_${dateStr}`
      : mode === "compatible"
        ? `risu_compatible_backup_${dateStr}`
        : `haejeokrisu_backup_${dateStr}`;
    const initialized = await writer.init(defaultName, ["bin", "risubackup"]);
    if (initialized) {
      alertProgress(`${label} (Destination ready; preparing asset list)`, 2);
    }
    return initialized;
  } finally {
    clearInterval(timer);
  }
}

async function saveNodeLocalBackupStream(mode: LocalBackupMode) {
  await forageStorage.Init();
  if (!(forageStorage.realStorage instanceof NodeStorage)) {
    throw new Error("Node local backup requires NodeStorage");
  }
  const auth = await forageStorage.realStorage.getCachedAuth();
  alertProgress(
    mode === "compatible"
      ? "Saving compatible local backup... (Starting server stream)"
      : "Saving HaejeokRisuAI local backup... (Starting server stream)",
    1,
  );
  const response = await fetch(`/api/local-backup/export/jobs?mode=${mode}`, {
    method: "POST",
    headers: { "risu-auth": auth },
  });
  const body = (await response.json().catch(() => null)) as {
    id?: string;
    error?: string;
  } | null;
  if (!response.ok || !body?.id) {
    throw new Error(
      body?.error ?? `Local backup export failed (${response.status})`,
    );
  }
  const completion = fetch(
    `/api/local-backup/export/jobs/${encodeURIComponent(body.id)}`,
    {
      headers: { "risu-auth": auth },
    },
  );
  const anchor = document.createElement("a");
  anchor.href = `/api/local-backup/export/${encodeURIComponent(body.id)}?auth=${encodeURIComponent(auth)}`;
  const dateStr = new Date().toISOString().slice(0, 10);
  anchor.download = mode === "compatible"
    ? `risu_compatible_backup_${dateStr}.risubackup`
    : `haejeokrisu_backup_${dateStr}.risubackup`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  alertProgress(
    "Saving local backup... (Server is streaming directly to the download)",
    50,
  );
  const completed = await completion;
  const completedBody = (await completed.json().catch(() => null)) as {
    status?: string;
    error?: string;
  } | null;
  if (!completed.ok || completedBody?.status !== "complete") {
    throw new Error(
      completedBody?.error ??
        `Local backup download failed (${completed.status})`,
    );
  }
  alertNormal("Success");
}

/**
 * Merge a transactionally consistent full SQL snapshot into the lazy adapter
 * without replacing values that are already loaded (and may still be dirty).
 */
function isChatCompleteForBackup(chat: any, snapshotChat?: any): boolean {
  if (!chat) return false;
  if (chat.messagesLoaded === false || chat.detailsLoaded === false) return false;
  if (chat.messagesFullyLoaded === false) return false;
  if ((chat.messageOffset ?? 0) > 0) return false;

  const messageLength = Array.isArray(chat.message) ? chat.message.length : 0;
  if (typeof chat.messageTotal === "number" && messageLength < chat.messageTotal) {
    return false;
  }

  // Older/lazy shells may not have hydration flags at all. In that case, use
  // the full SQL snapshot as an independent completeness oracle.
  if (chat.messagesFullyLoaded !== true && snapshotChat) {
    const snapshotLength = Array.isArray(snapshotChat.message)
      ? snapshotChat.message.length
      : 0;
    if (messageLength < snapshotLength) return false;
  }

  return true;
}

function mergeSnapshotChats(
  currentChats: any[],
  snapshotChats: any[],
): any[] {
  const currentById = new Map(
    currentChats.filter((chat) => chat?.id).map((chat) => [chat.id, chat]),
  );
  const snapshotIds = new Set<string>();
  const merged = snapshotChats.map((snapshotChat) => {
    if (!snapshotChat?.id) return snapshotChat;
    snapshotIds.add(snapshotChat.id);
    const current = currentById.get(snapshotChat.id);
    if (!current) return snapshotChat;

    if (!isChatCompleteForBackup(current, snapshotChat)) {
      Object.assign(current, snapshotChat, {
        messagesLoaded: true,
        detailsLoaded: true,
        messagesFullyLoaded: true,
        messageOffset: 0,
        messageTotal: snapshotChat.message?.length ?? 0,
      });
    }
    return current;
  });

  // Preserve chats created locally after the storage snapshot was taken.
  for (const current of currentChats) {
    if (!current?.id || !snapshotIds.has(current.id)) merged.push(current);
  }
  return merged;
}

export function hydrateLazyDatabaseFromSnapshot(
  db: Database,
  snapshot: Database,
) {
  const adapter = db as Database & {
    isDomainLoaded?: (domain: string) => boolean;
  };

  for (const domain of POSTGRES_DOMAINS) {
    if (adapter.isDomainLoaded?.(domain)) continue;
    for (const key of SQL_DOMAIN_ROOT_KEYS[domain]) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        (db as any)[key] = (snapshot as any)[key];
      }
    }
  }

  // Plugin custom storage is not one of the adapter's deferred domains.
  // A shallow Node load initializes it to an empty object, so fill it from
  // the full snapshot unless the in-memory value already contains data.
  if (
    snapshot.pluginCustomStorage &&
    Object.keys(db.pluginCustomStorage ?? {}).length === 0
  ) {
    db.pluginCustomStorage = snapshot.pluginCustomStorage;
  }

  // Merge root settings from snapshot if missing in db
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === "characters" || key === "account") continue;
    if ((db as any)[key] === undefined || (db as any)[key] === null) {
      (db as any)[key] = value;
    }
  }

  const snapshotCharacters = new Map(
    (snapshot.characters ?? [])
      .filter((char) => char?.chaId)
      .map((char) => [char.chaId, char]),
  );

  if (!db.characters || db.characters.length === 0) {
    db.characters = snapshot.characters ?? [];
    return;
  }

  const currentCharacterIds = new Set(
    db.characters.filter((char) => char?.chaId).map((char) => char.chaId),
  );

  for (let i = 0; i < db.characters.length; i++) {
    const char = db.characters[i];
    if (!char?.chaId) continue;
    const snapshotChar = snapshotCharacters.get(char.chaId);
    if (!snapshotChar) continue;

    const existingChats = char.chats ?? [];
    const mergedChats = mergeSnapshotChats(
      existingChats,
      snapshotChar.chats ?? [],
    );

    // Keep the existing array identity because Svelte and pending in-memory
    // edits may still hold references to it, while still restoring chats that
    // only exist in the complete SQL snapshot.
    existingChats.splice(0, existingChats.length, ...mergedChats);
    Object.assign(char, snapshotChar, {
      chats: existingChats,
      detailsLoaded: true,
    });
  }

  // A shallow adapter should normally contain every character shell, but a
  // backup must not depend on that invariant. Restore any rows that only exist
  // in the transactionally consistent full snapshot.
  for (const snapshotChar of snapshot.characters ?? []) {
    if (snapshotChar?.chaId && !currentCharacterIds.has(snapshotChar.chaId)) {
      db.characters.push(snapshotChar);
    }
  }
}

async function hydrateDatabaseFromSqlStorage(
  db: Database,
  onProgress?: (msg: string) => void,
) {
  try {
    const { getSqlStorage } = await import("../storage/sqlStorageFactory");
    const storage = await getSqlStorage();
    if (!(await storage.init())) return false;

    const startedAt = Date.now();
    const update = () =>
      onProgress?.(
        `Loading full database snapshot (elapsed ${formatBackupElapsed(startedAt)})`,
      );
    update();
    const timer = setInterval(update, 1000);
    let loaded;
    try {
      loaded = await storage.loadDatabase({ shallow: false });
    } finally {
      clearInterval(timer);
    }
    if (loaded?.status !== "ready" || !loaded.database) return false;
    onProgress?.("Merging database snapshot into backup data...");
    hydrateLazyDatabaseFromSnapshot(db, loaded.database);
    return true;
  } catch (error) {
    console.warn(
      "Bulk SQL backup load failed; falling back to per-entity loaders:",
      error,
    );
    return false;
  }
}

function getBasename(data: string) {
  const baseNameRegex = /\\/g;
  const splited = data.replace(baseNameRegex, "/").split("/");
  const lasts = splited[splited.length - 1];
  return lasts;
}

export async function ensureAllPostgresChatMessagesLoaded(
  db: Database,
  onProgress?: (msg: string) => void,
) {
  try {
    const { getSqlStorage } = await import("../storage/sqlStorageFactory");
    const storage = await getSqlStorage();
    if (!storage.isEnabled()) {
      return;
    }
    const totalChars = (db.characters ?? []).length;
    for (let i = 0; i < totalChars; i++) {
      let char = db.characters[i];
      if (!char) continue;
      if (onProgress) {
        onProgress(`Loading chat messages (${i + 1} / ${totalChars})`);
      }
      if (char.detailsLoaded !== true && char.chaId) {
        const fullChar = await storage.loadCharacter(char.chaId);
        if (fullChar) {
          const existingChats = char.chats ?? [];
          const mergedChats = mergeSnapshotChats(
            existingChats,
            fullChar.chats ?? [],
          );
          existingChats.splice(0, existingChats.length, ...mergedChats);
          db.characters[i] = Object.assign(char, fullChar, {
            chats: existingChats,
            detailsLoaded: true,
          });
          char = db.characters[i];
        }
      }
      for (let j = 0; j < (char.chats ?? []).length; j++) {
        const chat = char.chats[j];
        if (
          chat?.id &&
          (chat.messagesLoaded !== true ||
            chat.detailsLoaded !== true ||
            chat.messagesFullyLoaded !== true ||
            (chat.messageOffset ?? 0) > 0 ||
            (typeof chat.messageTotal === "number" &&
              (chat.message?.length ?? 0) < chat.messageTotal))
        ) {
          const fullChat = await storage.loadChat(chat.id);
          if (fullChat) {
            Object.assign(chat, fullChat);
            chat.messagesLoaded = true;
            chat.detailsLoaded = true;
            chat.messagesFullyLoaded = true;
            chat.messageOffset = 0;
            chat.messageTotal = fullChat.message?.length ?? 0;
          }
        }
      }
    }
  } catch (error) {
    console.error("ensureAllPostgresChatMessagesLoaded failed:", error);
  }
}

export async function ensureDatabaseFullyLoaded(
  db: Database,
  onProgress?: (msg: string) => void,
) {
  const bulkLoaded = await hydrateDatabaseFromSqlStorage(db, onProgress);
  if (!bulkLoaded && typeof (db as any).ensureLoaded === "function") {
    if (onProgress) onProgress("Loading database from storage...");
    await (db as any).ensureLoaded();
  }
  // Even a successful bulk snapshot must be followed by an explicit chat
  // completeness pass. The live adapter can contain partially hydrated shells
  // whose legacy flags are missing or stale.
  await ensureAllPostgresChatMessagesLoaded(db, onProgress);

  try {
    const { getSqlStorage } = await import("../storage/sqlStorageFactory");
    const storage = await getSqlStorage();
    if (
      storage.isEnabled() &&
      (!db.pluginCustomStorage ||
        Object.keys(db.pluginCustomStorage).length === 0)
    ) {
      const pluginStorage = await storage.loadPluginCustomStorage();
      if (pluginStorage && Object.keys(pluginStorage).length > 0) {
        db.pluginCustomStorage = pluginStorage;
      }
    }
  } catch {}

  if (!db.personas || db.personas.length === 0) {
    db.personas = [
      {
        name: db.username || "User",
        icon: db.userIcon || "",
        personaPrompt: "",
        note: db.userNote || "",
        largePortrait: false,
      },
    ];
  } else {
    for (const p of db.personas) {
      if (p) {
        p.largePortrait ??= false;
      }
    }
  }
  if (
    typeof db.selectedPersona !== "number" ||
    db.selectedPersona < 0 ||
    db.selectedPersona >= db.personas.length
  ) {
    db.selectedPersona = 0;
  }
}

export async function SaveLocalBackup(mode: LocalBackupMode = "native") {
  try {
    // Snapshot-based exports must see all debounced metadata changes first.
    // Message writes are immediate, while character/chat metadata and settings
    // are intentionally batched, so flush those queues before reading SQL.
    await Promise.all([characterStore.flush(), settingsStore.flush()]);

    if (isNodeServer && !forageStorage.isAccount) {
      await saveNodeLocalBackupStream(mode);
      return;
    }
    alertProgress("Saving local backup... (Preparing database)", 0);
    await sleep(10);
    const db = getDatabase() as PortableDatabase;
    db.botPresets = (await presetStore.loadAll()).map(
      ({ id: _id, ...preset }) => preset,
    );
    db.botPresetsId = presetStore.activeIndex;
    await ensureDatabaseFullyLoaded(db, (msg) => {
      alertProgress(`Saving local backup... (${msg})`, 0);
    });
    alertProgress("Saving local backup... (Checking cold storage)", 0);
    await sleep(10);
    const coldStoragePayloads = await collectColdStorageBackupPayloads(
      db,
      (current, total, key) => {
        const item = key ? `\nCurrent item: ${key}` : "";
        alertProgress(
          `Saving local backup... (Checking cold storage ${current} / ${total})${item}`,
          0,
        );
      },
    );
    const unavailableColdStorageKeys = [
      ...coldStoragePayloads.missingKeys,
      ...coldStoragePayloads.invalidKeys,
    ];
    if (
      !(await confirmIncompleteColdStorageOperation(
        db,
        unavailableColdStorageKeys,
        "backup",
      ))
    ) {
      alertClear();
      return;
    }

    const writer = new LocalWriter();
    const r = await initializeLocalBackupWriter(writer, false, mode);
    if (!r) {
      alertClear();
      return;
    }

    const assetMap = new Map<string, { charName: string; assetName: string }>();
    if (db.characters) {
      for (const char of db.characters) {
        if (!char) continue;
        const charName = char.name ?? "Unknown Character";

        if (char.image)
          assetMap.set(char.image, {
            charName: charName,
            assetName: "Main Image",
          });

        if (char.emotionImages) {
          for (const em of char.emotionImages) {
            if (em && em[1])
              assetMap.set(em[1], { charName: charName, assetName: em[0] });
          }
        }
        if (char.type !== "group") {
          if (char.additionalAssets) {
            for (const em of char.additionalAssets) {
              if (em && em[1])
                assetMap.set(em[1], { charName: charName, assetName: em[0] });
            }
          }
          if (char.vits) {
            const keys = Object.keys(char.vits.files);
            for (const key of keys) {
              const vit = char.vits.files[key];
              if (vit)
                assetMap.set(vit, { charName: charName, assetName: key });
            }
          }
          if (char.ccAssets) {
            for (const asset of char.ccAssets) {
              if (asset && asset.uri)
                assetMap.set(asset.uri, {
                  charName: charName,
                  assetName: asset.name,
                });
            }
          }
        }
      }
    }
    if (db.userIcon) {
      assetMap.set(db.userIcon, {
        charName: "User Settings",
        assetName: "User Icon",
      });
    }
    if (db.customBackground) {
      assetMap.set(db.customBackground, {
        charName: "User Settings",
        assetName: "Custom Background",
      });
    }
    if (db.personas) {
      for (const persona of db.personas) {
        if (persona && persona.icon) {
          assetMap.set(persona.icon, {
            charName: "Persona",
            assetName: `${persona.name} Icon`,
          });
        }
      }
    }
    const missingAssets: string[] = [];

    if (isTauri) {
      alertProgress("Saving local backup... (Scanning assets)", 0);
      await sleep(10);
      const assets = (
        await readDir("assets", { baseDir: BaseDirectory.AppData })
      ).filter((asset) => asset.isFile);
      const totalAssets = assets.length;
      let lastUiUpdate = 0;

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const key = asset.name;
        if (!key) {
          continue;
        }

        const percent = totalAssets > 0 ? ((i + 1) / totalAssets) * 80 : 80;
        const now = Date.now();
        if (now - lastUiUpdate > 30 || i === 0 || i === totalAssets - 1) {
          lastUiUpdate = now;
          const assetInfo = assetMap.get(key) || assetMap.get("assets/" + key);
          let message = `Saving local backup... (${i + 1} / ${totalAssets})`;
          if (assetInfo) {
            message += `\n${assetInfo.charName} - ${assetInfo.assetName}`;
          } else {
            message += `\n${key}`;
          }
          if (missingAssets.length > 0) {
            message += `\n(Skipped ${missingAssets.length} missing assets)`;
          }
          alertProgress(message, percent);
          await sleep(0);
        }

        const data = await readFile("assets/" + asset.name, {
          baseDir: BaseDirectory.AppData,
        });
        if (data) {
          await writer.writeBackup(key, data);
        } else {
          missingAssets.push(key);
        }
      }
    } else {
      if (isNodeServer && !forageStorage.isAccount) {
        const startedAt = Date.now();
        const update = () =>
          alertProgress(
            `Saving local backup... (S3/storage server is listing assets)\n` +
              `The download will start as soon as the listing is ready. Elapsed: ${formatBackupElapsed(startedAt)}`,
            2,
          );
        update();
        const timer = setInterval(update, 1000);
        let streamStarted = false;
        try {
          writer.setBufferSize(64 * 1024 * 1024);
          let lastProgress = -1;
          await (forageStorage.realStorage as NodeStorage).streamItems(
            [],
            {
              onFileStart: async (key, size) => {
                await writer.startBackup(key, size);
              },
              onFileChunk: async (_key, chunk) => {
                await writer.write(chunk);
              },
            },
            (progress) => {
              if (!streamStarted) {
                streamStarted = true;
                clearInterval(timer);
              }
              if (progress.completedFiles === 0 && !progress.currentFile) {
                const sourceLabel =
                  progress.assetListSource === "catalog"
                    ? "Loaded asset list from SQL catalog"
                    : progress.assetListSource === "storage-sync"
                      ? "Initialized SQL asset catalog from storage"
                      : "Loaded asset list from storage";
                alertProgress(
                  `Saving local backup... (${sourceLabel}: ${progress.totalFiles.toLocaleString()} assets)`,
                  2,
                );
                return;
              }
              const currentRatio = progress.currentFile
                ? progress.totalBytes === 0n
                  ? 1
                  : Number(
                      (BigInt(progress.receivedBytes) * 1000n) /
                        progress.totalBytes,
                    ) / 1000
                : 0;
              const percent =
                progress.totalFiles === 0
                  ? 80
                  : Math.floor(
                      ((progress.completedFiles + currentRatio) /
                        progress.totalFiles) *
                        80,
                    );

              if (percent === lastProgress) {
                return;
              }
              lastProgress = percent;
              alertProgress(
                `Saving local backup... (Streaming assets ${percent}%, ${progress.completedFiles} / ${progress.totalFiles})`,
                percent,
              );
            },
            { prefix: "assets/" },
          );
        } finally {
          clearInterval(timer);
        }
      } else {
        const keys = await forageStorage.keys();
        const assetKeys = keys.filter((key) => key?.startsWith("assets/"));
        const totalAssets = assetKeys.length;
        let lastUiUpdate = 0;

        for (let i = 0; i < assetKeys.length; i++) {
          const key = assetKeys[i];
          const percent = totalAssets > 0 ? ((i + 1) / totalAssets) * 80 : 80;
          const now = Date.now();
          if (now - lastUiUpdate > 30 || i === 0 || i === totalAssets - 1) {
            lastUiUpdate = now;
            const assetInfo =
              assetMap.get(key) || assetMap.get(key.replace(/^assets\//, ""));
            let message = `Saving local backup... (${i + 1} / ${totalAssets})`;
            if (assetInfo) {
              message += `\n${assetInfo.charName} - ${assetInfo.assetName}`;
            } else {
              message += `\n${key}`;
            }
            if (missingAssets.length > 0) {
              message += `\n(Skipped ${missingAssets.length} missing assets)`;
            }
            alertProgress(message, percent);
            await sleep(0);
          }

          let data: Uint8Array | undefined;
          let isCached = false;
          if (forageStorage.isAccount && key.startsWith("assets/")) {
            if (settingsStore.state.skipSavingAssetsOnWebSync) {
              continue;
            }

            const cached = (await localforage.getItem(key)) as ArrayBuffer;
            if (cached) {
              isCached = true;
              data = new Uint8Array(cached);
            }
          }

          if (!data) {
            data = (await forageStorage.getItem(key)) as unknown as Uint8Array;
          }

          if (data) {
            await writer.writeBackup(key, data);
          } else {
            missingAssets.push(key);
          }
          if (forageStorage.isAccount && !isCached) {
            await sleep(1000);
          }
        }
      }
    }

    const totalCold = coldStoragePayloads.payloads.length;
    for (let i = 0; i < totalCold; i++) {
      const payload = coldStoragePayloads.payloads[i];
      const percent = totalCold > 0 ? 80 + ((i + 1) / totalCold) * 10 : 80;
      let message = `Saving local backup cold data... (${i + 1} / ${totalCold})`;
      if (payload.backupName) {
        message += `\n${payload.backupName}`;
      }
      alertProgress(message, percent);
      await sleep(0);
      await writer.writeBackup(payload.backupName, payload.encoded);
    }

    alertProgress(`Saving local backup... (Compressing database)`, 92);
    await sleep(30);

    const coldStorageValues = new Map(
      coldStoragePayloads.payloads.map((payload) => [payload.key, payload.value] as const),
    );
    const cleanDb = buildPortableLocalBackupDatabase(
      db,
      mode,
      coldStorageValues,
    );
    let dbData = await encodeRisuSaveLegacyAsync(cleanDb, "compression");

    if (forageStorage.isAccount && location.origin.endsWith("risuai.xyz")) {
      alertProgress(`Saving local backup... (Encrypting database)`, 96);
      await sleep(20);
      const time = Date.now();
      const key = (
        await (
          await fetch(`https://sv.risuai.xyz/cryptokey?key=${time}`)
        ).json()
      ).key;
      const encrypted = await encryptBuffer(dbData, key);
      await writer.writeBackup(
        "encryption.risudat",
        new TextEncoder().encode(JSON.stringify({ time, type: "account" })),
      );
      dbData = new Uint8Array(encrypted);
    }

    alertProgress(`Saving local backup... (Writing database)`, 98);
    await sleep(10);

    await writer.writeBackup("database.risudat", dbData);

    alertProgress(`Saving local backup... (Finalizing)`, 100);
    await sleep(10);

    await writer.close();

    if (missingAssets.length > 0) {
      let message =
        "Backup Successful, but the following assets were missing and skipped:\n\n";
      for (const key of missingAssets) {
        const assetInfo = assetMap.get(key) || assetMap.get("assets/" + key);
        if (assetInfo) {
          message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`;
        } else {
          message += `* **Unknown Asset**  \n  *File: ${key}*\n`;
        }
      }
      alertMd(message);
    } else {
      alertNormal("Success");
    }
  } catch (error) {
    console.error("SaveLocalBackup failed:", error);
    alertError(error);
  }
}

/**
 * Saves a partial local backup with only critical assets.
 *
 * Differences from SaveLocalBackup:
 * - Only includes profile images for characters/groups (excludes emotion images, additional assets, VITS files, CC assets)
 * - Additionally includes: persona icons, folder images, bot preset images
 * - Processes only assets in assetMap (selective) instead of all .png files in assets folder
 * - Faster and more efficient for quick backups
 * - Ideal for backing up core visual identity without bulk data
 */
export async function SavePartialLocalBackup() {
  try {
    const firstConfirm = await alertConfirm(language.partialBackupFirstConfirm);
    if (!firstConfirm) return;

    const secondConfirm = await alertConfirm(
      language.partialBackupSecondConfirm,
    );
    if (!secondConfirm) return;

    alertProgress("Saving partial local backup... (Preparing database)", 0);
    await sleep(10);
    const db = getDatabase() as PortableDatabase;
    db.botPresets = (await presetStore.loadAll()).map(
      ({ id: _id, ...preset }) => preset,
    );
    db.botPresetsId = presetStore.activeIndex;
    await ensureDatabaseFullyLoaded(db, (msg) => {
      alertProgress(`Saving partial local backup... (${msg})`, 0);
    });
    alertProgress("Saving partial local backup... (Checking cold storage)", 0);
    await sleep(10);
    const coldStoragePayloads = await collectColdStorageBackupPayloads(
      db,
      (current, total, key) => {
        const item = key ? `\nCurrent item: ${key}` : "";
        alertProgress(
          `Saving partial local backup... (Checking cold storage ${current} / ${total})${item}`,
          0,
        );
      },
    );
    const unavailableColdStorageKeys = [
      ...coldStoragePayloads.missingKeys,
      ...coldStoragePayloads.invalidKeys,
    ];
    if (
      !(await confirmIncompleteColdStorageOperation(
        db,
        unavailableColdStorageKeys,
        "backup",
      ))
    ) {
      alertClear();
      return;
    }

    const writer = new LocalWriter();
    const r = await initializeLocalBackupWriter(writer, true);
    if (!r) {
      alertClear();
      return;
    }

    const assetMap = new Map<string, { charName: string; assetName: string }>();

    if (db.characters) {
      for (const char of db.characters) {
        if (!char) continue;
        const charName = char.name ?? "Unknown Character";
        if (char.image) {
          assetMap.set(char.image, {
            charName: charName,
            assetName: "Profile Image",
          });
        }
      }
    }

    if (db.userIcon) {
      assetMap.set(db.userIcon, {
        charName: "User Settings",
        assetName: "User Icon",
      });
    }

    if (db.personas) {
      for (const persona of db.personas) {
        if (persona && persona.icon) {
          assetMap.set(persona.icon, {
            charName: "Persona",
            assetName: `${persona.name} Icon`,
          });
        }
      }
    }

    if (db.customBackground) {
      assetMap.set(db.customBackground, {
        charName: "User Settings",
        assetName: "Custom Background",
      });
    }

    if (db.characterOrder) {
      for (const item of db.characterOrder) {
        if (typeof item !== "string" && item.img) {
          assetMap.set(item.img, {
            charName: "Folder",
            assetName: `${item.name} Folder Image`,
          });
        }
        if (typeof item !== "string" && item.imgFile) {
          assetMap.set(item.imgFile, {
            charName: "Folder",
            assetName: `${item.name} Folder Image File`,
          });
        }
      }
    }

    if (db.botPresets) {
      for (const preset of db.botPresets) {
        if (preset && preset.image) {
          assetMap.set(preset.image, {
            charName: "Preset",
            assetName: `${preset.name} Preset Image`,
          });
        }
      }
    }

    const missingAssets: string[] = [];

    if (isTauri) {
      alertProgress("Saving partial local backup... (Scanning assets)", 0);
      await sleep(10);
      const assets = await readDir("assets", {
        baseDir: BaseDirectory.AppData,
      });
      const matchingAssets = assets.filter((asset) => {
        if (!asset.name || !asset.isFile) return false;
        const keyWithPrefix = asset.name.startsWith("assets/")
          ? asset.name
          : `assets/${asset.name}`;
        if (!keyWithPrefix.endsWith(".png")) return false;
        return assetMap.has(keyWithPrefix) || assetMap.has(asset.name);
      });
      const totalAssets = matchingAssets.length;
      let lastUiUpdate = 0;

      for (let i = 0; i < matchingAssets.length; i++) {
        const asset = matchingAssets[i];
        const keyWithPrefix = asset.name.startsWith("assets/")
          ? asset.name
          : `assets/${asset.name}`;
        const percent = totalAssets > 0 ? ((i + 1) / totalAssets) * 80 : 80;
        const now = Date.now();
        if (now - lastUiUpdate > 30 || i === 0 || i === totalAssets - 1) {
          lastUiUpdate = now;
          const assetInfo =
            assetMap.get(keyWithPrefix) || assetMap.get(asset.name);
          let message = `Saving partial local backup... (${i + 1} / ${totalAssets})`;
          if (assetInfo) {
            message += `\n${assetInfo.charName} - ${assetInfo.assetName}`;
          } else {
            message += `\n${asset.name}`;
          }
          if (missingAssets.length > 0) {
            message += `\n(Skipped ${missingAssets.length} missing assets)`;
          }
          alertProgress(message, percent);
          await sleep(0);
        }

        const data = await readFile("assets/" + asset.name, {
          baseDir: BaseDirectory.AppData,
        });
        if (data) {
          await writer.writeBackup(asset.name, data);
        } else {
          missingAssets.push(asset.name);
        }
      }
    } else {
      const keys = await forageStorage.keys();
      const matchingKeys = keys.filter((key) => {
        if (!key || !key.startsWith("assets/")) return false;
        if (!key.endsWith(".png")) return false;
        const keyWithoutPrefix = key.replace(/^assets\//, "");
        return assetMap.has(key) || assetMap.has(keyWithoutPrefix);
      });
      const totalAssets = matchingKeys.length;
      let lastUiUpdate = 0;

      for (let i = 0; i < matchingKeys.length; i++) {
        const key = matchingKeys[i];
        const percent = totalAssets > 0 ? ((i + 1) / totalAssets) * 80 : 80;
        const now = Date.now();
        if (now - lastUiUpdate > 30 || i === 0 || i === totalAssets - 1) {
          lastUiUpdate = now;
          const assetInfo =
            assetMap.get(key) || assetMap.get(key.replace(/^assets\//, ""));
          let message = `Saving partial local backup... (${i + 1} / ${totalAssets})`;
          if (assetInfo) {
            message += `\n${assetInfo.charName} - ${assetInfo.assetName}`;
          } else {
            message += `\n${key}`;
          }
          if (missingAssets.length > 0) {
            message += `\n(Skipped ${missingAssets.length} missing assets)`;
          }
          alertProgress(message, percent);
          await sleep(0);
        }

        let data: Uint8Array | undefined;
        let isCached = false;
        if (forageStorage.isAccount && key.startsWith("assets/")) {
          if (settingsStore.state.skipSavingAssetsOnWebSync) {
            continue;
          }

          const cached = (await localforage.getItem(key)) as ArrayBuffer;
          if (cached) {
            isCached = true;
            data = new Uint8Array(cached);
          }
        }

        if (!data) {
          data = (await forageStorage.getItem(key)) as unknown as Uint8Array;
        }

        if (data) {
          await writer.writeBackup(key, data);
        } else {
          missingAssets.push(key);
        }
        if (forageStorage.isAccount && !isCached) {
          await sleep(100);
        }
      }
    }

    const totalCold = coldStoragePayloads.payloads.length;
    for (let i = 0; i < totalCold; i++) {
      const payload = coldStoragePayloads.payloads[i];
      const percent = totalCold > 0 ? 80 + ((i + 1) / totalCold) * 10 : 80;
      let message = `Saving partial local backup cold data... (${i + 1} / ${totalCold})`;
      if (payload.backupName) {
        message += `\n${payload.backupName}`;
      }
      alertProgress(message, percent);
      await sleep(0);
      await writer.writeBackup(payload.backupName, payload.encoded);
    }

    alertProgress(`Saving partial local backup... (Compressing database)`, 92);
    await sleep(30);

    const cleanDb = buildPortableLocalBackupDatabase(db, "native");
    const dbData = await encodeRisuSaveLegacyAsync(cleanDb, "compression");

    alertProgress(`Saving partial local backup... (Writing database)`, 98);
    await sleep(10);

    await writer.writeBackup("database.risudat", dbData);

    alertProgress(`Saving partial local backup... (Finalizing)`, 100);
    await sleep(10);

    await writer.close();

    if (missingAssets.length > 0) {
      let message =
        "Partial backup successful, but the following profile images were missing and skipped:\n\n";
      for (const key of missingAssets) {
        const assetInfo = assetMap.get(key) || assetMap.get("assets/" + key);
        if (assetInfo) {
          message += `* **${assetInfo.assetName}** (from *${assetInfo.charName}*)  \n  *File: ${key}*\n`;
        } else {
          message += `* **Unknown Asset**  \n  *File: ${key}*\n`;
        }
      }
      alertMd(message);
    } else {
      alertNormal("Success");
    }
  } catch (error) {
    console.error("SavePartialLocalBackup failed:", error);
    alertError(error);
  }
}

export async function restoreLocalBackupFile(file: File) {
  const textDecoder = new TextDecoder();
  const encryptionMeta: {
    type: "none" | "account";
    time?: number;
  } = {
    type: "none",
  };

  let pendingDatabase: Uint8Array | null = null;
  let decodedDatabase: Database | null = null;
  const restoredColdStorageKeys = new Set<string>();
  const useNodeBulkRestore = isNodeServer && !forageStorage.isAccount;
  const pendingNodeAssets = new Map<string, Uint8Array>();
  const nodeBulkMaxFiles = 64;
  const nodeBulkMaxBytes = 64 * 1024 * 1024;
  let pendingNodeAssetBytes = 0;
  let entriesRestored = 0;
  let entriesWritten = 0;
  let currentEntryName = "";
  let bytesRead = 0;
  const tauriAssetDirectories = new Set<string>();

  const ensureTauriAssetDirectory = async (assetPath: string) => {
    const directory = assetPath.slice(0, assetPath.lastIndexOf("/"));
    if (tauriAssetDirectories.has(directory)) {
      return;
    }
    await mkdir(directory, {
      baseDir: BaseDirectory.AppData,
      recursive: true,
    });
    tauriAssetDirectories.add(directory);
  };

  const flushNodeAssets = async (): Promise<number> => {
    if (pendingNodeAssets.size === 0) {
      return 0;
    }
    const count = pendingNodeAssets.size;
    await (forageStorage.realStorage as NodeStorage).setItems(
      pendingNodeAssets,
    );
    pendingNodeAssets.clear();
    pendingNodeAssetBytes = 0;
    return count;
  };

  // Browser storage (IndexedDB/localForage) has no bulk API, but writing
  // assets one-by-one serializes every IndexedDB transaction and makes
  // restoring large backups extremely slow. Batch them instead and write
  // each batch in a single IndexedDB transaction when possible.
  const useBrowserBulkRestore = !isTauri && !useNodeBulkRestore;
  let pendingBrowserAssets = new Map<string, Uint8Array>();
  const browserBulkMaxFiles = 256;
  const browserBulkMaxBytes = 64 * 1024 * 1024;
  const browserBulkWriteConcurrency = 8;
  let pendingBrowserAssetBytes = 0;

  /**
   * Reuse localForage's own IndexedDB connection so restored assets land in
   * exactly the same database/store localForage reads from. Returns null when
   * the active driver is not IndexedDB (e.g. WebSQL/localStorage fallback).
   */
  const getLocalForageIdb = async (): Promise<{
    db: IDBDatabase;
    storeName: string;
  } | null> => {
    try {
      const storage = forageStorage.realStorage as any;
      if (typeof storage?.ready !== "function") return null;
      await storage.ready();
      const dbInfo = storage._dbInfo;
      if (!dbInfo?.db || !dbInfo.storeName) return null;
      return { db: dbInfo.db, storeName: dbInfo.storeName };
    } catch {
      return null;
    }
  };

  const writeBrowserAssetBatchWithLocalForage = async (
    entries: Array<[string, Uint8Array]>,
  ) => {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(browserBulkWriteConcurrency, entries.length) },
      async () => {
        while (cursor < entries.length) {
          const [key, data] = entries[cursor++];
          await forageStorage.setItem(key, data);
        }
      },
    );
    await Promise.all(workers);
  };

  const flushBrowserAssets = async (): Promise<number> => {
    if (pendingBrowserAssets.size === 0) {
      return 0;
    }
    const count = pendingBrowserAssets.size;
    const entries = Array.from(pendingBrowserAssets);
    pendingBrowserAssets = new Map();
    pendingBrowserAssetBytes = 0;

    try {
      const idb = await getLocalForageIdb();
      if (idb) {
        await new Promise<void>((resolve, reject) => {
          const tx = idb.db.transaction(idb.storeName, "readwrite");
          const store = tx.objectStore(idb.storeName);
          for (const [key, data] of entries) {
            store.put(data, key);
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(tx.error ?? new Error("IndexedDB bulk write failed"));
          tx.onabort = () =>
            reject(tx.error ?? new Error("IndexedDB bulk write aborted"));
        });
        return count;
      }
    } catch (error) {
      console.warn(
        "IndexedDB bulk asset write failed, falling back to per-item writes:",
        error,
      );
    }

    await writeBrowserAssetBatchWithLocalForage(entries);
    return count;
  };

  const restoreBackupEntry = async (name: string, data: Uint8Array) => {
    currentEntryName = name;
    if (name === "encryption.risudat") {
      let meta: typeof encryptionMeta;
      try {
        meta = JSON.parse(textDecoder.decode(data));
      } catch (error) {
        console.error("Failed to parse encryption metadata:", error);
        throw new Error(
          "This backup is encrypted, but its encryption metadata is invalid.",
        );
      }

      if (
        meta.type !== "account" ||
        typeof meta.time !== "number" ||
        !Number.isFinite(meta.time) ||
        meta.time <= 0
      ) {
        throw new Error(
          "This backup is encrypted, but its encryption metadata is incomplete.",
        );
      }
      encryptionMeta.type = "account";
      encryptionMeta.time = meta.time;
    } else if (name === "database.risudat") {
      pendingDatabase = data;
    } else {
      const coldStorageKey = getColdStorageBackupKey(name);
      let handledAsColdStorage = false;

      if (coldStorageKey) {
        handledAsColdStorage = true;
        try {
          const jsonData = JSON.parse(textDecoder.decode(data));

          if (isColdStorageBackupData(jsonData)) {
            if (await setColdStorageItem(coldStorageKey, jsonData)) {
              restoredColdStorageKeys.add(coldStorageKey);
            } else {
              console.error(
                `Failed to restore cold storage item ${coldStorageKey}`,
              );
            }
          } else {
            console.warn(
              `Skipping invalid cold storage backup item ${name}`,
            );
          }
        } catch (e) {
          console.error(
            `Failed to parse cold storage item ${coldStorageKey}:`,
            e,
          );
        }
      }

      if (!handledAsColdStorage) {
        const assetPath = normalizeLocalBackupAssetPath(name);
        if (isTauri) {
          await ensureTauriAssetDirectory(assetPath);
          await writeFile(assetPath, data, {
            baseDir: BaseDirectory.AppData,
          });
        } else if (useNodeBulkRestore) {
          const key = assetPath;
          const previous = pendingNodeAssets.get(key);
          if (previous) {
            pendingNodeAssetBytes -= previous.byteLength;
          }
          pendingNodeAssets.set(key, data);
          pendingNodeAssetBytes += data.byteLength;

          if (
            pendingNodeAssets.size >= nodeBulkMaxFiles ||
            pendingNodeAssetBytes >= nodeBulkMaxBytes
          ) {
            const flushed = await flushNodeAssets();
            if (flushed) {
              entriesWritten += flushed;
            }
          }
        } else {
          const key = assetPath;
          const previous = pendingBrowserAssets.get(key);
          if (previous) {
            pendingBrowserAssetBytes -= previous.byteLength;
          }
          pendingBrowserAssets.set(key, data);
          pendingBrowserAssetBytes += data.byteLength;

          if (
            pendingBrowserAssets.size >= browserBulkMaxFiles ||
            pendingBrowserAssetBytes >= browserBulkMaxBytes
          ) {
            const flushed = await flushBrowserAssets();
            if (flushed) {
              entriesWritten += flushed;
            }
          }
        }
      }
    }

    entriesRestored++;
    currentEntryName = "";
  };

  try {
    const reader = file.stream().getReader();
    let lastUiUpdate = 0;
    type BackupParserPhase = "nameLength" | "name" | "dataLength" | "data";
    let parserPhase: BackupParserPhase = "nameLength";
    const lengthBuffer = new Uint8Array(4);
    let lengthOffset = 0;
    let entryNameBuffer = new Uint8Array();
    let entryNameOffset = 0;
    let entryName = "";
    let entryDataLength = 0;
    let entryDataReceived = 0;
    let entryDataBuffer = new Uint8Array();

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bytesRead += value.length;
      const now = Date.now();
      if (now - lastUiUpdate > 30) {
        lastUiUpdate = now;
        const readPercent =
          file.size === 0 ? 90 : Math.floor((bytesRead / file.size) * 90);
        let message = `Parsing backup... (${readPercent}%) (${entriesRestored} entries parsed`;
        const isBulkRestore = useNodeBulkRestore || useBrowserBulkRestore;
        if (isBulkRestore && entriesWritten > 0) {
          message += `, ${entriesWritten} written`;
        }
        message += ")";
        if (currentEntryName) {
          message += `\n${currentEntryName}`;
        }
        alertProgress(message, readPercent);
      }

      let chunkOffset = 0;
      while (chunkOffset < value.length) {
        if (parserPhase === "nameLength" || parserPhase === "dataLength") {
          const copyLength = Math.min(
            lengthBuffer.length - lengthOffset,
            value.length - chunkOffset,
          );
          lengthBuffer.set(
            value.subarray(chunkOffset, chunkOffset + copyLength),
            lengthOffset,
          );
          lengthOffset += copyLength;
          chunkOffset += copyLength;
          if (lengthOffset < lengthBuffer.length) {
            continue;
          }

          const length = new DataView(lengthBuffer.buffer).getUint32(0, true);
          lengthOffset = 0;

          if (parserPhase === "nameLength") {
            if (length === 0 || length > 1024 * 1024) {
              throw new Error("Invalid backup entry name length");
            }
            entryNameBuffer = new Uint8Array(length);
            entryNameOffset = 0;
            parserPhase = "name";
          } else {
            if (length > file.size) {
              throw new Error("Invalid backup entry data length");
            }
            entryDataLength = length;
            entryDataReceived = 0;
            entryDataBuffer = new Uint8Array(length);
            parserPhase = "data";

            if (entryDataLength === 0) {
              await restoreBackupEntry(entryName, new Uint8Array());
              entryName = "";
              parserPhase = "nameLength";
            }
          }
          continue;
        }

        if (parserPhase === "name") {
          const copyLength = Math.min(
            entryNameBuffer.length - entryNameOffset,
            value.length - chunkOffset,
          );
          entryNameBuffer.set(
            value.subarray(chunkOffset, chunkOffset + copyLength),
            entryNameOffset,
          );
          entryNameOffset += copyLength;
          chunkOffset += copyLength;

          if (entryNameOffset === entryNameBuffer.length) {
            entryName = textDecoder.decode(entryNameBuffer);
            parserPhase = "dataLength";
          }
          continue;
        }

        const copyLength = Math.min(
          entryDataLength - entryDataReceived,
          value.length - chunkOffset,
        );
        entryDataBuffer.set(
          value.subarray(chunkOffset, chunkOffset + copyLength),
          entryDataReceived,
        );
        entryDataReceived += copyLength;
        chunkOffset += copyLength;

        if (entryDataReceived === entryDataLength) {
          await restoreBackupEntry(entryName, entryDataBuffer);
          entryName = "";
          entryDataBuffer = new Uint8Array();
          parserPhase = "nameLength";
        }
      }
    }

    if (parserPhase !== "nameLength" || lengthOffset !== 0) {
      throw new Error("Backup file ended with an incomplete entry");
    }
  } catch (streamErr) {
    // If chunked container failed, try fallback for raw database.bin
    console.warn("Stream backup container parsing failed, trying raw database.bin fallback:", streamErr);
    try {
      const buffer = await file.arrayBuffer();
      const rawBytes = new Uint8Array(buffer);
      const rawDb = await decodeRisuSave(rawBytes);
      if (!rawDb || typeof rawDb !== "object") {
        throw streamErr;
      }
      pendingDatabase = rawBytes;
      decodedDatabase = rawDb as Database;
    } catch {
      throw streamErr;
    }
  }

  if (useNodeBulkRestore && pendingNodeAssets.size > 0) {
    alertProgress(
      `Flushing remaining assets... (${pendingNodeAssets.size} files)`,
      90,
    );
    const flushed = await flushNodeAssets();
    if (flushed) {
      entriesWritten += flushed;
    }
  }

  if (useBrowserBulkRestore && pendingBrowserAssets.size > 0) {
    alertProgress(
      `Flushing remaining assets... (${pendingBrowserAssets.size} files)`,
      90,
    );
    const flushed = await flushBrowserAssets();
    if (flushed) {
      entriesWritten += flushed;
    }
  }

  if (!pendingDatabase) {
    throw new Error("Backup does not contain a database entry");
  }

  let db = pendingDatabase;
  if (encryptionMeta.type === "account" && encryptionMeta.time) {
    try {
      db = await decryptLegacyAccountBackup(
        db,
        encryptionMeta.time,
        decryptBuffer,
      );
    } catch (error) {
      console.error("Failed to decrypt database backup:", error);
      const detail = error instanceof Error ? error.message : `${error}`;
      throw new Error(
        `This backup is encrypted and could not be decrypted. ${detail}`,
      );
    }
  }
  alertProgress("Decoding database...", 95);
  const dbData = decodedDatabase ?? ((await decodeRisuSave(db)) as Database);
  normalizeDatabaseDefaults(dbData);
  dbData.pluginCustomStorage ??= {};
  const missingColdStorageKeys: string[] = [];
  for (const key of await listColdDataKeys(dbData)) {
    if (restoredColdStorageKeys.has(key)) {
      continue;
    }
    const existingColdStorage = await getColdStorageItem(key);
    if (!isColdStorageBackupData(existingColdStorage)) {
      missingColdStorageKeys.push(key);
    }
  }
  if (
    !(await confirmIncompleteColdStorageOperation(
      dbData,
      missingColdStorageKeys,
      "restore",
    ))
  ) {
    return;
  }

  const totalChars = dbData.characters?.length ?? 0;
  let totalChats = 0;
  for (const c of dbData.characters ?? []) {
    totalChats += c.chats?.length ?? 0;
  }
  const baseMsg = `Syncing SQL (${totalChars} characters, ${totalChats} chats)`;
  alertProgress(`${baseMsg}...`, 98);
  const storage = await getSqlStorage();
  await storage.replaceDatabase(dbData, (step) => {
    alertWait(`${baseMsg} - ${step}`);
  });

  if (isTauri) {
    await relaunch();
    alertStore.set({
      type: "wait",
      msg: "Success, Refreshing your app.",
    });
  } else {
    location.search = "";
    alertStore.set({
      type: "wait",
      msg: "Success, Refreshing your app.",
    });
    location.reload();
  }

  alertNormal("Success");
}

export function LoadLocalBackup() {
  try {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".bin,.risubackup";
    input.onchange = async () => {
      if (!input.files || input.files.length === 0) {
        input.remove();
        return;
      }
      const file = input.files[0];
      input.remove();
      try {
        await restoreLocalBackupFile(file);
      } catch (error) {
        console.error(error);
        const detail = error instanceof Error ? error.message : `${error}`;
        alertError(
          `Failed to load local backup: ${detail}\nCheck the server console or logs for details.`,
        );
      }
    };
    input.click();
  } catch (error) {
    console.error(error);
    alertError("Failed, Is file corrupted?");
  }
}
