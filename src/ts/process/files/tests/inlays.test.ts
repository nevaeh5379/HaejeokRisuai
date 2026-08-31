import fc from "fast-check";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { InlayAsset } from "../inlays";
import {
  decodeInlayAssetBackup,
  encodeInlayAssetBackup,
  getInlayAsset,
  getInlayAssetBlob,
  listInlayAssets,
  postInlayAsset,
  removeInlayAsset,
  setInlayAsset,
  writeInlayImage,
} from "../inlays";

const { migrateLocalInlaysToServer, resetInlayRemoteWriteState } = await import(
  "../inlays"
);
const { resetRemoteAvailability, getInlayServerKey } = await import(
  "../inlayRemote"
);

//#region module mocks

// happy-dom canvas getContext returns null
const fakeCtx = {
  drawImage: vi.fn(),
};
let canvasContextAvailable = true;
let canvasBlobAvailable = true;
const origCreateElement = document.createElement.bind(document);
vi.spyOn(document, "createElement").mockImplementation(
  (tag: string, options?: any) => {
    const el = origCreateElement(tag, options);
    if (tag === "canvas") {
      (el as HTMLCanvasElement).getContext = (() =>
        canvasContextAvailable ? fakeCtx : null) as any;
      (el as HTMLCanvasElement).toBlob = ((cb: BlobCallback) => {
        cb(
          canvasBlobAvailable
            ? new Blob(["fake-png"], { type: "image/png" })
            : null,
        );
      }) as any;
    }
    return el;
  },
);

const store = new Map<string, unknown>();

vi.mock("localforage", () => ({
  default: {
    createInstance: () => ({
      getItem: vi.fn(async (key: string) => store.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      iterate: vi.fn(async (cb: (value: unknown, key: string) => void) => {
        for (const [key, value] of store) {
          cb(value, key);
        }
      }),
    }),
  },
}));

vi.mock("uuid", () => ({
  v4: vi.fn(() => "test-uuid-1234"),
}));

vi.mock(import("src/ts/media"), () => ({
  getImageType: vi.fn(),
}));

vi.mock(import("src/ts/model/modellist"), () => ({
  getModelInfo: vi.fn(),
}));

const remoteMocks = vi.hoisted(() => {
  return {
    remoteStore: new Map<string, Uint8Array>(),
    remoteFailureCount: { _v: 0, get value() { return this._v; }, set value(v: number) { this._v = v; } },
    nodeServerMode: { _v: false, get value() { return this._v; }, set value(v: boolean) { this._v = v; } },
    forageStorage: {
      Init: async () => {},
      realStorage: null as unknown,
      isAccount: false,
    },
  };
});

const mockNodeStorageInstance = {
  setItem: vi.fn(async (key: string, value: Uint8Array) => {
    if (remoteMocks.remoteFailureCount.value > 0) {
      remoteMocks.remoteFailureCount.value--;
      throw new Error("server unavailable");
    }
    remoteMocks.remoteStore.set(key, value);
  }),
  getItem: vi.fn(async (key: string) => {
    return remoteMocks.remoteStore.get(key) ?? null;
  }),
  removeItem: vi.fn(async (key: string | string[]) => {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) remoteMocks.remoteStore.delete(k);
  }),
  keys: vi.fn(async (prefix: string) => {
    return [...remoteMocks.remoteStore.keys()].filter((k) =>
      k.startsWith(prefix),
    );
  }),
};

vi.mock("src/ts/platform", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/ts/platform")>();
  return {
    ...actual,
    get isNodeServer() {
      return remoteMocks.nodeServerMode.value;
    },
  };
});

vi.mock("src/ts/globalApi.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/ts/globalApi.svelte")>();
  return {
    ...actual,
    forageStorage: remoteMocks.forageStorage,
  };
});

vi.mock("src/ts/storage/files/nodeStorage", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("src/ts/storage/files/nodeStorage")
  >();
  return {
    ...actual,
    NodeStorage: class MockNodeStorage {
      setItem = mockNodeStorageInstance.setItem;
      getItem = mockNodeStorageInstance.getItem;
      removeItem = mockNodeStorageInstance.removeItem;
      keys = mockNodeStorageInstance.keys;
    },
  };
});

async function enableNodeServerMode() {
  remoteMocks.nodeServerMode.value = true;
  remoteMocks.remoteFailureCount.value = 0;
  const { NodeStorage } = await import("src/ts/storage/files/nodeStorage");
  remoteMocks.forageStorage.realStorage = new NodeStorage();
  resetRemoteAvailability();
}

function disableNodeServerMode() {
  remoteMocks.nodeServerMode.value = false;
  remoteMocks.forageStorage.realStorage = null;
  remoteMocks.remoteFailureCount.value = 0;
  resetRemoteAvailability();
}

//#endregion

const supportedAudioExts = ["wav", "mp3", "ogg", "flac"] as const;
const supportedVideoExts = ["webm", "mp4", "mkv"] as const;
const supportedImageExts = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "avif",
] as const;
const allSupportedExts = [
  ...supportedAudioExts,
  ...supportedVideoExts,
  ...supportedImageExts,
];

function makeImage(w: number, h: number): HTMLImageElement {
  const img = new Image();
  Object.defineProperty(img, "naturalWidth", { get: () => w });
  Object.defineProperty(img, "naturalHeight", { get: () => h });
  Object.defineProperty(img, "width", { get: () => w });
  Object.defineProperty(img, "height", { get: () => h });
  Object.defineProperty(img, "onload", {
    set(fn: () => void) {
      fn?.();
    },
    get() {
      return null;
    },
  });
  return img;
}

const remoteStore = remoteMocks.remoteStore;
const remoteFailureCount = remoteMocks.remoteFailureCount;

beforeEach(() => {
  vi.clearAllMocks();
  store.clear();
  remoteStore.clear();
  canvasContextAvailable = true;
  canvasBlobAvailable = true;
  disableNodeServerMode();
  resetInlayRemoteWriteState();
});

describe("inlay backup payload", () => {
  test("round trips binary image metadata without base64 expansion", async () => {
    const asset: InlayAsset = {
      data: new Blob(["image-bytes"], { type: "image/png" }),
      ext: "png",
      height: 720,
      width: 1280,
      name: "scene.png",
      type: "image",
    };

    const encoded = await encodeInlayAssetBackup(asset);
    const decoded = decodeInlayAssetBackup(encoded);

    expect(decoded).toMatchObject({
      ext: "png",
      height: 720,
      width: 1280,
      name: "scene.png",
      type: "image",
    });
    expect(decoded.data).toBeInstanceOf(Blob);
    expect((decoded.data as Blob).type).toBe("image/png");
    expect(await (decoded.data as Blob).text()).toBe("image-bytes");
  });

  test("round trips text signature inlays", async () => {
    const asset: InlayAsset = {
      data: JSON.stringify({ signature: "hello" }),
      ext: "json",
      name: "signature",
      type: "signature",
    };
    expect(decodeInlayAssetBackup(await encodeInlayAssetBackup(asset))).toEqual(asset);
  });
});

describe("setInlayAsset", () => {
  test("stores an asset in the storage", async () => {
    const asset: InlayAsset = {
      data: new Blob(["hello"], { type: "text/plain" }),
      ext: "png",
      height: 100,
      width: 100,
      name: "test.png",
      type: "image",
    };

    await setInlayAsset("asset-1", asset);

    expect(store.get("asset-1")).toBe(asset);
  });

  test("overwrites an existing asset with the same id", async () => {
    const first: InlayAsset = {
      data: new Blob(["a"]),
      ext: "png",
      height: 10,
      name: "first.png",
      type: "image",
      width: 10,
    };
    const second: InlayAsset = {
      data: new Blob(["b"]),
      ext: "png",
      height: 20,
      name: "second.png",
      type: "image",
      width: 20,
    };

    await setInlayAsset("id-1", first);
    await setInlayAsset("id-1", second);

    expect(store.get("id-1") as InlayAsset).toMatchObject({
      height: 20,
      name: "second.png",
      type: "image",
      width: 20,
    });
  });
});

describe("getInlayAsset", () => {
  test("returns null for a non-existent id", async () => {
    const result = await getInlayAsset("does-not-exist");
    expect(result).toBeNull();
  });

  test("returns asset with base64 data URI when stored as Blob", async () => {
    const blob = new Blob(["test-data"], { type: "text/plain" });
    const asset: InlayAsset = {
      data: blob,
      ext: "png",
      height: 50,
      width: 50,
      name: "blob-asset.png",
      type: "image",
    };
    store.set("blob-id", asset);

    const result = await getInlayAsset("blob-id");

    expect(result!.data).toMatch(/^data:/);
    expect(result!.name).toBe("blob-asset.png");
  });

  test("returns asset with string data as-is when stored as string", async () => {
    const b64 = "data:image/png;base64,aGVsbG8=";
    const asset: InlayAsset = {
      data: b64,
      ext: "png",
      height: 50,
      width: 50,
      name: "string-asset.png",
      type: "image",
    };
    store.set("str-id", asset);

    const result = await getInlayAsset("str-id");
    expect(result!.data).toBe(b64);
  });
});

describe("getInlayAssetBlob", () => {
  test("returns null for a non-existent id", async () => {
    const result = await getInlayAssetBlob("does-not-exist");
    expect(result).toBeNull();
  });

  test("returns Blob data when stored as Blob", async () => {
    const blob = new Blob(["binary-data"], { type: "image/png" });
    const asset: InlayAsset = {
      data: blob,
      ext: "png",
      height: 64,
      width: 64,
      name: "blob.png",
      type: "image",
    };
    store.set("blob-id", asset);

    const result = await getInlayAssetBlob("blob-id");
    expect(result!.data).toBeInstanceOf(Blob);
  });

  test("migrates string data to Blob and updates storage", async () => {
    const b64 = "data:image/png;base64,aGVsbG8=";
    const asset: InlayAsset = {
      data: b64,
      ext: "png",
      height: 32,
      width: 32,
      name: "legacy.png",
      type: "image",
    };
    store.set("legacy-id", asset);

    const result = await getInlayAssetBlob("legacy-id");
    expect(result!.data).toBeInstanceOf(Blob);

    const updated = store.get("legacy-id") as InlayAsset;
    expect(updated.data).toBeInstanceOf(Blob);
  });

  test("preserves signature inlays stored as string without attempting data URI migration", async () => {
    const signatureJson = JSON.stringify({
      signatures: [{ type: "function", content: "test()" }],
      sourceFormat: "openai",
      source: "gpt-4",
    });
    const asset: InlayAsset = {
      data: signatureJson,
      ext: "json",
      name: "sig-1",
      type: "signature",
    };
    store.set("sig-id", asset);

    const result = await getInlayAssetBlob("sig-id");
    expect(result).not.toBeNull();
    expect(result!.data).toBe(signatureJson);
    expect(result!.type).toBe("signature");

    const unchanged = store.get("sig-id") as InlayAsset;
    expect(unchanged.data).toBe(signatureJson);
  });

  test("rejects invalid legacy media strings without overwriting storage", async () => {
    const asset: InlayAsset = {
      data: "not-a-data-uri",
      ext: "png",
      name: "broken.png",
      type: "image",
    };
    store.set("broken-id", asset);

    await expect(getInlayAssetBlob("broken-id")).rejects.toThrow(
      "Invalid inlay data URI: broken-id",
    );
    expect(store.get("broken-id")).toBe(asset);
  });

  test("rejects malformed data URIs instead of creating a fallback Blob", async () => {
    const asset: InlayAsset = {
      data: "data:image/png;base64",
      ext: "png",
      name: "malformed.png",
      type: "image",
    };
    store.set("malformed-id", asset);

    await expect(getInlayAssetBlob("malformed-id")).rejects.toThrow(
      "Invalid base64 data URI",
    );
    expect(store.get("malformed-id")).toBe(asset);
  });
});

describe("listInlayAssets", () => {
  test("returns empty array when no assets exist", async () => {
    const result = await listInlayAssets();
    expect(result).toEqual([]);
  });

  test("returns all stored assets as [id, asset] tuples", async () => {
    const asset1: InlayAsset = {
      data: new Blob(["a"]),
      ext: "png",
      height: 10,
      width: 10,
      name: "a.png",
      type: "image",
    };
    const asset2: InlayAsset = {
      data: new Blob(["b"]),
      ext: "mp3",
      height: 0,
      width: 0,
      name: "b.mp3",
      type: "audio",
    };
    store.set("id-a", asset1);
    store.set("id-b", asset2);

    const result = await listInlayAssets();
    expect(result).toMatchObject([
      ["id-a", { name: "a.png" }],
      ["id-b", { name: "b.mp3" }],
    ]);
  });
});

describe("removeInlayAsset", () => {
  test("does not throw when removing a non-existent id", async () => {
    await expect(removeInlayAsset("nope")).resolves.not.toThrow();
  });
});

describe("postInlayAsset", () => {
  test("stores audio asset and returns id", async () => {
    const data = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    const result = await postInlayAsset({
      name: "clip.mp3",
      data,
    });
    expect(result).toBe("test-uuid-1234");

    const stored = store.get("test-uuid-1234") as InlayAsset;
    expect(stored).toMatchObject({
      data: expect.any(Blob),
      ext: "mp3",
      name: "clip.mp3",
      type: "audio",
    });
  });

  test("stores video asset and returns id", async () => {
    const data = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);
    const result = await postInlayAsset({
      name: "video.webm",
      data,
    });
    expect(result).toBe("test-uuid-1234");

    const stored = store.get("test-uuid-1234") as InlayAsset;
    expect(stored).toMatchObject({
      data: expect.any(Blob),
      ext: "webm",
      name: "video.webm",
      type: "video",
    });
  });

  test("returns null for any unsupported extension", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .string({ minLength: 1, maxLength: 10 })
          .filter((ext) => !allSupportedExts.includes(ext as any)),
        async (ext) => {
          store.clear();
          const result = await postInlayAsset({
            name: `file.${ext}`,
            data: new Uint8Array([0x00]),
          });
          expect(result).toBeNull();
        },
      ),
    );
  });

  test("routes audio extensions to audio type", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...supportedAudioExts), async (ext) => {
        store.clear();
        const result = await postInlayAsset({
          name: `sound.${ext}`,
          data: new Uint8Array([0x00]),
        });
        expect(result).not.toBeNull();
        const stored = store.get(result!) as InlayAsset;
        expect(stored.type).toBe("audio");
        expect(stored.ext).toBe(ext);
      }),
    );
  });

  test("routes video extensions to video type", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...supportedVideoExts), async (ext) => {
        store.clear();
        const result = await postInlayAsset({
          name: `clip.${ext}`,
          data: new Uint8Array([0x00]),
        });
        expect(result).not.toBeNull();
        const stored = store.get(result!) as InlayAsset;
        expect(stored.type).toBe("video");
        expect(stored.ext).toBe(ext);
      }),
    );
  });
});

describe("writeInlayImage", () => {
  test("stores image asset with correct metadata and returns id", async () => {
    const imgObj = makeImage(200, 100);

    const result = await writeInlayImage(imgObj, {
      name: "photo.jpg",
      ext: "jpg",
      id: "custom-id",
    });

    expect(result).toBe("custom-id");

    const stored = store.get("custom-id") as InlayAsset;
    expect(stored).toMatchObject({
      data: expect.any(Blob),
      ext: "png",
      height: 100,
      name: "photo.jpg",
      type: "image",
      width: 200,
    });
  });

  test("generates uuid when no id is provided", async () => {
    const imgObj = makeImage(50, 50);

    const result = await writeInlayImage(imgObj);
    expect(result).toBe("test-uuid-1234");

    const stored = store.get("test-uuid-1234") as InlayAsset;
    expect(stored.name).toBe("test-uuid-1234");
  });

  test("output pixels never exceed 1024 * 1024", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        async (w, h) => {
          store.clear();
          const img = makeImage(w, h);
          await writeInlayImage(img, { id: "prop-img" });
          const stored = store.get("prop-img") as InlayAsset;

          expect(stored.width * stored.height).toBeLessThanOrEqual(1024 * 1024);
          expect(stored.width).toBeGreaterThan(0);
          expect(stored.height).toBeGreaterThan(0);
        },
      ),
    );
  });

  test("preserves aspect ratio when downscaling", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1025, max: 10000 }),
        fc.integer({ min: 1025, max: 10000 }),
        async (w, h) => {
          store.clear();
          const img = makeImage(w, h);
          await writeInlayImage(img, { id: "ratio-img" });
          const stored = store.get("ratio-img") as InlayAsset;

          const originalRatio = w / h;
          const storedRatio = stored.width / stored.height;
          expect(
            Math.abs(originalRatio - storedRatio) / originalRatio,
          ).toBeLessThan(0.01);
        },
      ),
    );
  });

  test("does not resize images within pixel budget", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1024 }),
        fc.integer({ min: 1, max: 1024 }),
        async (w, h) => {
          store.clear();
          const img = makeImage(w, h);
          await writeInlayImage(img, { id: "small-img" });

          const stored = store.get("small-img") as InlayAsset;
          expect(stored).toMatchObject({
            height: h,
            width: w,
          });
        },
      ),
    );
  });

  test("handles pre-completed image without waiting for onload", async () => {
    store.clear();
    const img = new Image();
    Object.defineProperty(img, "naturalWidth", { value: 120 });
    Object.defineProperty(img, "naturalHeight", { value: 80 });
    Object.defineProperty(img, "complete", { value: true });

    const id = await writeInlayImage(img, { id: "completed-img" });
    expect(id).toBe("completed-img");

    const stored = store.get("completed-img") as InlayAsset;
    expect(stored).toMatchObject({
      width: 120,
      height: 80,
      type: "image",
    });
  });

  test("rejects an already-completed failed image instead of hanging", async () => {
    const img = new Image();
    Object.defineProperty(img, "complete", { value: true });
    Object.defineProperty(img, "naturalWidth", { value: 0 });
    Object.defineProperty(img, "naturalHeight", { value: 0 });
    Object.defineProperty(img, "width", { value: 120 });
    Object.defineProperty(img, "height", { value: 80 });

    await expect(writeInlayImage(img)).rejects.toThrow(
      "Failed to load image for inlay",
    );
  });

  test("rejects when image loading fails", async () => {
    const img = new Image();
    Object.defineProperty(img, "complete", { value: false });
    Object.defineProperty(img, "onerror", {
      set(fn: (err: any) => void) {
        fn?.(new Error("Image decode failed"));
      },
      get() {
        return null;
      },
    });

    await expect(writeInlayImage(img)).rejects.toThrow(
      "Failed to load image for inlay",
    );
  });

  test("rejects when a 2D canvas context is unavailable", async () => {
    canvasContextAvailable = false;
    await expect(writeInlayImage(makeImage(120, 80))).rejects.toThrow(
      "2D canvas context is unavailable",
    );
  });

  test("rejects when canvas image encoding returns null", async () => {
    canvasBlobAvailable = false;
    await expect(writeInlayImage(makeImage(120, 80))).rejects.toThrow(
      "Failed to encode inlay image",
    );
  });
});

describe("set -> get round-trip", () => {
  test("preserves metadata through setInlayAsset -> getInlayAsset", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 30 }),
        fc.string({ minLength: 1, maxLength: 5 }),
        fc.nat({ max: 5000 }),
        fc.nat({ max: 5000 }),
        async (id, name, ext, width, height) => {
          store.clear();
          const blob = new Blob(["data"], { type: "application/octet-stream" });
          const asset: InlayAsset = {
            data: blob,
            ext,
            height,
            width,
            name,
            type: "image",
          };

          await setInlayAsset(id, asset);

          const result = await getInlayAsset(id);
          expect(result).toMatchObject({
            data: expect.any(String),
            ext,
            height,
            width,
            name,
            type: "image",
          });
        },
      ),
    );
  });
});

describe("set -> remove -> get", () => {
  test("asset is always null after removal", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 20 }),
        async (id) => {
          store.clear();
          const asset: InlayAsset = {
            data: new Blob(["x"]),
            ext: "png",
            height: 1,
            width: 1,
            name: "tmp.png",
            type: "image",
          };

          await setInlayAsset(id, asset);
          expect(await getInlayAsset(id)).not.toBeNull();

          await removeInlayAsset(id);
          expect(await getInlayAsset(id)).toBeNull();
        },
      ),
    );
  });
});

describe("remote inlay storage (node server)", () => {
  function makeAsset(name: string): InlayAsset {
    return {
      data: new Blob(["remote-bytes"], { type: "image/png" }),
      ext: "png",
      height: 8,
      width: 8,
      name,
      type: "image",
    };
  }

  test("mirrors writes to the server in node mode", async () => {
    await enableNodeServerMode();
    await setInlayAsset("mirror-id", makeAsset("mirror.png"));

    expect(remoteStore.has(getInlayServerKey("mirror-id"))).toBe(true);
    const stored = await getInlayAsset("mirror-id");
    expect(stored).not.toBeNull();
    expect(stored!.name).toBe("mirror.png");
  });

  test("does not touch the server outside node mode", async () => {
    await setInlayAsset("local-id", makeAsset("local.png"));
    expect(remoteStore.size).toBe(0);
  });

  test("keeps the local cache when the server upload fails", async () => {
    await enableNodeServerMode();
    remoteFailureCount.value = 1;

    await setInlayAsset("fail-id", makeAsset("fail.png"));
    expect(remoteStore.size).toBe(0);

    const cached = await getInlayAsset("fail-id");
    expect(cached).not.toBeNull();
    expect(cached!.name).toBe("fail.png");
  });

  test("fetches an asset from the server on local cache miss", async () => {
    await enableNodeServerMode();
    const asset = makeAsset("remote-only.png");
    remoteStore.set(
      getInlayServerKey("remote-id"),
      await encodeInlayAssetBackup(asset),
    );

    const result = await getInlayAsset("remote-id");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("remote-only.png");

    // Second read is served from cache; server still holds the payload.
    expect(await getInlayAsset("remote-id")).toMatchObject({
      name: "remote-only.png",
    });
  });

  test("listInlayAssets merges local and server entries in node mode", async () => {
    await enableNodeServerMode();
    await setInlayAsset("local-entry", makeAsset("local-entry.png"));

    remoteStore.set(
      getInlayServerKey("remote-entry"),
      await encodeInlayAssetBackup(makeAsset("remote-entry.png")),
    );

    const ids = (await listInlayAssets()).map(([id]) => id).sort();
    expect(ids).toEqual(["local-entry", "remote-entry"]);
  });

  test("removeInlayAsset deletes both cache and server copy", async () => {
    await enableNodeServerMode();
    await setInlayAsset("remove-id", makeAsset("remove.png"));
    expect(remoteStore.has(getInlayServerKey("remove-id"))).toBe(true);

    await removeInlayAsset("remove-id");
    expect(remoteStore.has(getInlayServerKey("remove-id"))).toBe(false);
    expect(await getInlayAsset("remove-id")).toBeNull();
  });

  test("migrateLocalInlaysToServer uploads only missing entries and is idempotent", async () => {
    await enableNodeServerMode();
    await setInlayAsset("mig-a", makeAsset("a.png"));
    remoteStore.delete(getInlayServerKey("mig-a"));

    const first = await migrateLocalInlaysToServer();
    expect(first.migrated).toBe(1);
    expect(first.failed).toBe(0);
    expect(remoteStore.has(getInlayServerKey("mig-a"))).toBe(true);

    // Second run: nothing left to upload.
    const second = await migrateLocalInlaysToServer();
    expect(second.migrated).toBe(0);
  });

  test("migrateLocalInlaysToServer reports failures without losing local data", async () => {
    await enableNodeServerMode();
    await setInlayAsset("mig-fail", makeAsset("f.png"));
    remoteStore.delete(getInlayServerKey("mig-fail"));
    remoteFailureCount.value = 1;

    const result = await migrateLocalInlaysToServer();
    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);

    // The asset is still readable from the local cache.
    expect(await getInlayAsset("mig-fail")).not.toBeNull();
  });
});
