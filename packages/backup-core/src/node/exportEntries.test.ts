import { describe, expect, it } from "vitest";
import {
  coldStorageExportEntryName,
  streamBackupStorageEntries,
  streamColdStorageExportEntries,
} from "./exportEntries";

describe("streamColdStorageExportEntries", () => {
  it("encodes canonical entries and reports progress", async () => {
    const written: Array<{ name: string; text: string }> = [];
    const progress: Array<[number | undefined, number | undefined]> = [];

    await streamColdStorageExportEntries({
      keys: ["11111111-1111-1111-1111-111111111111"],
      async load() {
        return {
          exists: true,
          value: { character: { name: "Bot" } },
        };
      },
      async writeEntry(name, source) {
        expect(source).toBeInstanceOf(Uint8Array);
        written.push({
          name,
          text: new TextDecoder().decode(source as Uint8Array),
        });
      },
      onProgress(update) {
        progress.push([update.current, update.total]);
      },
    });

    expect(written).toEqual([
      {
        name: "coldstorage_11111111-1111-1111-1111-111111111111.json",
        text: JSON.stringify({ character: { name: "Bot" } }),
      },
    ]);
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
  });

  it("rejects invalid cold storage keys", () => {
    expect(() => coldStorageExportEntryName("../bad")).toThrow(
      "Invalid cold storage backup key",
    );
  });
});

describe("streamBackupStorageEntries", () => {
  it("streams available assets and preserves progress semantics", async () => {
    const written: string[] = [];
    const progress: Array<[number | undefined, number | undefined]> = [];

    await streamBackupStorageEntries({
      stage: "assets",
      keys: ["assets/a.png", "assets/missing.png"],
      async open(key) {
        if (key.endsWith("missing.png")) return { exists: false };
        return {
          exists: true,
          source: new Uint8Array([1, 2, 3]),
          size: 3,
        };
      },
      async writeEntry(name) {
        written.push(name);
      },
      onProgress(update) {
        progress.push([update.current, update.total]);
      },
    });

    expect(written).toEqual(["assets/a.png"]);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
    ]);
  });
  it("validates streamable inlay sources", async () => {
    await expect(
      streamBackupStorageEntries({
        stage: "inlays",
        keys: ["inlay_11111111-1111-4111-8111-111111111111.risuinlay"],
        async open() {
          return { exists: true, source: null, size: 10 };
        },
        async writeEntry() {},
      }),
    ).rejects.toThrow("Backup inlay is not streamable");
  });
});
