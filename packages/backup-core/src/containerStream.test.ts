import { describe, expect, it, vi } from "vitest";
import {
  BackupContainerParser,
  createBackupContainerEntryHeader,
  parseBackupContainer,
} from "./containerStream";

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
