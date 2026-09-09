import { Buffer } from "buffer";
import { describe, expect, it, vi } from "vitest";
import { OpfsStorage } from "./opfsStorage";

function hexKey(key: string): string {
  return Buffer.from(key, "utf8").toString("hex");
}

describe("OpfsStorage sync reads", () => {
  it("uses File.slice for bounded reads without materializing the full file", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const slice = vi.fn(
      (start: number, end: number) => new Blob([bytes.slice(start, end)]),
    );
    const getFile = vi.fn(async () => ({ size: bytes.length, slice }));
    const directory = {
      async *values() {
        yield { name: hexKey("assets/a.bin") };
        yield { name: hexKey("database/ignored.bin") };
      },
      getFileHandle: vi.fn(async () => ({ getFile })),
    };
    const storage = new OpfsStorage();
    (storage as any).opfs = directory;

    await expect(storage.listSyncAssetKeys()).resolves.toEqual([
      "assets/a.bin",
    ]);
    await expect(storage.getSyncAssetSize("assets/a.bin")).resolves.toBe(6);
    await expect(
      storage.readSyncAssetChunk("assets/a.bin", 2, 3),
    ).resolves.toEqual(new Uint8Array([3, 4, 5]));
    expect(slice).toHaveBeenCalledWith(2, 5);
    expect(directory.getFileHandle).toHaveBeenCalledWith(
      hexKey("assets/a.bin"),
      {
        create: false,
      },
    );
  });
});
