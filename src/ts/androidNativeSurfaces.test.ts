import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_BOT_COUNT,
  MAX_WIDGET_BOT_COUNT,
  MIN_WIDGET_BOT_COUNT,
  getAndroidWidgetBotCount,
} from "./androidNativeSurfaces";
import { settingsStore } from "./stores/domain/settingsStore.svelte";

describe("getAndroidWidgetBotCount", () => {
  it("returns default value when not configured", () => {
    delete (settingsStore.state as Record<string, unknown>).androidWidgetBotCount;
    expect(getAndroidWidgetBotCount()).toBe(DEFAULT_WIDGET_BOT_COUNT);
    expect(DEFAULT_WIDGET_BOT_COUNT).toBe(12);
  });

  it("returns configured value when within valid bounds", () => {
    settingsStore.state.androidWidgetBotCount = 6;
    expect(getAndroidWidgetBotCount()).toBe(6);

    settingsStore.state.androidWidgetBotCount = 24;
    expect(getAndroidWidgetBotCount()).toBe(24);
  });

  it("clamps values below minimum and above maximum", () => {
    settingsStore.state.androidWidgetBotCount = 0;
    expect(getAndroidWidgetBotCount()).toBe(MIN_WIDGET_BOT_COUNT);

    settingsStore.state.androidWidgetBotCount = 100;
    expect(getAndroidWidgetBotCount()).toBe(MAX_WIDGET_BOT_COUNT);
  });

  it("handles non-integer and invalid numbers gracefully", () => {
    settingsStore.state.androidWidgetBotCount = 15.8;
    expect(getAndroidWidgetBotCount()).toBe(15);

    settingsStore.state.androidWidgetBotCount = Number.NaN;
    expect(getAndroidWidgetBotCount()).toBe(DEFAULT_WIDGET_BOT_COUNT);
  });
});
