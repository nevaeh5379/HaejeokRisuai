import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const plugin = {
    open: vi.fn(),
    write: vi.fn(),
    writeText: vi.fn(),
    writeAssets: vi.fn(),
    close: vi.fn(),
  };
  return { ...plugin, registerPlugin: vi.fn(() => plugin) };
});

vi.mock("../platform", () => ({ isCapacitor: true }));
vi.mock("@capacitor/core", () => ({
  registerPlugin: mocks.registerPlugin,
}));

import {
  CAPACITOR_FILE_WRITER_TEXT_CHUNK_SIZE,
  CapacitorFileWriter,
} from "./capacitorFileWriter";

describe("CapacitorFileWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.open.mockResolvedValue({ id: "writer-1", cancelled: false });
    mocks.write.mockResolvedValue(undefined);
    mocks.writeText.mockResolvedValue(undefined);
    mocks.writeAssets.mockResolvedValue({ written: 1, missing: [] });
    mocks.close.mockResolvedValue(undefined);
  });

  it("opens the Android document writer and writes bytes through the native bridge", async () => {
    const writer = await CapacitorFileWriter.open(
      "chat.json",
      "application/json",
    );
    expect(writer).not.toBeNull();
    expect(mocks.open).toHaveBeenCalledWith({
      fileName: "chat.json",
      mimeType: "application/json",
    });

    await writer!.write(new Uint8Array([1, 2, 3]));
    expect(mocks.write).toHaveBeenCalledWith({
      id: "writer-1",
      data: "AQID",
    });

    await writer!.close();
    expect(mocks.close).toHaveBeenCalledWith({ id: "writer-1" });
  });

  it("writes large text in order without Base64 conversion", async () => {
    const writer = await CapacitorFileWriter.open("chat.json");
    const data =
      "a".repeat(CAPACITOR_FILE_WRITER_TEXT_CHUNK_SIZE - 1) +
      "😀" +
      "나".repeat(CAPACITOR_FILE_WRITER_TEXT_CHUNK_SIZE);

    await writer!.writeText(data);

    expect(mocks.writeText).toHaveBeenCalledTimes(3);
    const chunks = mocks.writeText.mock.calls.map(([options]) => options.data);
    expect(chunks.join("")).toBe(data);
    expect(chunks[0].endsWith("\ud83d")).toBe(false);
    expect(chunks[1].startsWith("\ude00")).toBe(false);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("returns null when the Android save picker is cancelled", async () => {
    mocks.open.mockResolvedValue({ cancelled: true });
    await expect(CapacitorFileWriter.open("chat.json")).resolves.toBeNull();
  });

  it("uses the same native stream for backup asset transfer", async () => {
    const writer = await CapacitorFileWriter.open("backup.risubackup");
    const result = await writer!.writeAssets(["assets/a.png"]);
    expect(result).toEqual({ written: 1, missing: [] });
    expect(mocks.writeAssets).toHaveBeenCalledWith({
      id: "writer-1",
      keys: ["assets/a.png"],
    });
  });
});
