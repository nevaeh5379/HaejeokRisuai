import { beforeEach, describe, expect, it } from "vitest";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import {
  applyUITheme,
  FLUENT_FONT_STACK,
  getUITheme,
  isWindowsFluentTheme,
  setUITheme,
} from "./uiTheme";

describe("UI Theme Management", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    settingsStore.state.uiTheme = "default";
    settingsStore.state.font = "default";
    settingsStore.state.colorScheme = {
      type: "dark",
      bgcolor: "#202020",
      darkbg: "#181818",
      borderc: "#60cdff",
      selected: "#282828",
      draculared: "#ff99a4",
      textcolor: "#ffffff",
      textcolor2: "#a0a0a0",
      darkBorderc: "#3c3c3c",
      darkbutton: "#2d2d2d",
    };
  });

  it("defaults to 'default' UI theme", () => {
    expect(getUITheme()).toBe("default");
    expect(isWindowsFluentTheme()).toBe(false);
  });

  it("preserves the Android theme setting without treating it as Fluent", () => {
    settingsStore.state.uiTheme = "android";
    expect(getUITheme()).toBe("android");
    expect(isWindowsFluentTheme()).toBe(false);
  });

  it("applies windows fluent theme classes and font stack when enabled", () => {
    setUITheme("windows");
    expect(getUITheme()).toBe("windows");
    expect(isWindowsFluentTheme()).toBe(true);
    expect(document.documentElement.classList.contains("theme-windows-fluent")).toBe(true);
    expect(document.documentElement.classList.contains("theme-windows-fluent-dark")).toBe(true);

    const root = document.querySelector(":root") as HTMLElement;
    expect(root.style.getPropertyValue("--risu-font-family")).toBe(FLUENT_FONT_STACK);
  });

  it("applies fluent light class when colorScheme type is light", () => {
    settingsStore.state.colorScheme.type = "light";
    setUITheme("windows");
    expect(document.documentElement.classList.contains("theme-windows-fluent-light")).toBe(true);
    expect(document.documentElement.classList.contains("theme-windows-fluent-dark")).toBe(false);
  });

  it("completely strips windows fluent classes and restores font when reverting to default", () => {
    setUITheme("windows");
    expect(document.documentElement.classList.contains("theme-windows-fluent")).toBe(true);

    setUITheme("default");
    expect(getUITheme()).toBe("default");
    expect(isWindowsFluentTheme()).toBe(false);
    expect(document.documentElement.classList.contains("theme-windows-fluent")).toBe(false);
    expect(document.documentElement.classList.contains("theme-windows-fluent-dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-windows-fluent-light")).toBe(false);

    const root = document.querySelector(":root") as HTMLElement;
    expect(root.style.getPropertyValue("--risu-font-family")).toBe("Arial, sans-serif");
  });
});
