import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isTauri: true,
  isCapacitor: false,
  setUsingSw: vi.fn(),
  waitForCompatibleController: vi.fn(async () => true),
}));

vi.mock("../globalApi.svelte", () => ({
  setUsingSw: mocks.setUsingSw,
}));

vi.mock("../platform", () => ({
  get isTauri() {
    return mocks.isTauri;
  },
  get isCapacitor() {
    return mocks.isCapacitor;
  },
}));

vi.mock("../stores.svelte", () => ({
  LoadingStatusState: { text: "" },
}));

vi.mock("./serviceWorkerProtocol", () => ({
  waitForCompatibleServiceWorkerController: mocks.waitForCompatibleController,
}));

describe("service worker startup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isTauri = true;
    mocks.isCapacitor = false;
    mocks.waitForCompatibleController.mockResolvedValue(true);
  });

  it("never registers or probes a service worker in Tauri and removes the stale registration", async () => {
    const unregister = vi.fn(async () => true);
    const getRegistration = vi.fn(async () => ({ unregister }));
    const register = vi.fn();
    const addEventListener = vi.fn();

    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration, register, addEventListener },
    });

    const { startServiceWorker } = await import("./serviceWorker");
    await startServiceWorker();

    expect(mocks.setUsingSw).toHaveBeenCalledWith(false);
    expect(getRegistration).toHaveBeenCalledWith("/");
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
    expect(addEventListener).not.toHaveBeenCalled();
    expect(mocks.waitForCompatibleController).not.toHaveBeenCalled();
  });

  it("keeps the normal web registration path enabled", async () => {
    mocks.isTauri = false;
    const update = vi.fn(async () => undefined);
    const register = vi.fn(async () => ({ update }));
    const getRegistration = vi.fn();
    const addEventListener = vi.fn();

    vi.stubGlobal("navigator", {
      serviceWorker: { getRegistration, register, addEventListener },
    });

    const { startServiceWorker } = await import("./serviceWorker");
    await startServiceWorker();

    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(mocks.waitForCompatibleController).toHaveBeenCalledTimes(1);
    expect(mocks.setUsingSw).toHaveBeenCalledWith(true);
    expect(getRegistration).not.toHaveBeenCalled();
  });
});
