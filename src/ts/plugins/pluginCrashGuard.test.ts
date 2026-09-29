import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const plugin = {
    setLoadingPlugin: vi.fn(),
    clearLoadingPlugin: vi.fn(),
    getBlockedPlugins: vi.fn(),
    clearBlockedPlugin: vi.fn(),
  };
  return { ...plugin, registerPlugin: vi.fn(() => plugin) };
});

vi.mock("../platform", () => ({ isCapacitorAndroid: true }));
vi.mock("@capacitor/core", () => ({
  registerPlugin: mocks.registerPlugin,
}));

import {
  clearBlockedPlugin,
  clearLoadingPlugin,
  getBlockedPlugins,
  setLoadingPlugin,
} from "./pluginCrashGuard";

describe("pluginCrashGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns blocked plugin names from the native bridge", async () => {
    mocks.getBlockedPlugins.mockResolvedValue({
      plugins: ["bad-plugin"],
    });
    await expect(getBlockedPlugins()).resolves.toEqual(["bad-plugin"]);
    expect(mocks.getBlockedPlugins).toHaveBeenCalled();
  });

  it("returns an empty list when the native bridge fails", async () => {
    mocks.getBlockedPlugins.mockRejectedValue(new Error("bridge down"));
    await expect(getBlockedPlugins()).resolves.toEqual([]);
  });

  it("records the loading ledger before a sandbox starts", async () => {
    mocks.setLoadingPlugin.mockResolvedValue(undefined);
    await setLoadingPlugin("plugin-a");
    expect(mocks.setLoadingPlugin).toHaveBeenCalledWith({
      name: "plugin-a",
    });
  });

  it("clears the loading ledger after boot stabilizes", async () => {
    mocks.clearLoadingPlugin.mockResolvedValue(undefined);
    await clearLoadingPlugin();
    expect(mocks.clearLoadingPlugin).toHaveBeenCalled();
  });

  it("removes a plugin from the native blocklist", async () => {
    mocks.clearBlockedPlugin.mockResolvedValue(undefined);
    await clearBlockedPlugin("bad-plugin");
    expect(mocks.clearBlockedPlugin).toHaveBeenCalledWith({
      name: "bad-plugin",
    });
  });

  it("swallows bridge errors for ledger writes", async () => {
    mocks.setLoadingPlugin.mockRejectedValue(new Error("bridge down"));
    await expect(setLoadingPlugin("plugin-a")).resolves.toBeUndefined();
  });
});

describe("pluginCrashGuard on non-Android platforms", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.doMock("../platform", () => ({ isCapacitorAndroid: false }));
  });

  it("is a no-op without registering the native plugin", async () => {
    const mod = await import("./pluginCrashGuard");
    await expect(mod.getBlockedPlugins()).resolves.toEqual([]);
    await mod.setLoadingPlugin("plugin-a");
    expect(mocks.registerPlugin).not.toHaveBeenCalled();
    expect(mocks.setLoadingPlugin).not.toHaveBeenCalled();
  });
});