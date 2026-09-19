import { describe, expect, it, vi } from "vitest";
import {
  streamLocalBackupArchive,
  type LocalBackupArchiveExportAdapter,
} from "./exportArchive";

function manifest() {
  return {
    format: "risu-portable-database-stream" as const,
    version: 1 as const,
    revision: 7,
    totalFragments: 1,
    totalRecords: 1,
    counts: { character: 1 },
    complete: true as const,
  };
}

describe("streamLocalBackupArchive", () => {
  it("owns compatible export ordering", async () => {
    const events: string[] = [];
    const progress: string[] = [];
    const writeEntry = vi.fn(async (name: string) => {
      events.push(`write:${name}`);
    });
    const adapter: LocalBackupArchiveExportAdapter = {
      async onReady() {
        events.push("ready");
      },
      writeEntry,
      async prepareCompatibleDatabase() {
        events.push("prepare-compatible");
        return {
          source: new Uint8Array([1, 2]),
          size: 2,
          coldStorageKeys: ["11111111-1111-1111-1111-111111111111"],
          async loadColdStorage() {
            events.push("load-compatible-cold");
            return {
              exists: true,
              value: { character: { name: "Bot" } },
            };
          },
        };
      },
      async streamNativeDatabase() {
        throw new Error("native export should not run");
      },
      async listColdStorageKeys() {
        throw new Error("native cold storage should not run");
      },
      async loadColdStorage() {
        throw new Error("native cold storage should not run");
      },
      async assertDatabaseRevision() {
        throw new Error("native revision check should not run");
      },
      async listAssetKeys() {
        events.push("list-assets");
        return ["assets/a.png"];
      },
      async listInlayKeys() {
        throw new Error("compatible inlays should not run");
      },
      async openStorageEntry(key) {
        events.push(`open:${key}`);
        return {
          exists: true,
          source: new Uint8Array([3]),
          size: 1,
        };
      },
      async encodeDatabase() {
        throw new Error("native manifest encoding should not run");
      },
    };

    await streamLocalBackupArchive({
      mode: "compatible",
      adapter,
      onProgress(update) {
        progress.push(update.stage);
      },
    });

    expect(events).toEqual([
      "prepare-compatible",
      "list-assets",
      "ready",
      "write:database.risudat",
      "load-compatible-cold",
      "write:coldstorage_11111111-1111-1111-1111-111111111111.json",
      "open:assets/a.png",
      "write:assets/a.png",
    ]);
    expect(progress).toEqual([
      "database",
      "database",
      "coldStorage",
      "coldStorage",
      "assets",
      "assets",
      "finalizing",
    ]);
  });

  it("writes native manifest after storage entries", async () => {
    const events: string[] = [];
    let adapter!: LocalBackupArchiveExportAdapter;
    adapter = {
      async onReady() {
        events.push("ready");
      },
      async writeEntry(name) {
        events.push(`write:${name}`);
      },
      async prepareCompatibleDatabase() {
        throw new Error("compatible export should not run");
      },
      async streamNativeDatabase(options) {
        events.push("stream-database");
        await adapter.writeEntry(
          "database.stream/000000000001.risudat",
          new Uint8Array([1]),
          1,
        );
        options.onProgress({
          stage: "database",
          current: 1,
          total: 1,
        });
        return manifest();
      },
      async listColdStorageKeys() {
        events.push("list-cold");
        return ["11111111-1111-1111-1111-111111111111"];
      },
      async loadColdStorage() {
        events.push("load-cold");
        return { exists: true, value: [] };
      },
      async assertDatabaseRevision(revision) {
        events.push(`assert:${revision}`);
      },
      async listAssetKeys() {
        events.push("list-assets");
        return ["assets/a.png"];
      },
      async listInlayKeys() {
        events.push("list-inlays");
        return ["inlay_11111111-1111-4111-8111-111111111111.risuinlay"];
      },
      async openStorageEntry(key) {
        events.push(`open:${key}`);
        return {
          exists: true,
          source: new Uint8Array([2]),
          size: 1,
        };
      },
      async encodeDatabase(value) {
        events.push(`encode:${(value as { revision: number }).revision}`);
        return new Uint8Array([9]);
      },
    };

    await streamLocalBackupArchive({
      mode: "native",
      adapter,
    });

    expect(events.at(-2)).toBe("encode:7");
    expect(events.at(-1)).toBe("write:database.stream/manifest.risudat");
    expect(events).toContain("write:database.stream/000000000001.risudat");
    expect(events).toContain(
      "write:inlay_11111111-1111-4111-8111-111111111111.risuinlay",
    );
    expect(events.indexOf("load-cold")).toBeLessThan(
      events.indexOf("assert:7"),
    );
  });

  it("limits partial archives to referenced assets and skips inlays", async () => {
    const written: string[] = [];
    const listInlays = vi.fn(async () => [
      "inlay_11111111-1111-4111-8111-111111111111.risuinlay",
    ]);
    const adapter: LocalBackupArchiveExportAdapter = {
      async writeEntry(name) {
        written.push(name);
      },
      async prepareCompatibleDatabase() {
        throw new Error("compatible export should not run");
      },
      async streamNativeDatabase(options) {
        options.onRecord({
          type: "character",
          id: "char-1",
          position: 0,
          data: { image: "assets/keep.png" },
        });
        return manifest();
      },
      async listColdStorageKeys() {
        return [];
      },
      async loadColdStorage() {
        return { exists: false };
      },
      async assertDatabaseRevision() {},
      async listAssetKeys() {
        return ["assets/keep.png", "assets/drop.png"];
      },
      listInlayKeys: listInlays,
      async openStorageEntry(key) {
        return {
          exists: true,
          source: new Uint8Array([1]),
          size: 1,
        };
      },
      async encodeDatabase() {
        return new Uint8Array([9]);
      },
    };

    await streamLocalBackupArchive({
      mode: "partial",
      adapter,
    });

    expect(written).toContain("assets/keep.png");
    expect(written).not.toContain("assets/drop.png");
    expect(written.some((name) => name.startsWith("inlay_"))).toBe(false);
    expect(listInlays).not.toHaveBeenCalled();
    expect(written.at(-1)).toBe("database.stream/manifest.risudat");
  });
});
