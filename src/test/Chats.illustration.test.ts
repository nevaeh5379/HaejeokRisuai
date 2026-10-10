import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { character, Message } from "src/ts/storage/database/schema";
import { prepareIllustrations } from "@risuai/protocol/src/illustration.ts";
import ChatsIllustrationHarness from "./fixtures/ChatsIllustrationHarness.svelte";

const { characterStore, settingsStore, parseMarkdown, cbs } = vi.hoisted(
  () => ({
    characterStore: { characters: [] as character[] },
    settingsStore: { state: { theme: "mobilechat", zoomsize: 100 } },
    parseMarkdown: vi.fn(async (text: string) => text),
    cbs: vi.fn((text: string) => text),
  }),
);
vi.mock("src/ts/stores/domain", () => ({ characterStore, settingsStore }));
vi.mock("src/ts/stores/domain/characterStore.svelte", () => ({
  characterStore,
}));
vi.mock("src/ts/stores.svelte", async () => {
  const { writable } = await import("svelte/store");
  return {
    selectedCharID: writable(0),
    ReloadChatPointer: writable({}),
    ReloadGUIPointer: writable(0),
    HideIconStore: writable(false),
    CurrentTriggerIdStore: writable(""),
    popupStore: writable(null),
    createSimpleCharacter: () => null,
  };
});
vi.mock("src/ts/gui/colorscheme", async () => {
  const { writable } = await import("svelte/store");
  return { ColorSchemeTypeStore: writable("dark") };
});
vi.mock("src/ts/sync/multiuserState", async () => {
  const { writable } = await import("svelte/store");
  return { ConnectionOpenStore: writable(false) };
});
vi.mock("src/ts/characters", () => ({ getCharImage: () => "" }));
vi.mock("src/ts/process/scripts", () => ({ risuChatParser: cbs }));
vi.mock("src/ts/parser/parser.svelte", () => ({
  ParseMarkdown: parseMarkdown,
  trimMarkdown: (text: string) => text,
  addMetadataToElement: (text: string) => text,
}));
vi.mock("src/ts/globalApi.svelte", () => ({
  onBlobUrlsRevoked: () => () => {},
  chatFoldedStateMessageIndex: { index: -1 },
}));
vi.mock("src/ts/util", () => ({ capitalize: (text: string) => text }));
vi.mock("src/ts/alert", () => ({}));
vi.mock("src/ts/gui/longtouch", () => ({}));
vi.mock("src/ts/model/modellist", () => ({
  getModelInfo: () => ({ shortName: "test" }),
}));
vi.mock("src/ts/process/coldstorage.svelte", () => ({}));
vi.mock("src/ts/logexporter/index", () => ({}));
vi.mock("src/ts/storage/sql/sqlStorageFactory", () => ({}));
vi.mock("src/ts/translator/translator", () => ({}));
vi.mock("src/ts/chatAssetResolver", () => ({}));
vi.mock("src/ts/mediaSrc", () => ({}));
vi.mock("src/lib/UI/GUI/TextAreaResizable.svelte", () => ({
  default: () => {},
}));
vi.mock("src/lib/UI/PopupButton.svelte", () => ({ default: () => {} }));
vi.mock("src/lib/ChatScreens/PartialEditController.svelte", () => ({
  default: () => {},
}));
vi.mock("src/lang", () => ({
  language: { illustration: { previousImage: "Previous", nextImage: "Next" } },
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
  vi.restoreAllMocks();
  parseMarkdown.mockClear();
  cbs.mockClear();
});

const settle = async () => {
  // Chats mounts Chat, which mounts ChatBody and then illustration controls.
  for (let depth = 0; depth < 3; depth++) {
    flushSync();
    await tick();
    await vi.dynamicImportSettled();
    await tick();
  }
  flushSync();
};

it("preserves real Chats → Chat → ChatBody DOM across slot preparation, SQL hydration and rerolls", async () => {
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:image-${++sequence}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const previous: Message = {
    chatId: "previous",
    role: "user",
    data: '<p id="previous-text">Previous message</p>',
  };
  const answer: Message = {
    chatId: "answer",
    role: "char",
    data: '<p id="answer-text">Scene</p><Illustration>',
    generationInfo: { model: "test", generationId: "generation" },
  };
  let current = {
    chaId: "character",
    name: "Bot",
    type: "character",
    chats: [{ id: "chat", message: [previous, answer] }],
  } as unknown as character;
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(ChatsIllustrationHarness, {
    target,
    props: { initialCharacter: current },
  });
  await settle();
  const rows = [...target.querySelectorAll(".risu-chat")];
  const previousText = target.querySelector("#previous-text");
  const answerText = target.querySelector("#answer-text");
  const host = target.querySelector("[data-risu-illustration]");
  expect(rows).toHaveLength(2);
  expect(answerText).not.toBeNull();
  const parseCalls = parseMarkdown.mock.calls.length;
  const cbsCalls = cbs.mock.calls.length;
  const assertStable = () => {
    target
      .querySelectorAll(".risu-chat")
      .forEach((row, index) => expect(row).toBe(rows[index]));
    expect(target.querySelector("#previous-text")).toBe(previousText);
    expect(target.querySelector("#answer-text")).toBe(answerText);
    expect(target.querySelector("[data-risu-illustration]")).toBe(host);
    expect(parseMarkdown).toHaveBeenCalledTimes(parseCalls);
    expect(cbs).toHaveBeenCalledTimes(cbsCalls);
  };
  const hydrate = async (change: (message: Message) => void) => {
    current = structuredClone(current);
    change(current.chats[0].message[1]);
    app.hydrate(current);
    await settle();
    assertStable();
  };
  await hydrate((message) => {
    prepareIllustrations(message, undefined, "app", "run");
    message.illustrations![0].tags = "tags";
  });
  const details = host!.querySelector("details")!;
  details.open = true;
  for (const status of [
    "tagging",
    "generating",
    "failed",
    "interrupted",
  ] as const) {
    await hydrate((message) => {
      message.illustrations![0].status = status;
    });
    expect(host!.querySelector("details")).toBe(details);
    expect(details.open).toBe(true);
  }
  for (const id of ["first", "longer-reroll-id"]) {
    await hydrate((message) => {
      const item = message.illustrations![0];
      message.data = message.data.replace(item.token, `{{inlay::${id}}}`);
      item.token = `{{inlay::${id}}}`;
      item.imageId = id;
      item.status = "complete";
      item.imageIds = [...(item.imageIds ?? []), id];
    });
    expect(host!.querySelector("img")).not.toBeNull();
    expect(host!.querySelector("details")).toBe(details);
  }
  host!.querySelector<HTMLButtonElement>('[aria-label="Previous"]')!.click();
  await settle();
  assertStable();
  expect(host!.textContent).toContain("1 / 2");
  host!.querySelector<HTMLButtonElement>('[aria-label="Next"]')!.click();
  await settle();
  assertStable();
  expect(host!.textContent).toContain("2 / 2");

  // A real narrative edit must still reach the displayed chat.
  current = structuredClone(current);
  current.chats[0].message[1].data = current.chats[0].message[1].data.replace(
    "Scene",
    "Edited scene",
  );
  app.hydrate(current);
  await settle();
  expect(target.querySelector("#answer-text")?.textContent).toBe(
    "Edited scene",
  );
  expect(target.querySelector("#previous-text")).toBe(previousText);
});
