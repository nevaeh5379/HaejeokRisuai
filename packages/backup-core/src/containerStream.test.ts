import { describe, expect, it, vi } from "vitest";
import {
  BackupContainerParser,
  createBackupContainerEntryHeader,
  parseBackupContainer,
  parseBufferedBackupContainer,
  type BackupContainerEntryInfo,
  type BufferedBackupContainerResult,
} from "./containerStream";
import type { BackupEntryClassification } from "./entryPolicy";

function entry(name: string, data: Uint8Array): Uint8Array {
  const header = createBackupContainerEntryHeader(name, data.length);
  const result = new Uint8Array(header.length + data.length);
  result.set(header, 0);
  result.set(data, header.length);
  return result;
}

async function* chunked(
  data: Uint8Array,
  chunkSize: number,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    yield data.subarray(offset, Math.min(data.length, offset + chunkSize));
  }
}

function unsafeEntry(name: string, data: Uint8Array): Uint8Array {
  const encodedName: Uint8Array = new TextEncoder().encode(name);
  const result: Uint8Array = new Uint8Array(
    8 + encodedName.byteLength + data.byteLength,
  );
  const view: DataView = new DataView(result.buffer);
  view.setUint32(0, encodedName.byteLength, true);
  result.set(encodedName, 4);
  view.setUint32(4 + encodedName.byteLength, data.byteLength, true);
  result.set(data, 8 + encodedName.byteLength);
  return result;
}

describe("BackupContainerParser", () => {
  it("encodes canonical little-endian entry headers", () => {
    const header = createBackupContainerEntryHeader("assets/a.png", 1234);
    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const nameLength = view.getUint32(0, true);
    expect(new TextDecoder().decode(header.subarray(4, 4 + nameLength))).toBe(
      "assets/a.png",
    );
    expect(view.getUint32(4 + nameLength, true)).toBe(1234);
    expect(() =>
      createBackupContainerEntryHeader("assets/../secret", 1),
    ).toThrow("Invalid backup entry path");
  });

  it("parses entry framing across arbitrary chunk boundaries", async () => {
    const first = entry("database.risudat", new Uint8Array([1, 2, 3, 4, 5]));
    const second = entry("assets/a.png", new Uint8Array([9, 8, 7]));
    const input = new Uint8Array(first.length + second.length);
    input.set(first, 0);
    input.set(second, first.length);

    const seen = new Map<string, number[]>();
    await parseBackupContainer(chunked(input, 3), {
      onEntryStart({ name }) {
        seen.set(name, []);
      },
      onEntryChunk({ name }, chunk) {
        seen.get(name)!.push(...chunk);
      },
    });

    expect(seen.get("database.risudat")).toEqual([1, 2, 3, 4, 5]);
    expect(seen.get("assets/a.png")).toEqual([9, 8, 7]);
  });

  it("does not combine a large entry into one parser-owned buffer", async () => {
    const data = new Uint8Array(1024 * 1024);
    data.fill(7);
    const input = entry("database.risudat", data);
    const chunks: number[] = [];
    const onChunk = vi.fn((_entry, chunk: Uint8Array) => {
      chunks.push(chunk.length);
    });

    await parseBackupContainer(chunked(input, 4096), {
      onEntryChunk: onChunk,
    });

    expect(onChunk).toHaveBeenCalled();
    expect(Math.max(...chunks)).toBeLessThanOrEqual(4096);
    expect(chunks.reduce((sum, size) => sum + size, 0)).toBe(data.length);
  });

  it("rejects truncated containers", async () => {
    const input = entry("a", new Uint8Array([1, 2, 3]));
    const parser = new BackupContainerParser({});
    await parser.write(input.subarray(0, input.length - 1));
    expect(() => parser.finish()).toThrow(/incomplete/i);
  });
});

describe("parseBufferedBackupContainer", (): void => {
  it("classifies and forwards supported entries one at a time", async (): Promise<void> => {
    const databaseData: Uint8Array = new Uint8Array([1, 2, 3]);
    const assetData: Uint8Array = new Uint8Array([4, 5]);
    const databaseEntry: Uint8Array = entry("database.risudat", databaseData);
    const assetEntry: Uint8Array = entry("assets/a.png", assetData);
    const input: Uint8Array = new Uint8Array(
      databaseEntry.byteLength + assetEntry.byteLength,
    );
    input.set(databaseEntry, 0);
    input.set(assetEntry, databaseEntry.byteLength);
    const seen: Array<{
      name: string;
      kind: BackupEntryClassification["kind"];
      data: number[];
    }> = [];

    const result: BufferedBackupContainerResult =
      await parseBufferedBackupContainer(chunked(input, 2), {
        onEntry(
          entryInfo: BackupContainerEntryInfo,
          data: Uint8Array,
          classification: BackupEntryClassification,
        ): void {
          seen.push({
            name: entryInfo.name,
            kind: classification.kind,
            data: Array.from(data),
          });
        },
      });

    expect(seen).toEqual([
      { name: "database.risudat", kind: "database", data: [1, 2, 3] },
      { name: "assets/a.png", kind: "asset", data: [4, 5] },
    ]);
    expect(result).toEqual({
      bytesRead: input.byteLength,
      entriesHandled: 2,
      ignoredExtensionEntries: 0,
    });
  });

  it("consumes extension payloads without forwarding them", async (): Promise<void> => {
    const extensionData: Uint8Array = new Uint8Array(1024 * 1024);
    const input: Uint8Array = entry("future/metadata.bin", extensionData);
    let forwardedEntries: number = 0;
    const skippedNames: string[] = [];

    const result: BufferedBackupContainerResult =
      await parseBufferedBackupContainer(chunked(input, 4096), {
        onEntry(): void {
          forwardedEntries += 1;
        },
        onExtensionEntry(entryInfo: BackupContainerEntryInfo): void {
          skippedNames.push(entryInfo.name);
        },
      });

    expect(forwardedEntries).toBe(0);
    expect(skippedNames).toEqual(["future/metadata.bin"]);
    expect(result.ignoredExtensionEntries).toBe(1);
  });

  it("reports chunk progress before forwarding the completed entry", async (): Promise<void> => {
    const input: Uint8Array = entry(
      "database.risudat",
      new Uint8Array([1, 2, 3, 4]),
    );
    const progress: number[] = [];
    let entryForwarded: boolean = false;

    const result: BufferedBackupContainerResult =
      await parseBufferedBackupContainer(chunked(input, 3), {
        onChunk(_chunk: Uint8Array, totalBytesRead: number): void {
          expect(entryForwarded).toBe(false);
          progress.push(totalBytesRead);
        },
        onEntry(): void {
          entryForwarded = true;
        },
      });

    expect(progress.at(-1)).toBe(input.byteLength);
    expect(result.bytesRead).toBe(input.byteLength);
    expect(entryForwarded).toBe(true);
  });

  it("rejects unsafe entry names before forwarding payloads", async (): Promise<void> => {
    const input: Uint8Array = unsafeEntry(
      "assets/../secret.bin",
      new Uint8Array([1]),
    );
    let entryForwarded: boolean = false;

    await expect(
      parseBufferedBackupContainer(chunked(input, 2), {
        onEntry(): void {
          entryForwarded = true;
        },
      }),
    ).rejects.toThrow("Invalid backup entry path");
    expect(entryForwarded).toBe(false);
  });
});
