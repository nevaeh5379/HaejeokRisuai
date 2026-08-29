import { describe, expect, it } from "vitest";
import { isTauriAssetUrl, shouldForceKeepMediaSrc } from "./mediaSrc";

describe("Tauri media sources", () => {
  it("recognizes only the app-owned asset protocol host", () => {
    expect(isTauriAssetUrl("asset://localhost/%2Ftmp%2Fimage.png")).toBe(true);
    expect(isTauriAssetUrl("ASSET://LOCALHOST/path/image.png")).toBe(true);
    expect(isTauriAssetUrl("asset://localhost.evil/image.png")).toBe(false);
    expect(isTauriAssetUrl("asset://localhost@evil/image.png")).toBe(false);
    expect(isTauriAssetUrl("javascript:alert(1)")).toBe(false);
  });

  it("keeps Tauri asset URLs only in a Tauri webview", () => {
    const url = "asset://localhost/%2Ftmp%2Fimage.png";

    expect(shouldForceKeepMediaSrc(url, true)).toBe(true);
    expect(shouldForceKeepMediaSrc(url, false)).toBe(false);
    expect(shouldForceKeepMediaSrc("blob:https://localhost/id", false)).toBe(
      true,
    );
  });
});
