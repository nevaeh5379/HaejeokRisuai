import { describe, expect, it, vi } from "vitest";
import {
  prepareColdStorageBackup,
  writeColdStorageBackup,
} from "./coldStorageExport";

describe("cold-storage backup export", (): void => {
  it("returns null when incomplete data is rejected", async (): Promise<void> => {
    const confirm = vi.fn(async (): Promise<boolean> => false);
    const result = await prepareColdStorageBackup({
      database: { id: "db" },
      collect: async () => ({
        payloads: ["payload"],
        missingKeys: ["missing"],
        invalidKeys: ["invalid"],
      }),
      confirm,
    });

    expect(result).toBeNull();
    expect(confirm).toHaveBeenCalledWith({ id: "db" }, ["missing", "invalid"]);
  });

  it("writes payloads sequentially with injected progress", async (): Promise<void> => {
    const writes: string[] = [];
    const progress = vi.fn();
    await writeColdStorageBackup({
      payloads: ["a", "b"],
      name: (payload: string): string => `${payload}.json`,
      encode: (payload: string): Uint8Array =>
        new TextEncoder().encode(payload),
      write: async (name: string): Promise<void> => {
        writes.push(name);
      },
      onProgress: progress,
    });

    expect(writes).toEqual(["a.json", "b.json"]);
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });
});
