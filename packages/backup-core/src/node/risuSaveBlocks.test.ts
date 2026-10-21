import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeLegacyBackupDatabase } from "./legacyFormat.ts";

export function upstreamBlockSave(
  blocks: Array<{
    type: number;
    name: string;
    value: unknown;
    compressed?: boolean;
  }>,
): Uint8Array {
  const chunks: Buffer[] = [Buffer.from("RISUSAVE\0")];
  for (const { type, name, value, compressed } of blocks) {
    const nameBytes = Buffer.from(name);
    const json = Buffer.from(JSON.stringify(value));
    const bytes = compressed ? gzipSync(json) : json;
    const header = Buffer.alloc(7 + nameBytes.length);
    header.set([type, compressed ? 1 : 0, nameBytes.length]);
    header.set(nameBytes, 3);
    header.writeUInt32LE(bytes.length, 3 + nameBytes.length);
    chunks.push(header, bytes);
  }
  return Buffer.concat(chunks);
}

describe("upstream v2026.10.210 block backups", () => {
  it("decodes self-contained blocks and preserves SaveKV namespaces", () => {
    const save = upstreamBlockSave([
      { type: 1, name: "root", value: { language: "ko", __directory: [] } },
      {
        type: 2,
        name: "char",
        value: { chaId: "char", onboarding: { enabled: true } },
        compressed: true,
      },
      { type: 4, name: "presets", value: [{ name: "preset" }] },
      { type: 11, name: "pluginStorage", value: { _coldpluginIndex: "index" } },
      {
        type: 12,
        name: "kv:example",
        value: { version: 1, entries: [{ k: "key", v: false }] },
        compressed: true,
      },
    ]);
    expect(decodeLegacyBackupDatabase(save)).toMatchObject({
      language: "ko",
      characters: [{ chaId: "char", onboarding: { enabled: true } }],
      botPresets: [{ name: "preset" }],
      pluginCustomStorage: { _coldpluginIndex: "index" },
      upstreamSaveKV: {
        example: { version: 1, entries: [{ k: "key", v: false }] },
      },
    });
  });
  it("rejects missing remote blocks, truncated payloads and excessive decompression", () => {
    expect(() =>
      decodeLegacyBackupDatabase(
        upstreamBlockSave([
          { type: 6, name: "remote", value: { name: "missing" } },
        ]),
      ),
    ).toThrow("remote blocks");
    const save = upstreamBlockSave([
      {
        type: 1,
        name: "root",
        value: { data: "x".repeat(500) },
        compressed: true,
      },
    ]);
    expect(() =>
      decodeLegacyBackupDatabase(save.subarray(0, save.length - 1)),
    ).toThrow("Truncated");
    expect(() =>
      decodeLegacyBackupDatabase(save, { maxOutputBytes: 100 }),
    ).toThrow();
  });
});
