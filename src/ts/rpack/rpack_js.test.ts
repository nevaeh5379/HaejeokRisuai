import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeRPack,
  encodeRPack,
  initRPack,
  resetRPackForTesting,
} from "./rpack_js";

describe("rpack_js", () => {
  let validMapBuffer: Buffer;

  beforeEach(async () => {
    resetRPackForTesting();
    validMapBuffer = await readFile(
      resolve(process.cwd(), "src/ts/rpack/rpack_map.bin"),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        arrayBuffer: async () =>
          validMapBuffer.buffer.slice(
            validMapBuffer.byteOffset,
            validMapBuffer.byteOffset + validMapBuffer.byteLength,
          ),
      })),
    );
  });

  afterEach(() => {
    resetRPackForTesting();
    vi.unstubAllGlobals();
  });

  it("initializes and roundtrips data correctly", async () => {
    const original = new Uint8Array([0, 1, 2, 42, 100, 200, 255]);
    const encoded = await encodeRPack(original);
    expect(encoded).toHaveLength(original.length);

    const decoded = await decodeRPack(encoded);
    expect(decoded).toEqual(original);
  });

  it("handles empty buffers gracefully", async () => {
    const empty = new Uint8Array(0);
    const encoded = await encodeRPack(empty);
    expect(encoded).toEqual(new Uint8Array(0));

    const decoded = await decodeRPack(encoded);
    expect(decoded).toEqual(new Uint8Array(0));
  });

  it("deduplicates concurrent initialization requests", async () => {
    const fetchMock = vi.fn(async () => {
      // Simulate network latency
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        arrayBuffer: async () =>
          validMapBuffer.buffer.slice(
            validMapBuffer.byteOffset,
            validMapBuffer.byteOffset + validMapBuffer.byteLength,
          ),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const original = new Uint8Array([10, 20, 30]);
    const [res1, res2] = await Promise.all([
      encodeRPack(original),
      encodeRPack(original),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res1).toEqual(res2);
  });

  it("throws when map data is less than 512 bytes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        arrayBuffer: async () => new ArrayBuffer(256),
      })),
    );

    await expect(initRPack()).rejects.toThrow(/at least 512 bytes/);
  });
});
