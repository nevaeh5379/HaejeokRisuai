import { describe, expect, it } from "vitest";
import {
  buildTauriSidebarMenuPopupUrl,
  calculateTauriSidebarMenuPlacement,
  createTauriSidebarMenuItems,
  parseTauriSidebarMenuLaunch,
} from "./tauriSidebarMenu";

describe("Tauri sidebar menu popup", () => {
  it("round-trips popup launch URLs", () => {
    const url = buildTauriSidebarMenuPopupUrl("main", "sidebar-menu-main-abc", "/");
    expect(parseTauriSidebarMenuLaunch(url.slice(url.indexOf("?")))).toEqual({
      sourceWindowLabel: "main",
      popupWindowLabel: "sidebar-menu-main-abc",
    });
  });

  it("places the popup above the trigger when space is available", () => {
    expect(
      calculateTauriSidebarMenuPlacement({
        sourceInnerPosition: { x: 200, y: 100 },
        sourceScaleFactor: 2,
        triggerRect: { left: 20, top: 300, width: 40, height: 32 },
        popupWidth: 62,
        popupHeight: 280,
        workAreaPosition: { x: 0, y: 0 },
        workAreaSize: { width: 1600, height: 1200 },
        workAreaScaleFactor: 2,
      }),
    ).toEqual({ x: 109, y: 62 });
  });

  it("falls below and clamps when there is no room above", () => {
    expect(
      calculateTauriSidebarMenuPlacement({
        sourceInnerPosition: { x: 0, y: 0 },
        sourceScaleFactor: 2,
        triggerRect: { left: 0, top: 10, width: 40, height: 32 },
        popupWidth: 62,
        popupHeight: 200,
        workAreaPosition: { x: 0, y: 0 },
        workAreaSize: { width: 600, height: 500 },
        workAreaScaleFactor: 2,
      }),
    ).toEqual({ x: 0, y: 50 });
  });

  it("keeps plugin items before the character grid action", () => {
    const items = createTauriSidebarMenuItems([
      { id: "plug", name: "Plugin", icon: "", iconType: "none" },
    ]);
    expect(items.map((item) => item.action)).toEqual([
      "settings",
      "home",
      "playground",
      "search",
      "plugin:plug",
      "grid",
    ]);
  });
});
