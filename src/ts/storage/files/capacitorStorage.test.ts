import { Buffer } from "buffer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("@capacitor/filesystem", () => ({
  Directory: { Data: "DATA" },
  Filesystem: fsMocks,
}));

import { CapacitorStorage } from "./capacitorStorage";

function filename(key: string): string {
  return `${Buffer.from(key, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")}.bin`;
}
describe("CapacitorStorage sync reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.readdir.mockResolvedValue({ files: [] });
  });

  it("filters canonical assets and uses native offset/length reads", async () => {
    fsMocks.readdir.mockResolvedValue({
      files: [
        { name: filename("assets/a.bin") },
        { name: filename("database/ignored.bin") },
      ],
    });
    fsMocks.stat.mockResolvedValue({ size: 10 });
    fsMocks.readFile.mockResolvedValue({
      data: Buffer.from([4, 5, 6]).toString("base64"),
    });

    const storage = new CapacitorStorage();
    await expect(storage.listSyncAssetKeys()).resolves.toEqual([
      "assets/a.bin",
    ]);
    await expect(storage.getSyncAssetSize("assets/a.bin")).resolves.toBe(10);
    await expect(
      storage.readSyncAssetChunk("assets/a.bin", 4, 3),
    ).resolves.toEqual(Buffer.from([4, 5, 6]));
    expect(fsMocks.stat).toHaveBeenCalledWith({
      path: `risuai-assets/${filename("assets/a.bin")}`,
      directory: "DATA",
    });
    expect(fsMocks.readFile).toHaveBeenCalledWith({
      path: `risuai-assets/${filename("assets/a.bin")}`,
      directory: "DATA",
      offset: 4,
      length: 3,
    });
  });
});
