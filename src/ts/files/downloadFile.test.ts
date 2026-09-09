import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: false,
  isCapacitor: true,
  writeFile: vi.fn(),
  openNativeWriter: vi.fn(),
  nativeWrite: vi.fn(),
  nativeClose: vi.fn(),
}));

vi.mock("../platform", () => ({
  get isTauri() {
    return mocks.isTauri;
  },
  get isCapacitor() {
    return mocks.isCapacitor;
  },
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { Download: "download" },
  writeFile: mocks.writeFile,
}));
vi.mock("./capacitorFileWriter", () => ({
  CapacitorFileWriter: { open: mocks.openNativeWriter },
}));

import { downloadFile } from "./downloadFile";

describe("downloadFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri = false;
    mocks.isCapacitor = true;
    mocks.nativeWrite.mockResolvedValue(undefined);
    mocks.nativeClose.mockResolvedValue(undefined);
    mocks.openNativeWriter.mockResolvedValue({
      write: mocks.nativeWrite,
      close: mocks.nativeClose,
    });
  });

  it("routes APK downloads through the native stream writer", async () => {
    const saved = await downloadFile("lorebook_export.json", '{"ok":true}');
    expect(saved).toBe(true);
    expect(mocks.openNativeWriter).toHaveBeenCalledWith(
      "lorebook_export.json",
      "application/json",
    );
    expect(mocks.nativeWrite).toHaveBeenCalledTimes(1);
    expect(mocks.nativeClose).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("reports cancellation without attempting a write", async () => {
    mocks.openNativeWriter.mockResolvedValue(null);
    await expect(downloadFile("chat.json", new Uint8Array([1]))).resolves.toBe(
      false,
    );
    expect(mocks.nativeWrite).not.toHaveBeenCalled();
    expect(mocks.nativeClose).not.toHaveBeenCalled();
  });

  it("preserves direct Tauri download-directory writes", async () => {
    mocks.isTauri = true;
    mocks.isCapacitor = false;
    mocks.writeFile.mockResolvedValue(undefined);
    await expect(downloadFile("chat.json", new Uint8Array([7]))).resolves.toBe(
      true,
    );
    expect(mocks.writeFile).toHaveBeenCalledWith(
      "chat.json",
      new Uint8Array([7]),
      { baseDir: "download" },
    );
    expect(mocks.openNativeWriter).not.toHaveBeenCalled();
  });
});
