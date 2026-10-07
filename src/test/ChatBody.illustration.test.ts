import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { Message } from "src/ts/storage/database/schema";
import ChatBodyIllustrationHarness from "./fixtures/ChatBodyIllustrationHarness.svelte";

const { parseMarkdown, onRevoke } = vi.hoisted(() => ({
  onRevoke: { callback: undefined as (() => void) | undefined },
  parseMarkdown: vi.fn(async (text: string) => text),
}));

vi.mock("src/ts/parser/parser.svelte", () => ({
  ParseMarkdown: parseMarkdown,
  trimMarkdown: (text: string) => text,
  addMetadataToElement: (text: string) => text,
}));
vi.mock("src/ts/stores/domain/characterStore.svelte", () => ({
  characterStore: {
    characters: [
      {
        chaId: "character",
        chats: [
          {
            id: "chat",
            message: [
              {
                chatId: "message",
                illustrations: [
                  { id: "slot", status: "complete", tags: "original tags" },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
}));
vi.mock("src/ts/stores/domain", () => ({ settingsStore: { state: {} } }));
vi.mock("src/ts/translator/translator", () => ({}));
vi.mock("src/ts/chatAssetResolver", () => ({}));
vi.mock("src/ts/util", () => ({}));
vi.mock("src/ts/alert", () => ({}));
vi.mock("src/ts/globalApi.svelte", () => ({
  onBlobUrlsRevoked: (callback: () => void) => {
    onRevoke.callback = callback;
    return () => {
      onRevoke.callback = undefined;
    };
  },
  isLiveObjectUrl: () => false,
  untrackObjectUrl: vi.fn(),
}));
vi.mock("src/ts/mediaSrc", () => ({}));
vi.mock("src/lang", () => ({
  language: {
    illustration: {
      previousImage: "Previous",
      nextImage: "Next",
      errorStages: { save: "Save" },
      errorReasons: { unknown: "Unknown" },
    },
  },
}));
vi.mock("src/ts/process/illustration/illustrationApp", () => ({
  recoverIllustration: vi.fn(),
  illustrationAction: vi.fn(),
}));
vi.mock("src/ts/process/files/inlays", () => ({
  getInlayAssetBlob: vi.fn(async () => ({ data: new Blob(["image"]) })),
}));

let app: ReturnType<typeof mount>;
let target: HTMLDivElement;

afterEach(async () => {
  if (app) await unmount(app);
  target?.remove();
  parseMarkdown.mockClear();
  vi.restoreAllMocks();
});

it("never reparses or replaces chat DOM during illustration progress, rerolls, navigation or image errors", async () => {
  let imageSequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:illustration-${++imageSequence}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  let message: Message = {
    chatId: "message",
    role: "char",
    data: '<p id="scene">Scene</p>{{illustration::slot}}',
    illustrations: [
      {
        id: "slot",
        token: "{{illustration::slot}}",
        status: "queued",
        tags: "original tags",
        version: 1,
        sourceHash: "hash",
        executor: "app",
        runId: "run",
      },
    ],
  };
  const prepared = message;
  message = {
    ...message,
    data: message.data.replace("{{illustration::slot}}", "<Illustration>"),
    illustrations: [],
  };
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ChatBodyIllustrationHarness, {
    target,
    props: { initialMessage: message },
  });
  const settle = async () => {
    flushSync();
    await tick();
    await vi.dynamicImportSettled();
    await tick();
    flushSync();
  };
  await settle();
  const unpreparedScene = target.querySelector("#scene");
  const unpreparedHost = target.querySelector("[data-risu-illustration]");
  const preparationCalls = parseMarkdown.mock.calls.length;
  app.setMessage(prepared);
  message = prepared;
  await vi.waitFor(async () => {
    await settle();
    expect(
      target.querySelector("[data-risu-illustration] details"),
    ).not.toBeNull();
  });
  const scene = target.querySelector("#scene");
  const host = target.querySelector("[data-risu-illustration]");
  expect(scene).toBe(unpreparedScene);
  expect(host).toBe(unpreparedHost);
  expect(parseMarkdown).toHaveBeenCalledTimes(preparationCalls);
  expect(host).not.toBeNull();
  const details = host!.querySelector("details")!;
  expect(details).not.toBeNull();
  details.open = true;
  const calls = parseMarkdown.mock.calls.length;

  for (const status of ["tagging", "generating", "failed"] as const) {
    message = {
      ...message,
      illustrations: [{ ...message.illustrations![0], status, tags: "sunset" }],
    };
    (app as { setMessage(message: Message): void }).setMessage(message);
    await settle();
    expect(parseMarkdown).toHaveBeenCalledTimes(calls);
    expect(target.querySelector("[data-risu-illustration]")).toBe(host);
    expect(host!.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
  }

  message = {
    ...message,
    data: '<p id="scene">Scene</p>{{inlay::image}}',
    illustrations: [
      {
        ...message.illustrations![0],
        status: "complete",
        token: "{{inlay::image}}",
        imageId: "image",
      },
    ],
  };
  (app as { setMessage(message: Message): void }).setMessage(message);
  await settle();
  await vi.waitFor(async () => {
    await settle();
    expect(target.querySelector("img")).not.toBeNull();
  });
  const assertStable = () => {
    expect(parseMarkdown).toHaveBeenCalledTimes(calls);
    expect(target.querySelector("#scene")).toBe(scene);
    expect(target.querySelector("[data-risu-illustration]")).toBe(host);
    expect(host!.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
  };
  assertStable();

  app.setImageSettings(25, false);
  await settle();
  expect(
    (host!.querySelector("[data-risu-illustration-image]") as HTMLElement).style
      .width,
  ).toBe("25%");
  assertStable();
  app.setImageSettings(25, true);
  await settle();
  expect(host!.querySelector("img")).toBeNull();
  assertStable();
  app.setImageSettings(100, false);
  await settle();
  assertStable();
  for (const status of [
    "queued",
    "tagging",
    "generating",
    "failed",
    "interrupted",
  ] as const) {
    message = {
      ...message,
      illustrations: [{ ...message.illustrations![0], status }],
    };
    app.setMessage(message);
    await settle();
    assertStable();
  }
  message = {
    ...message,
    data: '<p id="scene">Scene</p>{{inlay::longer-rerolled-image-id}}',
    illustrations: [
      {
        ...message.illustrations![0],
        status: "complete",
        token: "{{inlay::longer-rerolled-image-id}}",
        imageId: "longer-rerolled-image-id",
        imageIds: ["image", "longer-rerolled-image-id"],
      },
    ],
  };
  app.setMessage(message);
  await vi.waitFor(async () => {
    await settle();
    expect(
      host!.querySelector("[data-risu-illustration-image] button"),
    ).not.toBeNull();
  });
  assertStable();
  const previous = host!.querySelector<HTMLButtonElement>(
    '[aria-label="Previous"]',
  )!;
  const image = host!.querySelector("img")!;
  const imageButton = image.parentElement;
  const previousUrl = image.getAttribute("src");
  Object.defineProperties(image, {
    naturalWidth: { value: 640, configurable: true },
    naturalHeight: { value: 960, configurable: true },
  });
  image.dispatchEvent(new Event("load"));
  const { getInlayAssetBlob } = await import("src/ts/process/files/inlays");
  let finishRead!: (
    asset: Awaited<ReturnType<typeof getInlayAssetBlob>>,
  ) => void;
  vi.mocked(getInlayAssetBlob).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
      }) as ReturnType<typeof getInlayAssetBlob>,
  );
  previous.click();
  await settle();
  expect(host!.querySelector("img")).toBe(image);
  expect(image.getAttribute("src")).toBe(previousUrl);
  expect(image.getAttribute("width")).toBe("640");
  expect(image.getAttribute("height")).toBe("960");
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(previousUrl);
  finishRead({
    data: new Blob(["previous image"]),
    name: "previous",
    ext: "png",
    type: "image",
  });
  await settle();
  expect(host!.querySelector("img")).toBe(image);
  expect(image.parentElement).toBe(imageButton);
  expect(image.getAttribute("src")).not.toBe(previousUrl);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(previousUrl);
  assertStable();
  const next = host!.querySelector<HTMLButtonElement>('[aria-label="Next"]')!;
  next.click();
  await settle();
  expect(host!.querySelector("img")).toBe(image);
  assertStable();
  await vi.waitFor(async () => {
    await settle();
    expect(host!.querySelector("img")).not.toBeNull();
  });
  host!.querySelector("img")!.dispatchEvent(new Event("error"));
  onRevoke.callback?.();
  await settle();
  assertStable();

  // Real edits still invalidate the displayed text.
  message = { ...message, data: message.data.replace("Scene", "Edited scene") };
  app.setMessage(message);
  await settle();
  expect(parseMarkdown).toHaveBeenCalledTimes(calls + 1);
  expect(target.querySelector("#scene")?.textContent).toBe("Edited scene");
});

it("prepares multiple slots independently without replacing neighboring text or remounting existing controls", async () => {
  const { prepareIllustrations } =
    await import("@risuai/protocol/dist/illustration.mjs");
  const message: Message = {
    chatId: "message",
    role: "char",
    data: '<p id="before">Before</p><Illustration><p id="between">Between</p><Illustration>',
  };
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ChatBodyIllustrationHarness, {
    target,
    props: { initialMessage: message },
  });
  const settle = async () => {
    flushSync();
    await tick();
    await vi.dynamicImportSettled();
    await tick();
    flushSync();
  };
  await settle();
  const before = target.querySelector("#before");
  const between = target.querySelector("#between");
  const hosts = [...target.querySelectorAll("[data-risu-illustration]")];
  const calls = parseMarkdown.mock.calls.length;
  const prepared = structuredClone(message);
  const items = prepareIllustrations(prepared, undefined, "app", "run");
  items.forEach((item) => {
    item.tags = "tags";
    item.status = "complete";
  });
  // Binding follows narrative positions rather than metadata array order.
  prepared.illustrations!.reverse();
  app.setMessage(prepared);
  await settle();
  expect(parseMarkdown).toHaveBeenCalledTimes(calls);
  expect([...target.querySelectorAll("[data-risu-illustration]")]).toEqual(
    hosts,
  );
  expect(hosts).toHaveLength(2);
  const details = hosts.map((host) => host.querySelector("details")!);
  details.forEach((detail) => {
    detail.open = true;
  });
  const next = {
    ...prepared,
    illustrations: prepared.illustrations!.map((item) => ({
      ...item,
      tags: "updated tags",
    })),
  };
  app.setMessage(next);
  await settle();
  expect(parseMarkdown).toHaveBeenCalledTimes(calls);
  expect(target.querySelector("#before")).toBe(before);
  expect(target.querySelector("#between")).toBe(between);
  hosts.forEach((host, index) => {
    expect(host.querySelector("details")).toBe(details[index]);
    expect(details[index].open).toBe(true);
    expect(details[index].textContent).toContain("updated tags");
  });
});
