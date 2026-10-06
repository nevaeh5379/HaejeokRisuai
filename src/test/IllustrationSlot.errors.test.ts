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
    imageId: undefined as string | undefined,
    imageIds: undefined as string[] | undefined,
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
vi.mock("src/ts/process/files/inlays", () => ({
  getInlayAssetBlob: vi.fn(async () => ({
    data: new Blob(["image"], { type: "image/png" }),
  })),
}));
afterEach(async () => {
  if (app) await unmount(app);
  target?.remove();
  vi.useRealTimers();
  recoverIllustration.mockReset();
  item.imageId = undefined;
  item.imageIds = undefined;
  vi.restoreAllMocks();
});

it("opens the latest image, navigates both ways and releases image URLs", async () => {
  const { getInlayAssetBlob } = await import("src/ts/process/files/inlays");
  vi.mocked(getInlayAssetBlob).mockClear();
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:image-${++sequence}`,
  );
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  item.status = "complete";
  item.error = "";
  item.errorDetails = undefined;
  item.imageId = "latest";
  item.imageIds = ["old", "middle", "latest"];
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
    expect(target.querySelector("img")).not.toBeNull();
  });
  const buttons = target.querySelectorAll<HTMLButtonElement>(
    "[data-risu-illustration-image] button",
  );
  expect(buttons[1].disabled).toBe(true);
  expect(getInlayAssetBlob).toHaveBeenLastCalledWith("latest");
  buttons[0].click();
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(getInlayAssetBlob).toHaveBeenLastCalledWith("middle");
  });
  buttons[0].click();
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(getInlayAssetBlob).toHaveBeenLastCalledWith("old");
  });
  expect(buttons[0].disabled).toBe(true);
  buttons[1].click();
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(getInlayAssetBlob).toHaveBeenLastCalledWith("middle");
  });
  expect(target.textContent).toContain("2 / 3");
  await unmount(app);
  app = undefined;
  expect(revoke).toHaveBeenCalledTimes(sequence);
});

it.each([false, true])(
  "handles legacy single images with hideImages=%s",
  async (hideImages) => {
    const { getInlayAssetBlob } = await import("src/ts/process/files/inlays");
    vi.mocked(getInlayAssetBlob).mockClear();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:legacy");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    item.status = "complete";
    item.error = "";
    item.errorDetails = undefined;
    item.imageId = "legacy";
    target = document.createElement("div");
    document.body.appendChild(target);
    app = mount(IllustrationSlot, {
      target,
      props: {
        hideImages,
        target: {
          characterId: "character",
          chatId: "chat",
          messageId: "message",
          illustrationId: "slot",
        },
      },
    });
    flushSync();
    if (hideImages) {
      expect(target.querySelector("[data-risu-illustration-image]")).toBeNull();
      expect(getInlayAssetBlob).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => {
        flushSync();
        expect(target.querySelector("img")).not.toBeNull();
      });
      expect(getInlayAssetBlob).toHaveBeenCalledWith("legacy");
      expect(
        target.querySelectorAll("[data-risu-illustration-image] button"),
      ).toHaveLength(0);
    }
  },
);

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
