import { describe, it, expect } from "vitest";
import { mount, unmount } from "svelte";
import LogContainer from "src/lib/LogExporter/LogContainer.svelte";
import { DEFAULT_SETTINGS } from "src/ts/logexporter/types";
import type {
  LogExportData,
  LogExporterSettings,
} from "src/ts/logexporter/types";
import { clearBatchCache } from "src/ts/logexporter/messageRenderer";
import { generateExport } from "src/ts/logexporter/htmlGenerator";
import type { ColorPalette } from "src/ts/logexporter/types";

function makeData(count: number): LogExportData {
  return {
    charInfo: { name: "Char", chatName: "Chat", avatarUrl: "" },
    messages: Array.from({ length: count }, (_, i) => ({
      key: `k${i}`,
      name: i % 2 ? "User" : "Char",
      isUser: Boolean(i % 2),
      html: `<p>hello ${i}</p>`,
      avatarUrl: "",
      time: "",
    })),
    participants: new Set(["User", "Char"]),
  } as unknown as LogExportData;
}

async function mountOnce(
  data: LogExportData,
  settings: LogExporterSettings,
  isForExport: boolean,
) {
  const target = document.createElement("div");
  document.body.appendChild(target);
  const app = mount(LogContainer, {
    target,
    props: {
      data,
      settings,
      selectedThemeKey: settings.theme,
      selectedColorKey: settings.color,
      fontSize: settings.previewFontSize,
      containerWidth: settings.previewWidth,
      isForExport,
    },
  });
  await new Promise((r) => setTimeout(r, 80));
  return {
    complete: Boolean(
      target.querySelector('[data-log-render-complete="true"]'),
    ),
    async destroy() {
      await unmount(app);
      target.remove();
    },
  };
}

describe("LogExporter export rendering", () => {
  it("completes offscreen export after preview warmed the cache (regression: effect_update_depth_exceeded)", async () => {
    clearBatchCache();
    const data = makeData(5);
    const settings = { ...DEFAULT_SETTINGS };

    // Phase 1: basic preview (visible container), warms the processed-HTML cache
    const preview = await mountOnce(data, settings, false);
    await preview.destroy();

    // Phase 2: HTML mode -> offscreen export mount with warm cache
    const exporter = await mountOnce(
      data,
      { ...settings, format: "html" },
      true,
    );
    expect(exporter.complete).toBe(true);
    await exporter.destroy();
  }, 10000);

  it("generates standalone HTML export after preview warmed the cache", async () => {
    clearBatchCache();
    const data = makeData(5);
    const settings = { ...DEFAULT_SETTINGS };
    const preview = await mountOnce(data, settings, false);
    await preview.destroy();
    const result = await generateExport(data, { ...settings, format: "html" }, {
      background: "#1a1b26",
    } as ColorPalette);
    expect(result.format).toBe("html");
    expect(result.content).toContain("<!DOCTYPE html>");
    expect(result.content).toContain("hello 0");
  }, 15000);

  it("completes offscreen export with cold cache and empty messages", async () => {
    clearBatchCache();
    const data = makeData(3);
    data.messages.push({
      key: "empty",
      name: "User",
      isUser: true,
      html: "",
      avatarUrl: "",
      time: "",
    } as unknown as LogExportData["messages"][0]);
    const settings = { ...DEFAULT_SETTINGS };
    const exporter = await mountOnce(data, settings, true);
    expect(exporter.complete).toBe(true);
    await exporter.destroy();
  }, 10000);
});
