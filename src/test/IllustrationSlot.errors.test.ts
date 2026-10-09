import { afterEach, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import IllustrationSlot from "src/lib/ChatScreens/IllustrationSlot.svelte";
import { item, characterStore } from "./fixtures/IllustrationSlotState.svelte";

const { recoverIllustration, illustrationAction } = vi.hoisted(() => ({
  recoverIllustration: vi.fn(),
  illustrationAction: vi.fn(),
}));
vi.mock("src/ts/process/illustration/illustrationApp", () => ({
  recoverIllustration,
  illustrationAction,
}));
vi.mock("src/ts/stores/domain/settingsStore.svelte", () => ({
  settingsStore: { state: { useChatIllustrations: true } },
}));
vi.mock(
  "src/ts/stores/domain/characterStore.svelte",
  async () => import("./fixtures/IllustrationSlotState.svelte"),
);
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
  illustrationAction.mockReset();
  item.imageId = undefined;
  item.imageIds = undefined;
  item.imageTags = undefined;
  item.batch = undefined;
  item.tags = undefined;
  characterStore.characters[0].chats[0].message[0].illustrations = [item];
  vi.restoreAllMocks();
});

it("displays ComfyUI node validation details with the HTTP error", () => {
  item.status = "failed";
  item.error = "";
  item.errorDetails = {
    stage: "image",
    code: "http",
    status: 400,
    providerDiagnostic:
      "ComfyUI: prompt_outputs_failed_validation\nNode 18: required_input_missing (loras)",
  };
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
  expect(target.querySelector('[role="alert"]')?.textContent).toContain(
    "HTTP 400",
  );
  expect(target.querySelector('[role="alert"]')?.textContent).toContain(
    "Node 18: required_input_missing (loras)",
  );
});

it("updates the displayed image as server snapshots save each image in a batch", async () => {
  const { getInlayAssetBlob } = await import("src/ts/process/files/inlays");
  vi.mocked(getInlayAssetBlob).mockClear();
  vi.mocked(getInlayAssetBlob).mockResolvedValue({
    data: new Blob(["image"], { type: "image/png" }),
    name: "image",
    ext: "png",
    type: "image",
    width: 640,
    height: 960,
  });
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:saved-${++sequence}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  item.status = "generating";
  item.error = "";
  item.errorDetails = undefined;
  item.batch = { version: 1, count: 4, entries: [{}, {}, {}, {}] };
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
  const message = characterStore.characters[0].chats[0].message[0];
  for (let index = 1; index <= 4; index++) {
    message.illustrations[0] = {
      ...item,
      tags: "next image tags",
      imageId: `saved-${index}`,
      imageIds: Array.from(
        { length: index },
        (_, offset) => `saved-${offset + 1}`,
      ),
      batch: {
        version: 1,
        count: 4,
        entries: Array.from({ length: 4 }, (_, offset) =>
          offset < index
            ? { imageId: `saved-${offset + 1}`, tags: `tags-${offset + 1}` }
            : {},
        ),
      },
    };
    flushSync();
    await vi.waitFor(() => {
      flushSync();
      expect(target.querySelector("img")?.getAttribute("src")).toBe(
        `blob:saved-${index}`,
      );
      expect(target.querySelector("img")?.getAttribute("loading")).toBe(
        "eager",
      );
      expect(target.querySelector("img")?.getAttribute("width")).toBe("640");
      expect(target.querySelector("img")?.getAttribute("height")).toBe("960");
      expect(getInlayAssetBlob).toHaveBeenLastCalledWith(`saved-${index}`);
      expect(target.querySelector("details span")?.textContent).toBe(
        `tags-${index}`,
      );
    });
  }
  const details = target.querySelector("details")!;
  details.open = true;
  const buttons = target.querySelectorAll<HTMLButtonElement>(
    "[data-risu-illustration-image] > button",
  );
  for (let index = 3; index >= 1; index--) {
    buttons[0].click();
    flushSync();
    expect(details.querySelector("span")?.textContent).toBe(`tags-${index}`);
    expect(details.open).toBe(true);
  }
  buttons[1].click();
  flushSync();
  expect(details.querySelector("span")?.textContent).toBe("tags-2");
});

it("updates retained image tags and regenerates the selected image without substituting missing history", async () => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  item.status = "complete";
  item.error = "";
  item.errorDetails = undefined;
  item.imageIds = ["unknown", "old", "new"];
  item.imageId = "new";
  item.tags = "new tags";
  item.imageTags = { old: "old tags", new: "new tags" };
  item.batch = {
    version: 2,
    count: 1,
    entries: [{ imageId: "new", tags: "new tags" }],
  };
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
  expect(target.querySelector("details span")?.textContent).toBe("new tags");
  const details = target.querySelector("details")!;
  details.open = true;
  const buttons = target.querySelectorAll<HTMLButtonElement>(
    "[data-risu-illustration-image] > button",
  );
  buttons[0].click();
  flushSync();
  expect(target.querySelector("details span")?.textContent).toBe("old tags");
  const regenerate = Array.from(
    target.querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "같은 태그로 재생성")!;
  expect(regenerate.disabled).toBe(false);
  regenerate.click();
  await vi.waitFor(() =>
    expect(illustrationAction).toHaveBeenCalledWith(
      {
        characterId: "character",
        chatId: "chat",
        messageId: "message",
        illustrationId: "slot",
      },
      "regenerate",
      "old",
    ),
  );
  await vi.waitFor(() => {
    flushSync();
    expect(regenerate.disabled).toBe(false);
  });
  buttons[0].click();
  flushSync();
  expect(target.querySelector("details")).toBe(details);
  expect(details.hidden).toBe(true);
  expect(details.querySelector("span")?.textContent).toBe("");
  expect(regenerate.disabled).toBe(true);
  buttons[1].click();
  flushSync();
  expect(target.querySelector("details span")?.textContent).toBe("old tags");
  expect(details.hidden).toBe(false);
  expect(details.open).toBe(true);
});

it("shows partial batch progress and loads only the selected image while generation is active", async () => {
  const { getInlayAssetBlob } = await import("src/ts/process/files/inlays");
  vi.mocked(getInlayAssetBlob).mockClear();
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:first");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  item.status = "generating";
  item.error = "";
  item.errorDetails = undefined;
  item.imageId = "first";
  item.imageIds = ["first"];
  item.batch = {
    version: 1,
    count: 4,
    entries: [{ imageId: "first" }, {}, {}, {}],
  };
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
  await vi.waitFor(() => {
    flushSync();
    expect(target.querySelector("img")).not.toBeNull();
    expect(target.textContent).toContain("저장된 삽화: 1 / 4");
  });
  expect(getInlayAssetBlob).toHaveBeenCalledExactlyOnceWith("first");
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
    "[data-risu-illustration-image] > button",
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
    item.tags = "legacy tags";
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
    expect(target.querySelector("details span")?.textContent).toBe(
      "legacy tags",
    );
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
        target.querySelectorAll("[data-risu-illustration-image] > button"),
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
  await vi.advanceTimersByTimeAsync(1000);
  flushSync();
  expect(target.querySelector('[role="alert"]')).toBeNull();
});

it("retries an initially unavailable image without waiting for another image ID or a page reload", async () => {
  vi.useFakeTimers();
  const { getInlayAssetBlob } = await import("src/ts/process/files/inlays");
  vi.mocked(getInlayAssetBlob).mockClear();
  vi.mocked(getInlayAssetBlob).mockResolvedValueOnce(null);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:available");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  item.status = "complete";
  item.imageId = "new";
  item.error = "";
  item.errorDetails = undefined;
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
  await vi.dynamicImportSettled();
  flushSync();
  expect(getInlayAssetBlob).toHaveBeenCalledTimes(1);
  expect(target.querySelector("img")).toBeNull();
  await vi.advanceTimersByTimeAsync(250);
  flushSync();
  expect(getInlayAssetBlob).toHaveBeenCalledTimes(2);
  expect(target.querySelector("img")?.getAttribute("src")).toBe(
    "blob:available",
  );
});

it("does not overlap polling requests when the Node server responds slowly", async () => {
  vi.useFakeTimers();
  item.status = "generating";
  item.error = "";
  item.errorDetails = undefined;
  let release!: () => void;
  recoverIllustration.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
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
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(3000);
  expect(recoverIllustration).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(recoverIllustration).toHaveBeenCalledTimes(2);
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
