import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import StorageExplorerSettings from "../StorageExplorerSettings.svelte";
import type { BotStorageInfo, ViewTarget } from "./types";

const mocks = vi.hoisted(() => ({
  readImage:
    vi.fn<(key: string, target: ViewTarget) => Promise<Uint8Array | null>>(),
  analyze: vi.fn(),
}));

vi.mock("./utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils")>()),
  readImageFromTarget: mocks.readImage,
  runStorageAnalysis: mocks.analyze,
  getNodeStorage: () => ({
    s3: {
      getStorageSummary: async () => ({
        config: { enabled: false, storageType: "fs" },
      }),
      getAssetDetails: async () => ({ assets: [] }),
    },
    sql: { getBackupStatus: async () => null },
  }),
}));

class ThumbnailObserver {
  static instances: ThumbnailObserver[] = [];
  targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    ThumbnailObserver.instances.push(this);
  }
  observe = vi.fn((node: Element) => this.targets.add(node));
  unobserve = vi.fn((node: Element) => this.targets.delete(node));
  disconnect = vi.fn(() => this.targets.clear());
  emit(node: Element, isIntersecting = true) {
    this.callback(
      [{ target: node, isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function bot(id: string, avatarKey?: string): BotStorageInfo {
  return {
    id,
    name: id,
    avatarKey,
    totalAssets: 1,
    totalSizeBytes: 10,
    assets: [],
    emotionsCount: 0,
    additionalAssetsCount: 0,
    ccAssetsCount: 0,
    audioCount: 0,
    missingAssetsCount: 0,
  };
}

function deferredImage() {
  let resolve!: (data: Uint8Array | null) => void;
  const promise = new Promise<Uint8Array | null>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let app: ReturnType<typeof mount> | undefined;
let container: HTMLDivElement;

async function renderExplorer() {
  container = document.createElement("div");
  document.body.append(container);
  app = mount(StorageExplorerSettings, { target: container });
  await vi.waitFor(() =>
    expect(container.querySelectorAll("h4")).toHaveLength(3),
  );
  await tick();
}

function avatar(name: string): HTMLElement {
  const title = Array.from(container.querySelectorAll("h4")).find(
    (node) => node.textContent?.trim() === name,
  );
  return title!
    .closest("button")!
    .querySelector<HTMLDivElement>("div.relative")!;
}

function observerFor(node: Element) {
  return ThumbnailObserver.instances.find((observer) =>
    observer.targets.has(node),
  )!;
}

beforeEach(() => {
  ThumbnailObserver.instances = [];
  vi.stubGlobal("IntersectionObserver", ThumbnailObserver);
  mocks.readImage.mockReset().mockResolvedValue(new Uint8Array([1]));
  mocks.analyze.mockReset().mockResolvedValue({
    bots: [
      bot("First", "assets/first.png"),
      bot("Second", "assets/second.png"),
      bot("No avatar"),
    ],
    modules: [{ id: "module", iconKey: "assets/module.png" }],
    orphanAssets: [],
    orphanSizeBytes: 0,
    assetUsageMap: new Map(),
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:thumbnail");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Storage Explorer thumbnail loading", () => {
  it("reads only avatars near the viewport and shares one observer for the list", async () => {
    await renderExplorer();
    expect(ThumbnailObserver.instances).toHaveLength(1);
    expect(mocks.readImage).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();

    const first = avatar("First");
    const observer = observerFor(first);
    observer.emit(first, false);
    expect(mocks.readImage).not.toHaveBeenCalled();
    observer.emit(first);
    observer.emit(first);

    expect(mocks.readImage).toHaveBeenCalledExactlyOnceWith(
      "assets/first.png",
      "fs",
    );
    await vi.waitFor(() => expect(first.querySelector("img")).not.toBeNull());
    expect(first.querySelector("img")?.getAttribute("loading")).toBe("lazy");
    expect(first.querySelector("img")?.getAttribute("decoding")).toBe("async");
    expect(avatar("Second").querySelector("img")).toBeNull();
    expect(mocks.readImage).toHaveBeenCalledTimes(1);
  });

  it("ignores queued visibility events for cards removed by filtering", async () => {
    await renderExplorer();
    const second = avatar("Second");
    const observer = observerFor(second);
    const search =
      container.querySelector<HTMLInputElement>('input[type="text"]')!;
    search.value = "First";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    observer.emit(second);
    expect(mocks.readImage).not.toHaveBeenCalled();
    observer.emit(avatar("First"));
    expect(mocks.readImage).toHaveBeenCalledExactlyOnceWith(
      "assets/first.png",
      "fs",
    );
  });

  it("reobserves the same avatar key after changing storage and discards the old response", async () => {
    const oldImage = deferredImage();
    const newImage = deferredImage();
    mocks.readImage.mockImplementation((_key, target) =>
      target === "fs" ? oldImage.promise : newImage.promise,
    );
    await renderExplorer();
    const first = avatar("First");
    observerFor(first).emit(first);

    const select = container.querySelector<HTMLSelectElement>(
      "#storage-target-select",
    )!;
    select.value = "s3";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await tick();
    observerFor(avatar("First")).emit(avatar("First"));
    expect(mocks.readImage.mock.calls).toEqual([
      ["assets/first.png", "fs"],
      ["assets/first.png", "s3"],
    ]);

    oldImage.resolve(new Uint8Array([1]));
    await tick();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    newImage.resolve(new Uint8Array([2]));
    await vi.waitFor(() =>
      expect(avatar("First").querySelector("img")).not.toBeNull(),
    );
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("disconnects observation and discards unfinished image reads when closed", async () => {
    const image = deferredImage();
    mocks.readImage.mockReturnValue(image.promise);
    await renderExplorer();
    const first = avatar("First");
    const second = avatar("Second");
    const observer = observerFor(first);
    observer.emit(first);
    await unmount(app!);
    app = undefined;
    observer.emit(second);
    image.resolve(new Uint8Array([1]));
    await tick();
    expect(mocks.readImage).toHaveBeenCalledTimes(1);
    expect(observer.disconnect).toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("revokes loaded object URLs when closed", async () => {
    await renderExplorer();
    const first = avatar("First");
    observerFor(first).emit(first);
    await vi.waitFor(() => expect(first.querySelector("img")).not.toBeNull());
    await unmount(app!);
    app = undefined;
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:thumbnail");
  });

  it("keeps avatars available when IntersectionObserver is unsupported", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    await renderExplorer();
    expect(mocks.readImage.mock.calls).toEqual([
      ["assets/first.png", "fs"],
      ["assets/second.png", "fs"],
    ]);
    expect(ThumbnailObserver.instances).toHaveLength(0);
  });
});
