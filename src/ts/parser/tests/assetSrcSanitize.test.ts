// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { ParseMarkdown, trimMarkdown } from "../parser.svelte";

//#region module mocks

vi.mock(import("../../globalApi.svelte"), () => ({
  aiWatermarkingLawApplies: () => false,
  getFileSrc: () => Promise.resolve(""),
}));

vi.mock("../../platform", () => ({
  isTauri: true,
  isNodeServer: false,
  isCapacitor: false,
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({}),
}));
//#endregion

// On desktop (Tauri) getFileSrc resolves local assets to an asset: URL via
// convertFileSrc (globalApi.svelte.ts getFileSrc). DOMPurify must not strip
// the src of such images while keeping the path in alt, which renders every
// {{img::}}/{{image::}}/{{asset::}}/{{emotion::}} asset as broken text.
const assetUrl =
  "asset://localhost/Users/test/Library/Application%20Support/co.aiclient.risu/assets/pic.png";

describe("asset: image src sanitization", () => {
  it("keeps the src of an img whose URL uses the asset: scheme", () => {
    const out = trimMarkdown(`<img src="${assetUrl}" alt="${assetUrl}">`);
    expect(out).toContain(`src="${assetUrl}"`);
  });

  it("keeps the asset: src through the ParseMarkdown chat entry point", async () => {
    const out = await ParseMarkdown(
      `<img src="${assetUrl}" alt="${assetUrl}">`,
      null,
      "back",
    );
    expect(out).toContain(`src="${assetUrl}"`);
  });
});
