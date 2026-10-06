import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import type { Message } from "src/ts/storage/database/schema";
import ChatBodyIllustrationHarness from "./fixtures/ChatBodyIllustrationHarness.svelte";

const { parseMarkdown } = vi.hoisted(() => ({
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
  onBlobUrlsRevoked: () => () => {},
}));
vi.mock("src/ts/mediaSrc", () => ({}));
vi.mock("src/lang", () => ({ language: { illustration: {} } }));

let app: ReturnType<typeof mount>;
let target: HTMLDivElement;

afterEach(async () => {
  if (app) await unmount(app);
  target?.remove();
  parseMarkdown.mockClear();
});

it("keeps the parsed body and slot hosts through progress updates, then renders the arriving image", async () => {
  let message: Message = {
    chatId: "message",
    role: "char",
    data: "Scene {{illustration::slot}}",
    illustrations: [
      {
        id: "slot",
        token: "{{illustration::slot}}",
        status: "queued",
        version: 1,
        sourceHash: "hash",
        executor: "app",
        runId: "run",
      },
    ],
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
    await tick();
    flushSync();
  };
  await settle();
  await vi.waitFor(async () => {
    await settle();
    expect(target.querySelector("[data-risu-illustration] details")).not.toBeNull();
  });
  const host = target.querySelector("[data-risu-illustration]");
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
    data: "Scene {{inlay::image}}",
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
  expect(parseMarkdown).toHaveBeenCalledTimes(calls + 1);
  expect(target.querySelector("[data-risu-illustration-image]")).not.toBeNull();
});
