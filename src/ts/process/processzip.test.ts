import { zipSync } from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

const assetSaveMock = vi.hoisted(() => {
  const state = {
    active: 0,
    maxActive: 0,
  };

  return {
    state,
    saveAsset: vi.fn(
      async (_data: Uint8Array, _customId: string, fileName: string) => {
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);

        await new Promise((resolve) => setTimeout(resolve, 5));

        state.active -= 1;
        return `saved/${fileName}`;
      },
    ),
  };
});

const nodeStorageMock = vi.hoisted(() => {
  const forageStorage = { realStorage: null as any };

  class NodeStorage {
    batches: Map<string, Uint8Array>[] = [];

    async setItems(items: ReadonlyMap<string, Uint8Array>) {
      this.batches.push(new Map(items));
    }
  }

  return { forageStorage, NodeStorage };
});

const hashMock = vi.hoisted(() => ({
  hasher: vi.fn(async (data: Uint8Array) => `hash-${data[0]}`),
}));

vi.mock(
  import("../globalApi.svelte"),
  () =>
    ({
      AppendableBuffer: class {
        private chunks: Uint8Array[] = [];

        get buffer() {
          const length = this.chunks.reduce(
            (total, chunk) => total + chunk.byteLength,
            0,
          );
          const result = new Uint8Array(length);
          let offset = 0;
          for (const chunk of this.chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return result;
        }

        append(data: Uint8Array) {
          this.chunks.push(data);
        }

        clear() {
          this.chunks = [];
        }
      },
      forageStorage: nodeStorageMock.forageStorage,
      saveAsset: assetSaveMock.saveAsset,
    }) as any,
);

vi.mock(
  import("../storage/files/nodeStorage"),
  () =>
    ({
      NodeStorage: nodeStorageMock.NodeStorage,
    }) as any,
);

vi.mock(
  import("../util"),
  () =>
    ({
      asBuffer: (data: Uint8Array | ArrayBuffer) => data,
      Semaphore: class {
        private available: number;
        private waiting: Array<() => void> = [];

        constructor(max: number) {
          this.available = max;
        }

        async acquire() {
          if (this.available > 0) {
            this.available -= 1;
            return;
          }
          await new Promise<void>((resolve) => this.waiting.push(resolve));
        }

        release() {
          const next = this.waiting.shift();
          if (next) {
            next();
          } else {
            this.available += 1;
          }
        }
      },
      sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    }) as any,
);

vi.mock(import("../alert"), () => ({
  alertStore: { set: vi.fn() },
}));

vi.mock(import("../hash"), () => ({
  hasher: hashMock.hasher,
}));

vi.mock(
  import("../characterCards"),
  () =>
    ({
      hubURL: "https://example.test",
    }) as any,
);

import { CharXImporter } from "./processzip";

describe("CharXImporter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assetSaveMock.state.active = 0;
    assetSaveMock.state.maxActive = 0;
    nodeStorageMock.forageStorage.realStorage = null;
  });

  it("saves more than ten assets without exceeding the concurrency limit", async () => {
    const assetNames = Array.from(
      { length: 12 },
      (_, index) => `assets/asset-${index}.${index % 2 === 0 ? "png" : "webp"}`,
    );
    const archive = zipSync({
      "card.json": new TextEncoder().encode('{"name":"test"}'),
      ...Object.fromEntries(
        assetNames.map((name, index) => [name, new Uint8Array([index])]),
      ),
    });
    const importer = new CharXImporter();

    await importer.parse(archive);
    await importer.done();

    expect(assetSaveMock.saveAsset).toHaveBeenCalledTimes(assetNames.length);
    expect(assetSaveMock.state.maxActive).toBe(10);
    expect(assetSaveMock.saveAsset.mock.calls.map((call) => call[2])).toEqual(
      expect.arrayContaining(assetNames),
    );
    expect(importer.assets).toEqual(
      Object.fromEntries(assetNames.map((name) => [name, `saved/${name}`])),
    );
  }, 2_000);

  it("imports Android-style File inputs without relying on File.stream()", async () => {
    const archive = zipSync({
      "card.json": new TextEncoder().encode(
        '{"spec":"chara_card_v3","data":{"name":"Amber"}}',
      ),
      "assets/icon/image/2.png": new Uint8Array([1, 2, 3]),
    });
    // Amber.charx is a JPEG+ZIP polyglot whose first ZIP local header starts
    // after 214,055 bytes of image data. Mirror that layout without checking in
    // the real character card fixture.
    const jpegPrefix = new Uint8Array(214_055);
    jpegPrefix.set([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
    ]);
    const polyglot = new Uint8Array(jpegPrefix.length + archive.length);
    polyglot.set(jpegPrefix);
    polyglot.set(archive, jpegPrefix.length);

    class AndroidContentFile extends File {
      stream(): ReturnType<File["stream"]> {
        throw new Error("File.stream() is unavailable for this content URI");
      }
    }

    const file = new AndroidContentFile([polyglot], "Amber.charx", {
      type: "image/jpeg",
    });
    const importer = new CharXImporter();

    await importer.parse(file);
    await importer.done();

    expect(JSON.parse(importer.cardData ?? "{}")).toMatchObject({
      spec: "chara_card_v3",
      data: { name: "Amber" },
    });
    expect(importer.assets["assets/icon/image/2.png"]).toBe(
      "saved/assets/icon/image/2.png",
    );
  });

  it("streams Node server assets in bounded bulk-write batches", async () => {
    const assetNames = Array.from(
      { length: 130 },
      (_, index) => `assets/asset-${index}.${index % 2 === 0 ? "png" : "webp"}`,
    );
    const archive = zipSync({
      "card.json": new TextEncoder().encode('{"name":"test"}'),
      ...Object.fromEntries(
        assetNames.map((name, index) => [name, new Uint8Array([index])]),
      ),
    });
    const storage = new nodeStorageMock.NodeStorage();
    nodeStorageMock.forageStorage.realStorage = storage;
    const importer = new CharXImporter();

    await importer.parse(archive);
    await importer.done();

    expect(assetSaveMock.saveAsset).not.toHaveBeenCalled();
    expect(storage.batches.map((batch) => batch.size)).toEqual([64, 64, 2]);
    expect(importer.assets).toEqual(
      Object.fromEntries(
        assetNames.map((name, index) => [
          name,
          `assets/hash-${index}.${index % 2 === 0 ? "png" : "webp"}`,
        ]),
      ),
    );
  }, 2_000);
});
