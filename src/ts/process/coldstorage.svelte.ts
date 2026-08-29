import {
  writeFile,
  BaseDirectory,
  readFile,
  mkdir,
  remove,
  readDir,
} from "@tauri-apps/plugin-fs";
import { forageStorage } from "../globalApi.svelte";
import { isTauri, isNodeServer } from "src/ts/platform";
import { characterStore } from "../stores/domain/characterStore.svelte";
import { NodeStorage } from "../storage/files/nodeStorage";
import {
  compress as fflateCompress,
  decompress as fflateDecompress,
} from "fflate";
import { alertClear, alertConfirm, alertError, alertWait } from "../alert";
import { language } from "src/lang";
import type { Database } from "../storage/database/schema";
import {
  coldStorageHeader,
  getColdStorageAffectedCharacters,
  getColdStorageBackupName,
  isColdStorageBackupData,
  listColdDataKeysFromDb,
} from "./coldstorageData";

export {
  coldStorageHeader,
  getColdStorageBackupKey,
  getColdStorageBackupName,
  isColdStorageBackupData,
  replaceColdStoragePayloadResources,
  listColdDataKeysFromDb,
} from "./coldstorageData";

async function decompress(data: Uint8Array) {
  return new Promise<Uint8Array>((resolve, reject) => {
    fflateDecompress(data, (err, decompressed) => {
      if (err) {
        return reject(err);
      }
      resolve(decompressed);
    });
  });
}

export async function getColdStorageItem(key: string) {
  if (isNodeServer) {
    try {
      const storage = forageStorage.realStorage as NodeStorage;
      if (storage.postgres.isEnabled()) {
        return await storage.postgres.getColdStorageItem(key);
      }
      const f = await storage.getItem("coldstorage/" + key);
      if (!f) {
        return null;
      }
      const text = new TextDecoder().decode(
        await decompress(new Uint8Array(f)),
      );
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  } else if (isTauri) {
    try {
      const f = await readFile("./coldstorage/" + key + ".json", {
        baseDir: BaseDirectory.AppData,
      });
      const text = new TextDecoder().decode(
        await decompress(new Uint8Array(f)),
      );
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  } else {
    //use opfs
    try {
      const opfs = await navigator.storage.getDirectory();
      const file = await opfs.getFileHandle("coldstorage_" + key + ".json");
      if (!file) {
        return null;
      }
      const d = await file.getFile();
      if (!d) {
        return null;
      }
      const buf = await d.arrayBuffer();
      const text = new TextDecoder().decode(
        await decompress(new Uint8Array(buf)),
      );
      return JSON.parse(text);
    } catch (error) {
      return null;
    }
  }
}

async function compressColdStorageValue(
  value: any,
): Promise<Uint8Array | null> {
  try {
    const json = JSON.stringify(value);
    return await new Promise<Uint8Array>((resolve, reject) => {
      fflateCompress(new TextEncoder().encode(json), (err, result) => {
        if (err) {
          return reject(err);
        }
        resolve(result);
      });
    });
  } catch (error) {
    console.error("Cold storage compression failed:", error);
    return null;
  }
}

export async function setColdStorageItem(
  key: string,
  value: any,
): Promise<boolean> {
  console.log("setting cold storage item", key);

  if (isNodeServer) {
    try {
      const storage = forageStorage.realStorage as NodeStorage;
      if (storage.postgres.isEnabled()) {
        return await storage.postgres.setColdStorageItem(key, value);
      }
    } catch (error) {
      console.error("Cold storage PostgreSQL write failed:", error);
      return false;
    }
  }

  const compressed = await compressColdStorageValue(value);
  if (!compressed) {
    return false;
  }

  if (isNodeServer) {
    try {
      const storage = forageStorage.realStorage as NodeStorage;
      await storage.setItem("coldstorage/" + key, compressed);
      return true;
    } catch (error) {
      console.error("Cold storage node write failed:", error);
      return false;
    }
  } else if (isTauri) {
    try {
      await mkdir("./coldstorage", {
        recursive: true,
        baseDir: BaseDirectory.AppData,
      });
      await writeFile("./coldstorage/" + key + ".json", compressed, {
        baseDir: BaseDirectory.AppData,
      });
      return true;
    } catch (error) {
      console.error("Cold storage Tauri write failed:", error);
      return false;
    }
  } else {
    //use opfs
    try {
      const opfs = await navigator.storage.getDirectory();
      const file = await opfs.getFileHandle("coldstorage_" + key + ".json", {
        create: true,
      });
      const writable = await file.createWritable();
      await writable.write(compressed as any);
      await writable.close();
      return true;
    } catch (error) {
      console.error("Cold storage OPFS write failed:", error);
      return false;
    }
  }
}

export async function listColdStorageItems(): Promise<{ items: string[] }> {
  if (isNodeServer) {
    const storage = forageStorage.realStorage as NodeStorage;
    if (storage.postgres.isEnabled()) {
      return await storage.postgres.listColdStorageItems();
    }
    const fullKeys = await storage.keys();
    const keys = fullKeys
      .filter((k) => k.startsWith("coldstorage/"))
      .map((k) => k.replace("coldstorage/", ""));
    return {
      items: keys,
    };
  } else if (isTauri) {
    const entries = await readDir("./coldstorage", {
      baseDir: BaseDirectory.AppData,
    });
    const keys = entries
      .filter((e) => e.name.endsWith(".json"))
      .map((e) => e.name.slice(0, -5));
    return {
      items: keys,
    };
  } else {
    const opfs = await navigator.storage.getDirectory();
    const entries = opfs.entries();
    const keys = [];
    for await (const [name, handle] of entries) {
      if (name.startsWith("coldstorage_") && name.endsWith(".json")) {
        keys.push(name.slice(12, -5));
      }
    }
    return {
      items: keys,
    };
  }
}

export async function cleanColdStorage() {
  const actualUsedKeys = await listColdDataKeys();
  if (isNodeServer) {
    const storage = forageStorage.realStorage as NodeStorage;
    if (storage.postgres.isEnabled()) {
      const deleted = await storage.postgres.pruneColdStorage(actualUsedKeys);
      console.log(
        "Cleaned PostgreSQL cold storage, retained keys:",
        actualUsedKeys,
        "deleted:",
        deleted,
      );
      alertClear();
      return;
    }
  }
  const allKeys = (await listColdStorageItems()).items;
  const unusedKeys = allKeys.filter((k) => !actualUsedKeys.includes(k));
  console.log(
    "Cleaning cold storage, actual used keys:",
    actualUsedKeys,
    "all keys:",
    allKeys,
    "unused keys:",
    unusedKeys,
  );

  if (isNodeServer) {
    await removeColdStorageItems(unusedKeys);
  } else {
    for (let i = 0; i < unusedKeys.length; i++) {
      const key = unusedKeys[i];
      alertWait(
        `Removing unused cold storage item: ${key} (${i + 1} / ${unusedKeys.length})`,
      );
      await removeColdStorageItems([key]);
    }
  }

  alertClear();
}

async function removeColdStorageItems(keys: string[]) {
  if (isNodeServer) {
    try {
      const storage = forageStorage.realStorage as NodeStorage;
      if (storage.postgres.isEnabled()) {
        await storage.postgres.removeColdStorageItems(keys);
        return;
      }
      const deleteKeys = keys.map((k) => "coldstorage/" + k);
      await storage.removeItem(deleteKeys);
    } catch (error) {
      console.error(error);
    }
  } else if (isTauri) {
    try {
      for (let i = 0; i < keys.length; i++) {
        await remove("./coldstorage/" + keys[i] + ".json", {
          baseDir: BaseDirectory.AppData,
        });
      }
    } catch (error) {
      console.error(error);
    }
  } else {
    //use opfs
    try {
      const opfs = await navigator.storage.getDirectory();
      for (let i = 0; i < keys.length; i++) {
        await opfs.removeEntry("coldstorage_" + keys[i] + ".json");
      }
    } catch (error) {
      console.error(error);
    }
  }
}

export async function listColdDataKeys(
  db: Pick<Database, "characters"> = { characters: characterStore.characters },
): Promise<string[]> {
  return listColdDataKeysFromDb(db);
}

export type ColdStorageBackupPayload = {
  key: string;
  backupName: string;
  value: unknown;
  encoded: Uint8Array;
};

export async function collectColdStorageBackupPayloads(
  db: Pick<Database, "characters"> = { characters: characterStore.characters },
  onProgress?: (current: number, total: number, key?: string) => void,
): Promise<{
  payloads: ColdStorageBackupPayload[];
  missingKeys: string[];
  invalidKeys: string[];
}> {
  const coldKeys = await listColdDataKeys(db);
  const payloads: ColdStorageBackupPayload[] = [];
  const missingKeys: string[] = [];
  const invalidKeys: string[] = [];

  onProgress?.(0, coldKeys.length);
  for (let index = 0; index < coldKeys.length; index++) {
    const key = coldKeys[index];
    onProgress?.(index, coldKeys.length, key);
    try {
      const value = await getColdStorageItem(key);
      if (!value) {
        missingKeys.push(key);
        continue;
      }

      if (!isColdStorageBackupData(value)) {
        invalidKeys.push(key);
        continue;
      }

      payloads.push({
        key,
        backupName: getColdStorageBackupName(key),
        value,
        encoded: new TextEncoder().encode(JSON.stringify(value)),
      });
    } catch (error) {
      console.error(`Failed to read cold storage item ${key}:`, error);
      missingKeys.push(key);
    } finally {
      onProgress?.(index + 1, coldKeys.length, key);
    }
  }

  return { payloads, missingKeys, invalidKeys };
}

export async function confirmIncompleteColdStorageOperation(
  db: Pick<Database, "characters">,
  unavailableKeys: Iterable<string>,
  operation: "backup" | "restore",
): Promise<boolean> {
  const uniqueUnavailableKeys = Array.from(new Set(unavailableKeys));
  if (uniqueUnavailableKeys.length === 0) {
    return true;
  }

  const affected = getColdStorageAffectedCharacters(db, uniqueUnavailableKeys);
  const characterNames = affected.characterNames.join(", ");
  const message =
    operation === "backup"
      ? language.errors.coldStorageIncompleteBackupConfirm(
          characterNames,
          uniqueUnavailableKeys.length,
          affected.unresolvedKeys.length,
        )
      : language.errors.coldStorageIncompleteRestoreConfirm(
          characterNames,
          uniqueUnavailableKeys.length,
          affected.unresolvedKeys.length,
        );

  return await alertConfirm(message);
}

export async function preLoadChat(
  characterIndex: number,
  chatIndex: number,
  options: { full?: boolean; generation?: boolean } = {},
) {
  const chat = characterStore.characters?.[characterIndex]?.chats?.[chatIndex];

  if (!chat) {
    return;
  }

  if (
    (chat.messagesLoaded === false ||
      chat.detailsLoaded === false ||
      (options.full && chat.messagesFullyLoaded === false)) &&
    chat.id
  ) {
    try {
      await characterStore.ensureChatMessages(chat.id, options);
      return;
    } catch (error) {
      console.error(`SQL loadChat failed for chat ${chat.id}:`, error);
    }
  }

  if (chat.message?.[0]?.data?.startsWith(coldStorageHeader)) {
    //bring back from cold storage
    const coldDataKey = chat.message[0].data.slice(coldStorageHeader.length);
    const coldData = await getColdStorageItem(coldDataKey);
    if (coldData && Array.isArray(coldData)) {
      chat.message = coldData;
      chat.lastDate = Date.now();
    } else if (coldData?.message) {
      chat.message = coldData.message;
      chat.hypaV2Data = coldData.hypaV2Data;
      chat.hypaV3Data = coldData.hypaV3Data;
      chat.scriptstate = coldData.scriptstate;
      chat.localLore = coldData.localLore;
      chat.lastDate = Date.now();
    } else {
      // Cold storage data is missing or corrupted.
      // Replace with an error message so the user knows what happened
      // instead of silently showing a broken pointer.
      console.error(`Cold storage data not found for key: ${coldDataKey}`);
      chat.message = [
        {
          time: Date.now(),
          data: `[Cold storage data could not be loaded. Key: ${coldDataKey}]`,
          role: "char",
        },
      ];
      chat.lastDate = Date.now();
    }
    if (chat.id) {
      // Restored before the chat becomes active-tracked; mark explicitly
      characterStore.markChatDirty(chat.id);
    }
  }
}
