import { once } from "node:events";
import type { Writable } from "node:stream";
import type { BackupImportEntryWriter } from "../../../packages/backup-core/src/node/importStagingStore.ts";
import type { AssetEntry } from "../serverTypes.ts";
import { keyToHex } from "./assetStorage.ts";

interface AssetWriteStorage {
  createWriteStream(
    key: string,
    options: { generateThumbnail: boolean },
  ): {
    stream: Writable;
    done(): Promise<unknown>;
    abort?(): Promise<void>;
  };
}

export async function openDirectRestoreAsset(
  storage: AssetWriteStorage,
  key: string,
  expectedSize: number,
  onStored: (entry: AssetEntry) => Promise<void>,
): Promise<BackupImportEntryWriter> {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    throw new Error("Asset restore entry size is invalid");
  }
  const writer = storage.createWriteStream(keyToHex(key), {
    generateThumbnail: false,
  });
  let written = 0;
  let finished = false;

  return {
    async write(chunk: Uint8Array): Promise<void> {
      if (finished) throw new Error("Asset restore writer is already closed");
      written += chunk.byteLength;
      if (written > expectedSize) {
        throw new Error(`Asset restore entry exceeded ${expectedSize} bytes`);
      }
      if (!writer.stream.write(chunk)) await once(writer.stream, "drain");
    },
    async close(): Promise<void> {
      if (finished) return;
      if (written !== expectedSize) {
        await writer.abort?.().catch(() => {});
        finished = true;
        throw new Error(
          `Asset restore entry size mismatch: expected ${expectedSize}, got ${written}`,
        );
      }
      writer.stream.end();
      try {
        await writer.done();
      } catch (error) {
        await writer.abort?.().catch(() => {});
        finished = true;
        throw error;
      }
      finished = true;
      await onStored({ key, size: expectedSize });
    },
    async abort(): Promise<void> {
      if (finished) return;
      finished = true;
      writer.stream.destroy();
      await writer.abort?.().catch(() => {});
    },
  };
}
