import { afterEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "fflate";
import {
  decodeRisuSave,
  encodeRisuSaveLegacy,
  encodeRisuSaveLegacyAsync,
  RisuSaveDecoder,
} from "./risuSave";

const { cacheGet, remoteGet } = vi.hoisted(() => ({
  cacheGet: vi.fn(),
  remoteGet: vi.fn(),
}));
vi.mock("localforage", () => ({
  default: { createInstance: () => ({ getItem: cacheGet }) },
}));
vi.mock("../../globalApi.svelte", () => ({
  forageStorage: { getItem: remoteGet },
}));

function blockSave(
  blocks: {
    type: number;
    name: string;
    value: unknown;
    compressed?: boolean;
    bytes?: Uint8Array;
  }[],
) {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode("RISUSAVE\0")];
  for (const block of blocks) {
    const name = encoder.encode(block.name);
    let content = block.bytes ?? encoder.encode(JSON.stringify(block.value));
    if (block.compressed && !block.bytes) content = gzipSync(content);
    const header = new Uint8Array(7 + name.length);
    header.set([block.type, block.compressed ? 1 : 0, name.length]);
    header.set(name, 3);
    new DataView(header.buffer).setUint32(
      3 + name.length,
      content.length,
      true,
    );
    chunks.push(header, content);
  }
  const data = new NoCopyUint8Array(
    new ArrayBuffer(chunks.reduce((sum, chunk) => sum + chunk.length, 0)),
  );
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

class NoCopyUint8Array extends Uint8Array<ArrayBuffer> {
  override slice(start?: number, end?: number): Uint8Array<ArrayBuffer> {
    throw new Error("RisuSave decoder copied the full input buffer");
  }
}

describe("RisuSave decode memory behavior", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    cacheGet.mockReset();
    remoteGet.mockReset();
  });

  it("parses each block before decoding the next payload", async () => {
    const events: string[] = [];
    const originalDecode = TextDecoder.prototype.decode;
    const originalParse = JSON.parse;
    vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
      ...args
    ) {
      const text = originalDecode.apply(this, args);
      if (text.startsWith('{"chaId"'))
        events.push(`decode:${originalParse(text).chaId}`);
      return text;
    });
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const result = originalParse(text, reviver);
      if (result?.chaId) events.push(`parse:${result.chaId}`);
      return result;
    });
    const data = blockSave([
      { type: 2, name: "a", value: { chaId: "a", text: "a".repeat(100_000) } },
      { type: 2, name: "b", value: { chaId: "b", text: "b".repeat(100_000) } },
    ]);
    const db = await new RisuSaveDecoder().decode(data);
    expect(db.characters).toHaveLength(2);
    expect(events.indexOf("parse:a")).toBeLessThan(events.indexOf("decode:b"));
  });

  it("preserves local, cached, and remote block ordering with lazy reads", async () => {
    cacheGet.mockImplementation(async (key) => ({
      type: 2,
      name: key,
      data: JSON.stringify({ chaId: "cached" }),
    }));
    remoteGet.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ chaId: "remote" })),
    );
    const data = blockSave([
      {
        type: 1,
        name: "root",
        value: { __directory: ["local", "cached", "cached"] },
      },
      { type: 6, name: "pointer", value: { type: 2, name: "remote", v: 1 } },
      { type: 2, name: "local", value: { chaId: "local" }, compressed: true },
    ]);
    const db = await new RisuSaveDecoder().decode(data);
    expect(db.characters.map((char) => char.chaId)).toEqual([
      "local",
      "cached",
      "remote",
    ]);
    expect(cacheGet).toHaveBeenCalledExactlyOnceWith("risuSaveBlock_cached");
    expect(remoteGet).toHaveBeenCalledExactlyOnceWith(
      "remotes/remote.local.bin",
    );
  });

  it("skips invalid optional JSON and releases state before decoder reuse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const decoder = new RisuSaveDecoder();
    const db = await decoder.decode(
      blockSave([
        {
          type: 2,
          name: "bad",
          value: null,
          bytes: new TextEncoder().encode("invalid"),
        },
        { type: 2, name: "good", value: { chaId: "good" } },
      ]),
    );
    expect(db.characters.map((char) => char.chaId)).toEqual(["good"]);
    await expect(
      decoder.decode(
        blockSave([
          {
            type: 1,
            name: "root",
            value: null,
            bytes: new TextEncoder().encode("invalid"),
          },
        ]),
      ),
    ).rejects.toThrow("Failed to decode root block");
    expect(
      (
        await decoder.decode(
          blockSave([{ type: 2, name: "fresh", value: { chaId: "fresh" } }]),
        )
      ).characters.map((char) => char.chaId),
    ).toEqual(["fresh"]);
  });

  it("recovers a corrupt compressed local block from the directory cache", async () => {
    cacheGet.mockResolvedValue({
      type: 2,
      name: "bad",
      data: JSON.stringify({ chaId: "recovered" }),
    });
    const db = await new RisuSaveDecoder().decode(
      blockSave([
        { type: 1, name: "root", value: { __directory: ["bad"] } },
        {
          type: 2,
          name: "bad",
          value: null,
          compressed: true,
          bytes: new Uint8Array([0, 1, 2]),
        },
      ]),
    );
    expect(db.characters.map((char) => char.chaId)).toEqual(["recovered"]);
  });

  it("decodes headerless legacy gzip JSON without Buffer copies", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const source = { characters: [{ chaId: "legacy", name: "한글" }] };
    expect(
      await decodeRisuSave(
        gzipSync(new TextEncoder().encode(JSON.stringify(source))),
      ),
    ).toEqual(source);
  });

  it("decodes legacy raw saves without copying the full input buffer", async () => {
    const source = encodeRisuSaveLegacy({
      personas: [{ name: "A", icon: "", personaPrompt: "" }],
      modules: [{ id: "module-1", name: "Module" }],
      botPresets: [{ name: "Preset", mainPrompt: "hello" }],
      plugins: [
        {
          name: "backup-plugin",
          version: "3.0",
          enabled: true,
          script: "console.log('backup')",
        },
      ],
      pluginCustomStorage: { "backup-plugin": { restored: true } },
    });
    const guarded = new NoCopyUint8Array(new ArrayBuffer(source.byteLength));
    guarded.set(source);

    const decoded = await decodeRisuSave(guarded);

    expect(decoded.personas).toHaveLength(1);
    expect(decoded.modules).toHaveLength(1);
    expect(decoded.botPresets).toHaveLength(1);
    expect(decoded.plugins?.[0]?.name).toBe("backup-plugin");
    expect(decoded.pluginCustomStorage).toEqual({
      "backup-plugin": { restored: true },
    });
  });

  it("preserves branch-scoped Lua state through compressed backup encoding", async () => {
    const largeState = JSON.stringify({ scenes: ["x".repeat(128 * 1024)] });
    const source = {
      characters: [
        {
          chaId: "char-1",
          type: "character",
          name: "Bot",
          chats: [
            {
              id: "chat-1",
              name: "Chat",
              note: "",
              localLore: [],
              message: [{ role: "user", data: "hello", chatId: "m1" }],
              scriptstate: { "$lb-xnai-stack": "live" },
              branchState: {
                baseMessageIndex: 0,
                activeBranchId: "child",
                branches: [
                  {
                    id: "root",
                    branchMessageIndex: 0,
                    reason: "root",
                    createdAt: 1,
                    messages: [],
                    scriptstate: { "$lb-xnai-stack": largeState },
                    GLGlobalVariables: { lightboard: "root" },
                    useLocallySetGlobalVariables: true,
                  },
                  {
                    id: "child",
                    parentBranchId: "root",
                    branchMessageIndex: 0,
                    reason: "reroll",
                    createdAt: 2,
                    messages: [],
                    scriptstate: null,
                    GLGlobalVariables: null,
                    useLocallySetGlobalVariables: false,
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const encoded = await encodeRisuSaveLegacyAsync(source, "compression");
    const decoded = await decodeRisuSave(encoded);

    expect(decoded.characters[0].chats[0].branchState).toEqual(
      source.characters[0].chats[0].branchState,
    );
    expect(decoded.characters[0].chats[0].scriptstate).toEqual({
      "$lb-xnai-stack": "live",
    });
  });
});
