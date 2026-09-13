import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("./platform", () => ({ isTauriWindows: true }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { ensureFluentWindowsBackdrop } from "./windowsTransparency";

const STORAGE_KEY = "risu.windowsTransparency.v1";

describe("ensureFluentWindowsBackdrop", () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    invoke.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reapplies the user's selected effect without overwriting it", async () => {
    const preferences = {
      enabled: true,
      effect: "tabbed",
      opacity: 80,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));

    await ensureFluentWindowsBackdrop();

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toEqual(
      preferences,
    );
    expect(invoke).toHaveBeenCalledWith("set_risu_windows_backdrop", {
      effect: "tabbed",
    });
  });
});
