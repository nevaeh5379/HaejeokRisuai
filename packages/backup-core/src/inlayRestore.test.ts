import { describe, expect, it } from "vitest";
import { encodeInlayAssetBackup, type InlayAsset } from "./inlayCodec";
import {
  restoreInlayBackupEntry,
  type InlayRestoreDependencies,
  type InlayRestoreResult,
  type InlayRestoreWrite,
} from "./inlayRestore";

interface TrackingWriteState {
  write: InlayRestoreDependencies["write"];
  writtenKeys: string[];
  writtenAssets: InlayAsset[];
}

const inlayKey: string = "11111111-1111-4111-8111-111111111111";

const sourceAsset: InlayAsset = {
  name: "image",
  ext: "png",
  type: "image",
  width: 10,
  height: 20,
  data: "image-payload",
};

async function encodeSourceAsset(): Promise<Uint8Array> {
  return await encodeInlayAssetBackup(sourceAsset);
}

function trackingWrite(): TrackingWriteState {
  const writtenKeys: string[] = [];
  const writtenAssets: InlayAsset[] = [];
  return {
    write: async (key: string, asset: InlayAsset): Promise<void> => {
      writtenKeys.push(key);
      writtenAssets.push(asset);
    },
    writtenKeys,
    writtenAssets,
  };
}

describe("restoreInlayBackupEntry", (): void => {
  it("decodes a valid payload and writes the asset through the writer", async (): Promise<void> => {
    const state: TrackingWriteState = trackingWrite();
    const { write, writtenKeys, writtenAssets }: TrackingWriteState = state;
    const data: Uint8Array = await encodeSourceAsset();

    const result: InlayRestoreResult = await restoreInlayBackupEntry(
      inlayKey,
      data,
      { write },
    );

    expect(result).toEqual({ status: "restored" });
    expect(writtenKeys).toEqual([inlayKey]);
    expect(writtenAssets).toEqual([
      {
        name: sourceAsset.name,
        ext: sourceAsset.ext,
        type: sourceAsset.type,
        width: sourceAsset.width,
        height: sourceAsset.height,
        data: sourceAsset.data,
      },
    ]);
  });

  it("classifies malformed payloads as invalid without touching storage", async (): Promise<void> => {
    const decodeError: Error = new Error("bad inlay payload");
    let writeCallCount: number = 0;
    const write: InlayRestoreWrite = async (
      _inlayKey: string,
      _asset: InlayAsset,
    ): Promise<void> => {
      writeCallCount = writeCallCount + 1;
    };

    const result: InlayRestoreResult = await restoreInlayBackupEntry(
      inlayKey,
      new Uint8Array([1]),
      {
        decode: (_data: Uint8Array): InlayAsset => {
          throw decodeError;
        },
        write,
      },
    );

    expect(result).toEqual({ status: "invalid", error: decodeError });
    expect(writeCallCount).toBe(0);
  });

  it("classifies storage failures separately from invalid data", async (): Promise<void> => {
    const storageError: Error = new Error("quota exceeded");

    const result: InlayRestoreResult = await restoreInlayBackupEntry(
      inlayKey,
      await encodeSourceAsset(),
      {
        write: async (_inlayKey: string, _asset: InlayAsset): Promise<void> => {
          throw storageError;
        },
      },
    );

    expect(result).toEqual({ status: "storage-error", error: storageError });
  });

  it("uses the bundled codec decode when no decode hook is provided", async (): Promise<void> => {
    const state: TrackingWriteState = trackingWrite();
    const { write, writtenAssets }: TrackingWriteState = state;
    const data: Uint8Array = await encodeSourceAsset();

    const result: InlayRestoreResult = await restoreInlayBackupEntry(
      inlayKey,
      data,
      { write },
    );

    expect(result).toEqual({ status: "restored" });
    expect(writtenAssets[0].name).toBe(sourceAsset.name);
    expect(writtenAssets[0].data).toBe(sourceAsset.data);
  });
});
