import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  android: true,
  checkpoint: vi.fn(),
  shareDiagnostics: vi.fn(),
  registerPlugin: vi.fn(),
}));

vi.mock("../platform", () => ({
  get isCapacitorAndroid() {
    return mocks.android;
  },
}));
vi.mock("@capacitor/core", () => ({ registerPlugin: mocks.registerPlugin }));

describe("Android exit diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    mocks.android = true;
    mocks.registerPlugin.mockReturnValue(mocks);
  });

  afterEach(() => vi.restoreAllMocks());

  it("waits for the persisted checkpoint before allowing startup to continue", async () => {
    let resolve!: () => void;
    mocks.checkpoint.mockReturnValue(
      new Promise<void>((done) => (resolve = done)),
    );
    const diagnostics = await import("./androidCrashDiagnostics");
    let continued = false;
    const work = diagnostics
      .androidDiagnosticCheckpoint("startup:sql-domains")
      .then(() => {
        continued = true;
      });
    await Promise.resolve();
    expect(continued).toBe(false);
    resolve();
    await work;
    expect(continued).toBe(true);
  });

  it("allows startup on an older native shell without the diagnostics method", async () => {
    mocks.checkpoint.mockRejectedValue(new Error("not implemented"));
    const diagnostics = await import("./androidCrashDiagnostics");
    await expect(
      diagnostics.androidDiagnosticCheckpoint("startup:sql-domains"),
    ).resolves.toBeUndefined();
  });

  it("propagates sharing failures so the UI can show a retry message", async () => {
    mocks.shareDiagnostics.mockRejectedValue(new Error("no share target"));
    const diagnostics = await import("./androidCrashDiagnostics");
    await expect(diagnostics.shareAndroidDiagnostics()).rejects.toThrow(
      "no share target",
    );
  });

  it("does not access the native bridge on web, desktop or node", async () => {
    mocks.android = false;
    const diagnostics = await import("./androidCrashDiagnostics");
    await diagnostics.androidDiagnosticCheckpoint("startup:sql-domains");
    await diagnostics.shareAndroidDiagnostics();
    diagnostics.initializeAndroidDiagnostics();
    expect(mocks.registerPlugin).not.toHaveBeenCalled();
  });
});
