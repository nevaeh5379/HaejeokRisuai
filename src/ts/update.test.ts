import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(),
  alertClear: vi.fn(),
  alertConfirm: vi.fn(),
  alertError: vi.fn(),
  alertProgress: vi.fn(),
  alertSelect: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "web" },
  registerPlugin: vi.fn(),
}));

vi.mock("./platform", () => ({
  isCapacitor: false,
  isTauri: true,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: mocks.check,
}));

vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mocks.relaunch,
}));
vi.mock("./alert", () => ({
  alertClear: mocks.alertClear,
  alertConfirm: mocks.alertConfirm,
  alertError: mocks.alertError,
  alertProgress: mocks.alertProgress,
  alertSelect: mocks.alertSelect,
}));

vi.mock("../lang", () => ({
  language: {
    newVersion: "Update found",
    remindIgnore: "Ignore",
    remindLater1Day: "1 day",
    remindLater3Days: "3 days",
    remindLater5Days: "5 days",
    remindLater1Week: "1 week",
    remindLaterQuestion: "Later?",
  },
}));

const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.clearAllMocks();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
describe("application updater", () => {
  it("ignores only the selected release version", async () => {
    const firstRelease = {
      version: "0.0.7000",
      currentVersion: "0.0.6999",
      downloadAndInstall: vi.fn(),
    };
    mocks.check.mockResolvedValue(firstRelease);
    mocks.alertConfirm.mockResolvedValue(false);
    mocks.alertSelect.mockResolvedValue("0");

    const { checkRisuUpdate } = await import("./update");
    await checkRisuUpdate();
    await checkRisuUpdate();

    expect(mocks.alertConfirm).toHaveBeenCalledTimes(1);
    expect(mocks.check).toHaveBeenCalledTimes(2);

    mocks.check.mockResolvedValue({
      ...firstRelease,
      version: "0.0.7001",
    });
    await checkRisuUpdate();

    expect(mocks.alertConfirm).toHaveBeenCalledTimes(2);
  });
  it("downloads, reports progress, and relaunches Tauri", async () => {
    const downloadAndInstall = vi.fn(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 25 } });
      onEvent({ event: "Finished" });
    });
    mocks.check.mockResolvedValue({
      version: "0.0.7000",
      currentVersion: "0.0.6999",
      downloadAndInstall,
    });
    mocks.alertConfirm.mockResolvedValue(true);

    const { checkRisuUpdate } = await import("./update");
    await checkRisuUpdate();

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mocks.alertProgress).toHaveBeenCalledWith(
      "Updating to 0.0.7000...",
      25,
    );
    expect(mocks.alertProgress).toHaveBeenCalledWith(
      "Updating to 0.0.7000...",
      100,
    );
    expect(mocks.relaunch).toHaveBeenCalledTimes(1);
  });
});