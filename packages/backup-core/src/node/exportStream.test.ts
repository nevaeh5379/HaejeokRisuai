import { describe, expect, it } from "vitest";
import { encodeLegacyBackupDatabase } from "./legacyFormat";
import {
  PORTABLE_DATABASE_STREAM_MANIFEST,
  PortableDatabaseExportWriter,
  databaseFragmentName,
  writeBackupContainerEntry,
} from "./exportStream";
import { BackupContainerParser } from "../containerStream";

describe("PortableDatabaseExportWriter", () => {
  it("fragments records, counts types, and builds a manifest", async () => {
    const entries: Array<{ name: string; data: Uint8Array }> = [];
    const progress: Array<[number, number]> = [];
    const writer = new PortableDatabaseExportWriter({
      revision: 9,
      expectedRecords: 3,
      fragmentRecords: 2,
      encodeDatabase: encodeLegacyBackupDatabase,
      async writeEntry(name, source) {
        expect(source).toBeInstanceOf(Uint8Array);
        entries.push({ name, data: source as Uint8Array });
      },
      onProgress(current, total) {
        progress.push([current, total]);
      },
    });

    await writer.emit({ type: "meta", formatVersion: 1, revision: 9 });
    await writer.emit({ type: "setting", key: "language", value: "ko" });
    await writer.emit({
      type: "character",
      position: 0,
      id: "char-1",
      data: { name: "Bot" },
    });
    const manifest = await writer.finalize();

    expect(entries.map((entry) => entry.name)).toEqual([
      "database.stream/000000000001.risudat",
      "database.stream/000000000002.risudat",
    ]);
    expect(manifest).toMatchObject({
      format: "risu-portable-database-stream",
      revision: 9,
      totalFragments: 2,
      totalRecords: 3,
      counts: { meta: 1, setting: 1, character: 1 },
      complete: true,
    });
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("uses canonical fragment and manifest names", () => {
    expect(databaseFragmentName(7)).toBe(
      "database.stream/000000000007.risudat",
    );
    expect(PORTABLE_DATABASE_STREAM_MANIFEST).toBe(
      "database.stream/manifest.risudat",
    );
  });
});

describe("writeBackupContainerEntry", () => {
  it("writes framing and streamed payload without assembling it", async () => {
    const written: Uint8Array[] = [];
    await writeBackupContainerEntry(
      async (chunk) => {
        written.push(new Uint8Array(chunk));
      },
      "assets/example.bin",
      (async function* () {
        yield new Uint8Array([1, 2]);
        yield new Uint8Array([3, 4, 5]);
      })(),
      5,
    );

    const seen: Array<{ name: string; data: number[] }> = [];
    let current: number[] = [];
    const parser = new BackupContainerParser({
      onEntryStart(entry) {
        current = [];
        seen.push({ name: entry.name, data: current });
      },
      onEntryChunk(_entry, chunk) {
        current.push(...chunk);
      },
    });
    for (const chunk of written) await parser.write(chunk);
    parser.finish();

    expect(seen).toEqual([
      { name: "assets/example.bin", data: [1, 2, 3, 4, 5] },
    ]);
  });
});
