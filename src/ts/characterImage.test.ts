import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class NodeStorage {
    getItems = vi.fn(
      async (_keys: string[]): Promise<Map<string, Uint8Array>> => {
        throw new Error("bulk unavailable");
      },
    );
    getDirectUrl = vi.fn(async () => "/api/read");
  }
  const storage = new NodeStorage();
  return {
    NodeStorage,
    storage,
    forageStorage: { realStorage: storage },
    getFileSrc: vi.fn(async () => "/api/read"),
    settingsState: { hideAllImages: false, lowSpecMode: false },
  };
});

vi.mock(
  import("./storage/nodeStorage"),
  () =>
    ({
      NodeStorage: mocks.NodeStorage,
    }) as any,
);

vi.mock(
  import("./globalApi.svelte"),
  () =>
    ({
      forageStorage: mocks.forageStorage,
      getFileSrc: mocks.getFileSrc,
    }) as any,
);

vi.mock(
  import("./stores/domain/settingsStore.svelte"),
  () =>
    ({
      settingsStore: { state: mocks.settingsState },
    }) as any,
);

vi.mock(import("./media/mimeType"), () => ({
  getMimeType: () => "image/png",
}));

import {
  fullImageBlobCache,
  getAssetsBatch,
  getCharImagesBatch,
  pinCharacterImageCache,
  preloadCharacterImage,
  releaseCharacterImageCache,
  unpinCharacterImageCache,
} from "./characterImage";

describe("getAssetsBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fullImageBlobCache.clear();
    mocks.forageStorage.realStorage = mocks.storage;
    mocks.settingsState.hideAllImages = false;
  });

  it("resolves full-size asset previews without the bounded character blob cache", async () => {
    const locations = Array.from(
      { length: 24 },
      (_, index) => `assets/gallery-${index}.png`,
    );
    const directSource = "https://example.com/direct.png";

    const result = await getAssetsBatch([...locations, directSource], {
      size: "full",
    });

    expect(mocks.storage.getItems).not.toHaveBeenCalled();
    expect(mocks.getFileSrc).toHaveBeenCalledTimes(locations.length);
    expect(fullImageBlobCache.size).toBe(0);
    expect(result.get(locations[0])).toBe("/api/read");
    expect(result.get(directSource)).toBe(directSource);
  });
});

describe("getCharImagesBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fullImageBlobCache.clear();
    mocks.forageStorage.realStorage = mocks.storage;
    mocks.settingsState.lowSpecMode = false;
  });

  it("never falls back to one direct request per local image", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const locations = Array.from(
      { length: 50 },
      (_, index) => `assets/image-${index}.png`,
    );

    const result = await getCharImagesBatch(locations, { size: "display" });

    expect(mocks.storage.getItems).toHaveBeenCalledTimes(2);
    expect(
      mocks.storage.getItems.mock.calls.map((call) => call[0].length),
    ).toEqual([48, 2]);
    expect(mocks.storage.getDirectUrl).not.toHaveBeenCalled();
    expect(mocks.getFileSrc).not.toHaveBeenCalled();
    expect([...result.values()]).toEqual(Array(50).fill("/none.webp"));
    consoleError.mockRestore();
  });

  it("uses thumbnail dimensions and WebP blobs for thumb batches", async () => {
    mocks.storage.getItems.mockResolvedValueOnce(
      new Map([["assets/image.png", new Uint8Array([1, 2, 3])]]),
    );
    const createObjectURL = vi.fn(() => "blob:thumb");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });

    const result = await getCharImagesBatch(["assets/image.png"], {
      size: "thumb",
    });

    expect(mocks.storage.getItems).toHaveBeenCalledWith(
      ["assets/image.png"],
      undefined,
      expect.objectContaining({ size: "thumb", width: 128, height: 128 }),
    );
    expect(createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/webp" }),
    );
    expect(result.get("assets/image.png")).toBe("blob:thumb");
    vi.unstubAllGlobals();
  });

  it("keeps web character thumbnails out of persistent Service Worker cache", async () => {
    mocks.forageStorage.realStorage = {} as any;
    mocks.getFileSrc.mockResolvedValueOnce("blob:web-thumb");

    const result = await getCharImagesBatch(["assets/web-character.png"], {
      size: "thumb",
    });

    expect(mocks.getFileSrc).toHaveBeenCalledWith("assets/web-character.png", {
      thumbnail: true,
      transient: true,
    });
    expect(result.get("assets/web-character.png")).toBe("blob:web-thumb");
  });

  it("bounds full-resolution character blobs while browsing many bots", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL });
    mocks.settingsState.lowSpecMode = true;

    for (let index = 0; index < 7; index++) {
      fullImageBlobCache.set(`assets/full-${index}.png`, `blob:full-${index}`);
    }

    expect(fullImageBlobCache.size).toBe(4);
    expect(fullImageBlobCache.has("assets/full-0.png")).toBe(false);
    expect(fullImageBlobCache.has("assets/full-6.png")).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:full-0");
    vi.unstubAllGlobals();
  });

  it("does not revoke pinned full-resolution blobs that are still rendered", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL });
    mocks.settingsState.lowSpecMode = true;

    const keys = Array.from({ length: 5 }, (_, index) => `full_assets/card-${index}.png`);
    for (const key of keys) pinCharacterImageCache(key);
    for (const [index, key] of keys.entries()) {
      fullImageBlobCache.set(key, `blob:pinned-${index}`);
    }

    expect(fullImageBlobCache.size).toBe(5);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    unpinCharacterImageCache(keys[0]);

    expect(fullImageBlobCache.size).toBe(4);
    expect(fullImageBlobCache.has(keys[0])).toBe(false);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pinned-0");
    vi.unstubAllGlobals();
  });

  it("releases only matching cached blob URLs", () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(), revokeObjectURL });
    fullImageBlobCache.set("thumb_a", "blob:thumb-a");
    fullImageBlobCache.set("display_b", "blob:display-b");

    releaseCharacterImageCache("thumb_");

    expect(fullImageBlobCache.has("thumb_a")).toBe(false);
    expect(fullImageBlobCache.get("display_b")).toBe("blob:display-b");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:thumb-a");
    vi.unstubAllGlobals();
  });
});

describe("preloadCharacterImage", () => {
  it("starts one reusable browser image request for concurrent calls", async () => {
    const requestedSources: string[] = [];
    let imageCount = 0;
    class MockImage {
      decoding = "";
      fetchPriority = "";
      complete = false;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      constructor() {
        imageCount += 1;
      }

      set src(value: string) {
        requestedSources.push(value);
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", MockImage);
    mocks.getFileSrc.mockResolvedValueOnce("/api/read?avatar=1");

    const first = preloadCharacterImage("assets/chat-avatar.png");
    const second = preloadCharacterImage("assets/chat-avatar.png");

    expect(first).toBe(second);
    await first;
    expect(mocks.getFileSrc).toHaveBeenCalledWith("assets/chat-avatar.png", {
      transient: true,
    });
    expect(requestedSources).toEqual(["/api/read?avatar=1"]);
    expect(imageCount).toBe(1);
    vi.unstubAllGlobals();
  });

  it("preloads a bounded thumbnail when low-spec mode is enabled", async () => {
    class MockImage {
      decoding = "";
      fetchPriority = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", MockImage);
    mocks.getFileSrc.mockResolvedValueOnce("/api/read?avatar=thumb");
    mocks.settingsState.lowSpecMode = true;

    await preloadCharacterImage("assets/mobile-chat-avatar.png");

    expect(mocks.getFileSrc).toHaveBeenCalledWith(
      "assets/mobile-chat-avatar.png",
      { thumbnail: true, transient: true },
    );
    vi.unstubAllGlobals();
  });
});
