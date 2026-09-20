import { isColdStorageBackupData } from "./coldStorage";
import {
  getColdStorageBackupKey,
  getInlayBackupKey,
  normalizeBackupAssetPath,
  type BackupEntryClassification,
} from "./entryPolicy";

export interface AccountBackupEncryptionMetadata {
  type: "account";
  time: number;
}

export interface BackupRestoreEntryHandlers {
  onEncryption(metadata: AccountBackupEncryptionMetadata): Promise<void> | void;
  onEncryptionParseError?(error: unknown): Promise<void> | void;
  onDatabase(data: Uint8Array): Promise<void> | void;
  onDatabaseStream(
    normalizedName: string,
    data: Uint8Array,
  ): Promise<void> | void;
  onInlay(inlayKey: string, data: Uint8Array): Promise<void> | void;
  onColdStorage(
    coldStorageKey: string,
    value: unknown,
    entryName: string,
  ): Promise<void> | void;
  onInvalidColdStorage?(
    coldStorageKey: string,
    entryName: string,
  ): Promise<void> | void;
  onColdStorageParseError?(
    coldStorageKey: string,
    entryName: string,
    error: unknown,
  ): Promise<void> | void;
  onAsset(assetPath: string, data: Uint8Array): Promise<void> | void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function dispatchEncryptionEntry(
  data: Uint8Array,
  handlers: BackupRestoreEntryHandlers,
  textDecoder: TextDecoder,
): Promise<void> {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(data)) as unknown;
  } catch (error: unknown) {
    await handlers.onEncryptionParseError?.(error);
    throw new Error(
      "This backup is encrypted, but its encryption metadata is invalid.",
    );
  }
  if (
    !isRecord(value) ||
    value.type !== "account" ||
    typeof value.time !== "number" ||
    !Number.isFinite(value.time) ||
    value.time <= 0
  ) {
    throw new Error(
      "This backup is encrypted, but its encryption metadata is incomplete.",
    );
  }
  const metadata: AccountBackupEncryptionMetadata = {
    type: "account",
    time: value.time,
  };
  await handlers.onEncryption(metadata);
}

async function dispatchColdStorageEntry(
  name: string,
  data: Uint8Array,
  handlers: BackupRestoreEntryHandlers,
  textDecoder: TextDecoder,
): Promise<void> {
  const coldStorageKey: string | null = getColdStorageBackupKey(name);
  if (!coldStorageKey) {
    throw new Error(`Invalid cold storage backup entry: ${name}`);
  }
  try {
    const value: unknown = JSON.parse(textDecoder.decode(data)) as unknown;
    if (!isColdStorageBackupData(value)) {
      await handlers.onInvalidColdStorage?.(coldStorageKey, name);
      return;
    }
    await handlers.onColdStorage(coldStorageKey, value, name);
  } catch (error: unknown) {
    await handlers.onColdStorageParseError?.(coldStorageKey, name, error);
  }
}

/**
 * Dispatches a classified backup entry to host-provided persistence hooks.
 * Format validation and logical target derivation stay in backup-core while
 * platform-specific writes remain in the host. Payload bytes are never copied.
 */
export async function dispatchBackupRestoreEntry(
  name: string,
  data: Uint8Array,
  classification: BackupEntryClassification,
  handlers: BackupRestoreEntryHandlers,
  textDecoder: TextDecoder = new TextDecoder(),
): Promise<void> {
  switch (classification.kind) {
    case "encryption":
      await dispatchEncryptionEntry(data, handlers, textDecoder);
      return;
    case "database":
      await handlers.onDatabase(data);
      return;
    case "databaseStream": {
      const normalizedName: string | null = classification.normalized;
      if (!normalizedName) {
        throw new Error(`Invalid streaming database entry name: ${name}`);
      }
      await handlers.onDatabaseStream(normalizedName, data);
      return;
    }
    case "inlay": {
      const inlayKey: string | null = getInlayBackupKey(name);
      if (!inlayKey) throw new Error(`Invalid inlay backup entry: ${name}`);
      await handlers.onInlay(inlayKey, data);
      return;
    }
    case "coldStorage":
      await dispatchColdStorageEntry(name, data, handlers, textDecoder);
      return;
    case "asset": {
      const assetPath: string = normalizeBackupAssetPath(name);
      await handlers.onAsset(assetPath, data);
      return;
    }
    case "extension":
      throw new Error(`Unsupported backup extension entry: ${name}`);
    case "invalid":
      throw new Error(`Invalid backup entry path: ${name}`);
  }
}
