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

import { PluginCrashGuard } from "./pluginCrashGuard";

describe("pluginCrashGuard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns blocked plugin names from the native bridge", async () => {
    mocks.getBlockedPlugins.mockResolvedValue({
      plugins: ["bad-plugin"],
    });
    const guard = PluginCrashGuard.getInstance()!;
    await expect(guard.getBlocked()).resolves.toEqual(["bad-plugin"]);
    expect(mocks.getBlockedPlugins).toHaveBeenCalled();
  });

  it("returns an empty list when the native bridge fails", async () => {
    mocks.getBlockedPlugins.mockRejectedValue(new Error("bridge down"));
    const guard = PluginCrashGuard.getInstance()!;
    await expect(guard.getBlocked()).resolves.toEqual([]);
  });

  it("records the loading ledger before a sandbox starts", async () => {
    mocks.setLoadingPlugin.mockResolvedValue(undefined);
    const guard = PluginCrashGuard.getInstance()!;
    await guard.setLoading("plugin-a");
    expect(mocks.setLoadingPlugin).toHaveBeenCalledWith({
      name: "plugin-a",
    });
  });

  it("clears the loading ledger after boot stabilizes", async () => {
    mocks.clearLoadingPlugin.mockResolvedValue(undefined);
    const guard = PluginCrashGuard.getInstance()!;
    await guard.clearLoading();
    expect(mocks.clearLoadingPlugin).toHaveBeenCalled();
  });

  it("removes a plugin from the native blocklist", async () => {
    mocks.clearBlockedPlugin.mockResolvedValue(undefined);
    const guard = PluginCrashGuard.getInstance()!;
    await guard.clearBlocked("bad-plugin");
    expect(mocks.clearBlockedPlugin).toHaveBeenCalledWith({
      name: "bad-plugin",
    });
  });

  it("swallows bridge errors for ledger writes", async () => {
    mocks.setLoadingPlugin.mockRejectedValue(new Error("bridge down"));
    const guard = PluginCrashGuard.getInstance()!;
    await expect(guard.setLoading("plugin-a")).resolves.toBeUndefined();
  });

  it("returns the same singleton instance on repeated calls", () => {
    const first = PluginCrashGuard.getInstance();
    const second = PluginCrashGuard.getInstance();
    expect(first).not.toBeNull();
    expect(first).toBe(second);
  });

  it("preserves `this` binding on native plugin methods", async () => {
    let capturedThis: unknown = null;
    mocks.clearLoadingPlugin.mockImplementation(function (this: unknown) {
      capturedThis = this;
      return Promise.resolve();
    });
    const guard = PluginCrashGuard.getInstance()!;
    await guard.clearLoading();
    expect(capturedThis).toBe(mocks.registerPlugin());
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
    const guard = mod.PluginCrashGuard.getInstance();
    expect(guard).toBeNull();
    expect(mocks.registerPlugin).not.toHaveBeenCalled();
  });
});
