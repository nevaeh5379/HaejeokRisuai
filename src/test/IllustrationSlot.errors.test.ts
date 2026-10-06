import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { IllustrationErrorDetails } from "@risuai/protocol/dist/illustration.mjs";
import IllustrationSlot from "src/lib/ChatScreens/IllustrationSlot.svelte";

const { item } = vi.hoisted(() => ({
  item: {
    id: "slot",
    status: "failed",
    error: "fallback",
    errorDetails: undefined as IllustrationErrorDetails | undefined,
  },
}));
const { recoverIllustration } = vi.hoisted(() => ({
  recoverIllustration: vi.fn(),
}));
vi.mock("src/ts/process/illustration/illustrationApp", () => ({
  recoverIllustration,
}));
vi.mock("src/ts/stores/domain/characterStore.svelte", () => ({
  characterStore: {
    characters: [
      {
        chaId: "character",
        chats: [
          {
            id: "chat",
            message: [{ chatId: "message", illustrations: [item] }],
          },
        ],
      },
    ],
  },
}));
vi.mock("src/lang", async () => {
  const { languageKorean } = await import("src/lang/ko");
  return { language: languageKorean };
});

let app: ReturnType<typeof mount>;
let target: HTMLDivElement;
afterEach(async () => {
  if (app) await unmount(app);
  target?.remove();
  vi.useRealTimers();
  recoverIllustration.mockReset();
});

it("shows a temporary connection error when status polling fails, and clears it after reconnection", async () => {
  vi.useFakeTimers();
  item.status = "generating";
  item.error = "";
  item.errorDetails = undefined;
  recoverIllustration
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue(undefined);
  target = document.createElement("div");
  document.body.appendChild(target);
  app = mount(IllustrationSlot, {
    target,
    props: {
      target: {
        characterId: "character",
        chatId: "chat",
        messageId: "message",
        illustrationId: "slot",
      },
    },
  });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain(
      "삽화 상태 확인",
    );
  });
  expect(target.querySelector('[role="alert"]')?.textContent).toContain(
    "네트워크",
  );
  expect(item.status).toBe("generating");
  await vi.advanceTimersByTimeAsync(5000);
  flushSync();
  expect(target.querySelector('[role="alert"]')).toBeNull();
});

it.each([
  [
    { stage: "tags", code: "auth", status: 401 },
    "그림 태그 작성",
    "API 키",
    "HTTP 401",
  ],
  [{ stage: "image", code: "connection" }, "이미지 생성", "네트워크", ""],
  [{ stage: "save", code: "unknown" }, "이미지 저장", "남은 저장 공간", ""],
] as const)(
  "shows a localized failure stage and actionable cause for %s",
  (details, stage, advice, status) => {
    item.errorDetails = details;
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(IllustrationSlot, {
      target,
      props: {
        target: {
          characterId: "character",
          chatId: "chat",
          messageId: "message",
          illustrationId: "slot",
        },
      },
    });
    flushSync();
    const alert = target.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(stage);
    expect(alert?.textContent).toContain(advice);
    expect(alert?.textContent).toContain(status);
    expect(alert?.textContent).not.toContain("fallback");
  },
);
