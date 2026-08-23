import { describe, expect, it, vi } from "vitest";
import { createCachedLoader } from "./sidebarPanelLoaders";

describe("createCachedLoader", () => {
  it("reuses the same promise for concurrent and later calls", async () => {
    let resolve!: (value: string) => void;
    const factory = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const loader = createCachedLoader(factory);

    const first = loader();
    const second = loader();

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);

    resolve("loaded");
    await expect(first).resolves.toBe("loaded");
    expect(loader()).toBe(first);
  });

  it("clears only a failed promise so a later call can retry", async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce("loaded");
    const loader = createCachedLoader(factory);

    await expect(loader()).rejects.toThrow("network failure");
    await expect(loader()).resolves.toBe("loaded");
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
