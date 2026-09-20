import {
  filterEssentialBackupAssetKeys,
  type BackupAssetMap,
  type BackupAssetScope,
} from "../assetScope";

export interface NodeBackupAssetStreamOptions {
  thumbnail?: boolean;
  prefix?: string;
  size?: "thumb" | "display" | "full";
  width?: number;
  height?: number;
}

export interface NodeBackupAssetStreamProgress {
  completedFiles: number;
  totalFiles: number;
  currentFile: string | null;
  receivedBytes: number;
  totalBytes: bigint;
  assetListSource?: string;
}

export interface NodeBackupAssetStreamHandlers {
  onFileStart(name: string, size: bigint): Promise<void> | void;
  onFileChunk(name: string, chunk: Uint8Array): Promise<void> | void;
  onFileEnd?(name: string): Promise<void> | void;
}

export interface NodeBackupAssetStorage {
  keys(prefix: string): Promise<string[]>;
  streamItems(
    keys: string[],
    handlers: NodeBackupAssetStreamHandlers,
    onProgress?: (progress: NodeBackupAssetStreamProgress) => void,
    options?: NodeBackupAssetStreamOptions,
  ): Promise<void>;
}

export interface NodeBackupAssetWriter {
  startBackup(name: string, size: number | bigint): Promise<void>;
  write(chunk: Uint8Array): Promise<void>;
}

export interface NodeBackupAssetRequest {
  keys: string[];
  options?: NodeBackupAssetStreamOptions;
}

export interface NodeBackupAssetStreamResult {
  writtenKeys: string[];
  missingKeys: string[];
}

export async function createNodeBackupAssetRequest(
  storage: Pick<NodeBackupAssetStorage, "keys">,
  scope: BackupAssetScope,
  assetMap: BackupAssetMap,
): Promise<NodeBackupAssetRequest> {
  if (scope === "all") {
    return { keys: [], options: { prefix: "assets/" } };
  }
  const keys: string[] = await storage.keys("assets/");
  return { keys: filterEssentialBackupAssetKeys(keys, assetMap) };
}

export async function streamNodeBackupAssets(
  storage: NodeBackupAssetStorage,
  writer: NodeBackupAssetWriter,
  keys: string[],
  onProgress?: (progress: NodeBackupAssetStreamProgress) => void,
  options?: NodeBackupAssetStreamOptions,
): Promise<NodeBackupAssetStreamResult> {
  const writtenKeys: Set<string> = new Set<string>();
  await storage.streamItems(
    keys,
    {
      async onFileStart(name: string, size: bigint): Promise<void> {
        writtenKeys.add(name);
        await writer.startBackup(name, size);
      },
      async onFileChunk(_name: string, chunk: Uint8Array): Promise<void> {
        await writer.write(chunk);
      },
    },
    onProgress,
    options,
  );
  return {
    writtenKeys: Array.from(writtenKeys),
    missingKeys: keys.filter((key: string): boolean => !writtenKeys.has(key)),
  };
}
