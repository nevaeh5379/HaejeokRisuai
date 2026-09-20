import { describe, expect, it, vi } from "vitest";
import {
  createNodeBackupAssetRequest,
  streamNodeBackupAssets,
  type NodeBackupAssetStorage,
  type NodeBackupAssetStreamHandlers,
  type NodeBackupAssetWriter,
} from "./exportAssets";

describe("node backup asset export", (): void => {
  it("lets the remote storage list all assets for all-scope exports", async (): Promise<void> => {
    const keys = vi.fn(async (_prefix: string): Promise<string[]> => [
      "assets/unused.png",
    ]);

    await expect(
      createNodeBackupAssetRequest({ keys }, "all", new Map()),
    ).resolves.toEqual({ keys: [], options: { prefix: "assets/" } });
    expect(keys).not.toHaveBeenCalled();
  });

  it("filters essential keys before requesting the stream", async (): Promise<void> => {
    const keys = vi.fn(async (_prefix: string): Promise<string[]> => [
      "assets/keep.png",
      "assets/other.png",
    ]);

    await expect(
      createNodeBackupAssetRequest(
        { keys },
        "essential",
        new Map([
          ["assets/keep.png", { charName: "Character", assetName: "Profile" }],
        ]),
      ),
    ).resolves.toEqual({ keys: ["assets/keep.png"] });
  });

  it("streams payloads without materializing omitted entries", async (): Promise<void> => {
    const chunks: Uint8Array[] = [];
    const storage: NodeBackupAssetStorage = {
      async keys(_prefix: string): Promise<string[]> {
        return [];
      },
      async streamItems(
        _keys: string[],
        handlers: NodeBackupAssetStreamHandlers,
      ): Promise<void> {
        await handlers.onFileStart("assets/present.png", 2n);
        await handlers.onFileChunk(
          "assets/present.png",
          new Uint8Array([1, 2]),
        );
      },
    };
    const writer: NodeBackupAssetWriter = {
      async startBackup(
        _name: string,
        _size: number | bigint,
      ): Promise<void> {},
      async write(chunk: Uint8Array): Promise<void> {
        chunks.push(chunk);
      },
    };

    await expect(
      streamNodeBackupAssets(storage, writer, [
        "assets/present.png",
        "assets/missing.png",
      ]),
    ).resolves.toEqual({
      writtenKeys: ["assets/present.png"],
      missingKeys: ["assets/missing.png"],
    });
    expect(chunks).toEqual([new Uint8Array([1, 2])]);
  });
});
