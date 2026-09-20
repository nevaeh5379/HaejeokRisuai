import { describe, expect, it } from "vitest";
import {
  streamBackupInlays,
  type BackupInlayEntry,
  type StreamBackupInlaysResult,
} from "./inlayExport";

describe("streamBackupInlays", (): void => {
  it("validates names and streams encoded entries in order", async (): Promise<void> => {
    const entries: Array<BackupInlayEntry<string>> = [
      ["00000000-0000-0000-0000-000000000001", "first"],
      ["unsupported", "skip"],
      ["00000000-0000-0000-0000-000000000002", "second"],
    ];
    const written: Array<[string, string]> = [];
    const progress: number[] = [];
    const skipped: string[] = [];

    const result: StreamBackupInlaysResult = await streamBackupInlays({
      entries,
      async encode(asset: string): Promise<Uint8Array> {
        return new TextEncoder().encode(asset);
      },
      async write(name: string, data: Uint8Array): Promise<void> {
        written.push([name, new TextDecoder().decode(data)]);
      },
      onProgress(current: number): void {
        progress.push(current);
      },
      onUnsupportedKey(id: string): void {
        skipped.push(id);
      },
    });

    expect(result).toEqual({ written: 2, skipped: 1 });
    expect(progress).toEqual([1, 3]);
    expect(skipped).toEqual(["unsupported"]);
    expect(written).toEqual([
      ["inlay_00000000-0000-0000-0000-000000000001.risuinlay", "first"],
      ["inlay_00000000-0000-0000-0000-000000000002.risuinlay", "second"],
    ]);
  });
});
