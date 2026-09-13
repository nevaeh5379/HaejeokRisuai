import { describe, expect, it } from "vitest";
import {
  colorSchemeList,
  colorSchemePresets,
  isFluentColorScheme,
} from "./colorscheme";

describe("Windows 11 Fluent theme presets", () => {
  it("identifies fluent color scheme keys", () => {
    expect(isFluentColorScheme("fluent-dark")).toBe(true);
    expect(isFluentColorScheme("fluent-light")).toBe(true);
    expect(isFluentColorScheme("default")).toBe(false);
    expect(isFluentColorScheme("dark")).toBe(false);
    expect(isFluentColorScheme("light")).toBe(false);
    expect(isFluentColorScheme(undefined)).toBe(false);
    expect(isFluentColorScheme(null)).toBe(false);
  });

  it("includes fluent-dark and fluent-light in colorSchemeList", () => {
    expect(colorSchemeList).toContain("fluent-dark");
    expect(colorSchemeList).toContain("fluent-light");
  });

  it("defines fluent-dark with WinUI 3 dark tokens", () => {
    const dark = colorSchemePresets["fluent-dark"];
    expect(dark).toBeDefined();
    expect(dark.type).toBe("dark");
    expect(dark.bgcolor).toBe("#2b2b2b");
    expect(dark.darkbg).toBe("#202020");
    expect(dark.borderc).toBe("#60cdff");
    expect(dark.textcolor).toBe("#ffffff");
  });

  it("defines fluent-light with WinUI 3 light tokens", () => {
    const light = colorSchemePresets["fluent-light"];
    expect(light).toBeDefined();
    expect(light.type).toBe("light");
    expect(light.bgcolor).toBe("#ffffff");
    expect(light.darkbg).toBe("#f3f3f3");
    expect(light.borderc).toBe("#0067c0");
    expect(light.textcolor).toBe("#1b1b1b");
  });
});
