import { describe, expect, it, vi } from "vitest";
import {
  buildIllustrationPrompt,
  describeIllustrationError,
  IllustrationRequestError,
  summarizeIllustrationError,
  canonicalIllustrationText,
  cleanIllustrationTags,
  findIllustrationMarkers,
  fitIllustrationPrompt,
  illustrationSourceHash,
  prepareIllustrations,
  resolveIllustrationSettings,
  validIllustration,
  IllustrationQueue,
  type IllustrationMessage,
  type IllustrationTarget,
} from "@risuai/protocol/dist/illustration.mjs";
import {
  canUpdateIllustration,
  createIllustrationRunner,
  type IllustrationRecord,
} from "@risuai/protocol/dist/illustrationRunner.mjs";

function answer(data = "A garden.<Illustration>A storm.<Illustration>") {
  const message: IllustrationMessage = { role: "char", data, chatId: "answer" };
  prepareIllustrations(message, "branch", "app", "run");
  return message;
}

describe("illustration positions and scene context", () => {
  it("defaults to sequential tags and supports inherited or overridden parallel mode", () => {
    expect(resolveIllustrationSettings().tagRequestMode).toBe("sequential");
    expect(
      resolveIllustrationSettings({ tagRequestMode: "parallel" })
        .tagRequestMode,
    ).toBe("parallel");
    expect(
      resolveIllustrationSettings(
        { tagRequestMode: "parallel" },
        { tagRequestMode: "sequential" },
      ).tagRequestMode,
    ).toBe("sequential");
    expect(
      resolveIllustrationSettings({ tagRequestMode: "invalid" as "parallel" })
        .tagRequestMode,
    ).toBe("sequential");
  });
  it("inherits image count and clamps invalid or oversized imported batches", () => {
    expect(
      resolveIllustrationSettings({ generationCount: 4 }).generationCount,
    ).toBe(4);
    expect(
      resolveIllustrationSettings(
        { generationCount: 4 },
        { generationCount: 2 },
      ).generationCount,
    ).toBe(2);
    for (const [value, expected] of [
      [0, 1],
      [-2, 1],
      [4.9, 4],
      [99, 8],
      [NaN, 1],
      [Infinity, 1],
    ]) {
      expect(
        resolveIllustrationSettings({ generationCount: value }).generationCount,
      ).toBe(expected);
    }
  });
  it("does nothing without a marker and recognizes all markers after split streaming/continuation text is joined", () => {
    expect(findIllustrationMarkers("No picture.")).toEqual([]);
    const text = [
      "A garden.<Illus",
      "tration>",
      "A storm.",
      "<Illustration>",
    ].join("");
    expect(findIllustrationMarkers(text)).toHaveLength(2);
    const message = answer(text);
    expect(canonicalIllustrationText(message)).toBe(text);
    expect(new Set(message.illustrations.map((i) => i.id)).size).toBe(2);
  });

  it.each([
    "`<Illustration>`",
    "<code><Illustration></code>",
    "<pre><code><Illustration></code></pre>",
    "``<Illustration>``",
    "```html\n<Illustration>\n```",
    "~~~\n<Illustration>\n~~~",
    "    <Illustration>",
    "\t<Illustration>",
    "<Thoughts><Illustration></Thoughts>",
    "<think><Illustration></think>",
    "<analysis><reasoning><Illustration></reasoning></analysis>",
    "<Thoughts><Illustration>",
    "\\<Illustration>",
  ])("ignores excluded marker: %s", (code) => {
    expect(
      findIllustrationMarkers(`${code}\nVisible.<Illustration>`),
    ).toHaveLength(
      code.includes("<Thoughts><Illustration>") && !code.includes("</Thoughts>")
        ? 0
        : 1,
    );
  });

  it("defaults to off, inherits context, and appends character instructions after global text", () => {
    expect(resolveIllustrationSettings()).toMatchObject({
      enabled: false,
      displayWidth: 50,
      generationCount: 1,
      recentMessages: 6,
      includeDescription: true,
      includePersona: true,
      includeLorebook: false,
      includeMemory: false,
    });
    expect(
      resolveIllustrationSettings(
        { enabled: true, markerInstructions: "global", basePrompt: "quality" },
        {
          includePersona: false,
          markerInstructions: "character",
          basePrompt: "red",
        },
      ),
    ).toMatchObject({
      enabled: true,
      includePersona: false,
      markerInstructions: "global\n\ncharacter",
      basePrompt: "quality\n\nred",
      negativePrompt: "",
    });
  });

  it("inherits illustration width, allows character overrides, and bounds imported values", () => {
    expect(resolveIllustrationSettings({ displayWidth: 75 }).displayWidth).toBe(
      75,
    );
    expect(
      resolveIllustrationSettings({ displayWidth: 75 }, { displayWidth: 30 })
        .displayWidth,
    ).toBe(30);
    expect(resolveIllustrationSettings({ displayWidth: 0 }).displayWidth).toBe(
      10,
    );
    expect(
      resolveIllustrationSettings({ displayWidth: 150 }).displayWidth,
    ).toBe(100);
    expect(
      resolveIllustrationSettings({ displayWidth: NaN }).displayWidth,
    ).toBe(50);
  });

  it("only includes requested information and excludes later messages and later parts of an answer", () => {
    const message = answer();
    const history: IllustrationMessage[] = ["old", "recent", "latest"].map(
      (data) => ({ role: "user", data }),
    );
    const context = {
      description: "CHAR",
      persona: "USER",
      lorebook: "LORE",
      memory: "MEMORY",
    };
    const result = buildIllustrationPrompt(
      resolveIllustrationSettings({ recentMessages: 2 }),
      history,
      message,
      message.illustrations[0],
      context,
    );
    expect(result.history.map((m) => m.content)).toEqual(["recent", "latest"]);
    expect(result.required[1].content).toContain("A garden.");
    expect(result.required[1].content).not.toContain("storm");
    expect(result.required[0].content).toContain("CHAR");
    expect(result.required[0].content).toContain("USER");
    expect(result.required[0].content).not.toContain("LORE");
    expect(result.required[0].content).not.toContain("MEMORY");
    const none = buildIllustrationPrompt(
      resolveIllustrationSettings({
        recentMessages: 0,
        includeDescription: false,
        includePersona: false,
        includeLorebook: true,
        includeMemory: true,
      }),
      history,
      message,
      message.illustrations[1],
      context,
    );
    expect(none.history).toEqual([]);
    expect(none.required[0].content).toContain("LORE");
    expect(none.required[0].content).toContain("MEMORY");
    expect(none.required[1].content).toContain("A storm.");
    expect(none.required[1].content).not.toContain("illustration::");
  });

  it("trims oldest history first and fails when required instructions and scene cannot fit", async () => {
    const required = [
      { role: "system" as const, content: "rules" },
      { role: "user" as const, content: "scene" },
    ];
    const history = ["old", "middle", "new"].map((content) => ({
      role: "user" as const,
      content,
    }));
    const count = async (messages) => messages.length * 10;
    expect(
      (await fitIllustrationPrompt({ required, history }, count, 330)).map(
        (m) => m.content,
      ),
    ).toEqual(["rules", "new", "scene"]);
    await expect(
      fitIllustrationPrompt({ required, history }, count, 319),
    ).rejects.toThrow("context limit");
  });

  it("keeps a stable edit guard after its own image replacement and rejects edited or branched answers", () => {
    const message = answer();
    const second = message.illustrations[1];
    const first = message.illustrations[0];
    message.data = message.data.replace(first.token, "{{inlay::image}}");
    first.token = "{{inlay::image}}";
    expect(validIllustration(message, second, "branch", 1)).toBe(true);
    expect(validIllustration(message, second, "other-branch", 1)).toBe(false);
    expect(validIllustration(message, second, "branch", 2)).toBe(false);
    message.data += "edited";
    expect(validIllustration(message, second, "branch", 1)).toBe(false);
  });

  it("rejects empty tags after removing reasoning", () => {
    expect(
      cleanIllustrationTags("<Thoughts>secret</Thoughts> red dress, sunset"),
    ).toBe("red dress, sunset");
    expect(() => cleanIllustrationTags("<think>only thinking</think>")).toThrow(
      "no image tags",
    );
  });

  it("requires matching backtick run lengths to exclude inline code", () => {
    expect(findIllustrationMarkers("`unclosed <Illustration>``")).toHaveLength(
      1,
    );
    expect(
      findIllustrationMarkers("``code `<Illustration>` code``"),
    ).toHaveLength(0);
  });
});

function runtime(
  message = answer(),
  generationCount = 1,
  tagRequestMode: "sequential" | "parallel" = "sequential",
) {
  const targets: IllustrationTarget[] = message.illustrations.map((item) => ({
    characterId: "char",
    chatId: "chat",
    messageId: "answer",
    illustrationId: item.id,
  }));
  let branchId = "branch";
  let deleted = false;
  const update = vi.fn(async (target, version, change) => {
    const item = message.illustrations.find(
      (i) => i.id === target.illustrationId,
    );
    const record: IllustrationRecord = { message, item, branchId };
    if (deleted || !item || !canUpdateIllustration(record, version))
      return null;
    change(record);
    return record;
  });
  const adapter = {
    generationCount: vi.fn(async () => generationCount),
    tagRequestMode: vi.fn(async () => tagRequestMode),
    update,
    createTags: vi.fn(async () => "tags"),
    prompts: vi.fn(async (tags) => ({
      prompt: `base, ${tags}`,
      negativePrompt: "negative",
    })),
    createImage: vi.fn(
      async (_prompt: string, _negative: string, _target: IllustrationTarget) =>
        "data:image/png;base64,image",
    ),
    storeImage: vi.fn(async () => "image"),
    removeImage: vi.fn(async () => {}),
    summarizeError: (_error: unknown) => "failed",
  };
  return {
    message,
    targets,
    adapter,
    runner: createIllustrationRunner(adapter),
    branch: (id: string) => {
      branchId = id;
    },
    remove: () => {
      deleted = true;
    },
  };
}

describe("illustration execution lifecycle", () => {
  it("starts four tag requests together and generates in arrival order without waiting for all tags", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 4, "parallel");
    const releases: ((tags: string) => void)[] = [];
    r.adapter.createTags.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        }),
    );
    let releaseImage!: () => void;
    const blockedImage = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    r.adapter.createImage.mockImplementationOnce(async () => {
      await blockedImage;
      return "data";
    });
    r.adapter.storeImage.mockImplementation(
      async () => `image-${r.adapter.storeImage.mock.calls.length}`,
    );
    const task = r.runner.run(r.targets[0], 1);
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases[1]("second");
    await vi.waitFor(() =>
      expect(r.adapter.createImage).toHaveBeenCalledExactlyOnceWith(
        "base, second",
        "negative",
        r.targets[0],
      ),
    );
    // These results arrive while the first image is still generating. Their FIFO order matters.
    releases[3]("fourth");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases[0]("first");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releases[2]("third");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.adapter.createImage).toHaveBeenCalledTimes(1);
    releaseImage();
    await task;
    expect(r.adapter.createImage.mock.calls.map(([prompt]) => prompt)).toEqual([
      "base, second",
      "base, fourth",
      "base, first",
      "base, third",
    ]);
    expect(r.message.illustrations[0].status).toBe("complete");
    expect(r.message.illustrations[0].imageIds).toHaveLength(4);
  });

  it("bounds parallel tags to four requests and continues after a rejected request", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 8, "parallel");
    let active = 0,
      maximum = 0;
    r.adapter.createTags.mockImplementation(async () => {
      const index = r.adapter.createTags.mock.calls.length;
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      if (index === 2) throw new Error("one tag request failed");
      return `tags-${index}`;
    });
    r.adapter.storeImage.mockImplementation(
      async () => `image-${r.adapter.storeImage.mock.calls.length}`,
    );
    await r.runner.run(r.targets[0], 1);
    expect(maximum).toBe(4);
    expect(active).toBe(0);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(8);
    expect(r.adapter.createImage).toHaveBeenCalledTimes(7);
    const item = r.message.illustrations[0];
    expect(item.status).toBe("failed");
    expect(item.errorDetails?.stage).toBe("tags");
    item.version++;
    item.batch!.version = item.version;
    await r.runner.run(r.targets[0], 2);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(9);
    expect(r.adapter.createImage).toHaveBeenCalledTimes(8);
    expect(item.status).toBe("complete");
  });

  it("stops starting tag requests after invalidation and drains in-flight calls before releasing the job", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 8, "parallel");
    const releases: ((tags: string) => void)[] = [];
    r.adapter.createTags.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(resolve);
        }),
    );
    r.adapter.createImage.mockImplementationOnce(async () => {
      r.remove();
      return "invalid image";
    });
    const task = r.runner.run(r.targets[0], 1);
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    releases[0]("first");
    await vi.waitFor(() =>
      expect(r.adapter.createImage).toHaveBeenCalledTimes(1),
    );
    expect(releases).toHaveLength(5);
    expect(r.runner.has(r.targets[0])).toBe(true);
    releases.slice(1).forEach((resolve) => resolve("remaining"));
    await task;
    expect(r.adapter.createTags).toHaveBeenCalledTimes(5);
    expect(r.adapter.storeImage).not.toHaveBeenCalled();
    expect(r.runner.has(r.targets[0])).toBe(false);
  });
  it("requests four independent tag/image pairs and displays each saved image immediately", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 4);
    const events: string[] = [];
    r.adapter.createTags.mockImplementation(async () => {
      const index = r.adapter.createTags.mock.calls.length;
      events.push(`tags-${index}`);
      if (index > 1) {
        expect(r.message.illustrations[0].imageIds).toHaveLength(index - 1);
        expect(r.message.illustrations[0].status).not.toBe("complete");
      }
      return `tags-${index}`;
    });
    r.adapter.createImage.mockImplementation(async (prompt) => {
      events.push(prompt);
      return "image data";
    });
    r.adapter.storeImage.mockImplementation(
      async () => `image-${r.adapter.storeImage.mock.calls.length}`,
    );
    await r.runner.run(r.targets[0], 1);
    expect(events).toEqual([
      "tags-1",
      "base, tags-1",
      "tags-2",
      "base, tags-2",
      "tags-3",
      "base, tags-3",
      "tags-4",
      "base, tags-4",
    ]);
    expect(r.message.illustrations[0]).toMatchObject({
      status: "complete",
      imageIds: ["image-1", "image-2", "image-3", "image-4"],
    });
    expect(r.message.data).toBe("Scene.{{inlay::image-4}}");
  });

  it("preserves partial success and retries only missing images with their own saved prompts", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 4);
    r.adapter.createTags.mockImplementation(
      async () => `tags-${r.adapter.createTags.mock.calls.length}`,
    );
    r.adapter.createImage
      .mockResolvedValueOnce("data")
      .mockRejectedValueOnce(new Error("failed second image"));
    r.adapter.storeImage.mockImplementation(
      async () => `image-${r.adapter.storeImage.mock.calls.length}`,
    );
    await r.runner.run(r.targets[0], 1);
    const item = r.message.illustrations[0];
    expect(item.status).toBe("failed");
    expect(item.imageIds).toHaveLength(3);
    item.version++;
    item.batch!.version = item.version;
    item.status = "queued";
    await r.runner.run(r.targets[0], 2);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(4);
    expect(r.adapter.createImage).toHaveBeenCalledTimes(5);
    expect(r.adapter.createImage).toHaveBeenLastCalledWith(
      "base, tags-2",
      "negative",
      r.targets[0],
    );
    expect(item.status).toBe("complete");
    expect(item.imageIds).toHaveLength(4);
    expect(item.batch!.entries.every((entry) => entry.imageId)).toBe(true);
  });

  it("retries failed tag requests without repeating successful batch entries", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 4);
    r.adapter.createTags.mockRejectedValueOnce(new Error("tag failure"));
    r.adapter.storeImage.mockImplementation(
      async () => `image-${r.adapter.storeImage.mock.calls.length}`,
    );
    await r.runner.run(r.targets[0], 1);
    const item = r.message.illustrations[0];
    expect(item.status).toBe("failed");
    expect(item.errorDetails?.stage).toBe("tags");
    expect(item.imageIds).toHaveLength(3);
    item.version++;
    item.batch!.version = item.version;
    await r.runner.run(r.targets[0], 2);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(5);
    expect(r.adapter.createImage).toHaveBeenCalledTimes(4);
    expect(item.status).toBe("complete");
  });

  it("regenerates each batch entry using its own tags while retaining previous images", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 4);
    r.adapter.createTags.mockImplementation(
      async () => `tags-${r.adapter.createTags.mock.calls.length}`,
    );
    r.adapter.storeImage.mockImplementation(
      async () => `image-${r.adapter.storeImage.mock.calls.length}`,
    );
    await r.runner.run(r.targets[0], 1);
    r.message.illustrations[0].version++;
    await r.runner.run(r.targets[0], 2);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(4);
    expect(
      r.adapter.createImage.mock.calls.slice(4).map(([prompt]) => prompt),
    ).toEqual(["base, tags-1", "base, tags-2", "base, tags-3", "base, tags-4"]);
    expect(r.message.illustrations[0].imageIds).toHaveLength(8);
  });

  it("stops further batch requests after an edit while storing a later image and removes only the orphan", async () => {
    const r = runtime(answer("Scene.<Illustration>"), 4);
    r.adapter.storeImage
      .mockResolvedValueOnce("first")
      .mockImplementationOnce(async () => {
        r.message.data += "edit";
        return "orphan";
      });
    await r.runner.run(r.targets[0], 1);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(2);
    expect(r.adapter.createImage).toHaveBeenCalledTimes(2);
    expect(r.adapter.removeImage).toHaveBeenCalledExactlyOnceWith("orphan");
    expect(r.message.illustrations[0].imageIds).toEqual(["first"]);
  });
  it.each([
    [
      "tags",
      "createTags",
      new Error("fetch failed", { cause: { code: "ECONNREFUSED" } }),
      "connection",
    ],
    ["image", "createImage", new IllustrationRequestError("auth", 401), "auth"],
    ["save", "storeImage", new Error("disk full api-key-secret"), "unknown"],
  ] as const)(
    "records the %s failure stage without storing provider text",
    async (stage, method, error, code) => {
      const r = runtime(answer("Scene.<Illustration>"));
      r.adapter.summarizeError = summarizeIllustrationError;
      r.adapter[method].mockRejectedValueOnce(error);
      await r.runner.run(r.targets[0], 1);
      expect(r.message.illustrations[0]).toMatchObject({
        status: "failed",
        errorDetails: { stage, code },
      });
      expect(JSON.stringify(r.message)).not.toContain("api-key-secret");
    },
  );

  it("deduplicates clicks, processes in order and continues after a failed image", async () => {
    const r = runtime();
    r.adapter.createImage.mockRejectedValueOnce(new Error("provider failed"));
    const first = r.runner.run(r.targets[0], 1);
    const duplicate = r.runner.run(r.targets[0], 1);
    const second = r.runner.run(r.targets[1], 1);
    expect(first).toBe(duplicate);
    await Promise.all([first, second]);
    expect(r.message.illustrations.map((i) => i.status)).toEqual([
      "failed",
      "complete",
    ]);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(2);
    expect(r.message.data).toBe(
      `A garden.${r.message.illustrations[0].token}A storm.{{inlay::image}}`,
    );
    expect(r.runner.has(r.targets[0])).toBe(false);
  });

  it("retries from saved tags and retains the old image until durable replacement", async () => {
    const r = runtime(answer("Scene.<Illustration>"));
    await r.runner.run(r.targets[0], 1);
    const item = r.message.illustrations[0];
    item.version++;
    item.status = "queued";
    r.adapter.storeImage.mockRejectedValueOnce(new Error("storage failed"));
    await r.runner.run(r.targets[0], 2);
    expect(item.status).toBe("failed");
    expect(item.tags).toBe("tags");
    expect(r.message.data).toContain("{{inlay::image}}");
    item.version++;
    item.status = "queued";
    r.adapter.storeImage.mockResolvedValueOnce("replacement");
    await r.runner.run(r.targets[0], 3);
    expect(r.adapter.createTags).toHaveBeenCalledTimes(1);
    expect(r.message.data).toContain("{{inlay::replacement}}");
    expect(item.status).toBe("complete");
    expect(item.errorDetails).toBeUndefined();
    expect(item.imageIds).toEqual(["image", "replacement"]);
  });

  it("keeps a legacy image and successive rerolls in chronological history", async () => {
    const r = runtime(answer("Scene.<Illustration>"));
    const item = r.message.illustrations[0];
    r.message.data = r.message.data.replace(item.token, "{{inlay::legacy}}");
    item.token = "{{inlay::legacy}}";
    item.imageId = "legacy";
    r.adapter.storeImage
      .mockResolvedValueOnce("second")
      .mockResolvedValueOnce("third");
    await r.runner.run(r.targets[0], 1);
    item.version++;
    item.status = "queued";
    await r.runner.run(r.targets[0], 2);
    expect(item.imageIds).toEqual(["legacy", "second", "third"]);
    expect(item.imageId).toBe("third");
    expect(r.adapter.removeImage).not.toHaveBeenCalled();
  });

  it("rewrites tags while preserving the old image", async () => {
    const r = runtime(answer("Scene.<Illustration>"));
    await r.runner.run(r.targets[0], 1);
    const item = r.message.illustrations[0];
    item.version++;
    item.status = "queued";
    delete item.tags;
    delete item.prompt;
    delete item.batch;
    r.adapter.createTags.mockImplementationOnce(async () => {
      expect(r.message.data).toContain("{{inlay::image}}");
      return "new tags";
    });
    await r.runner.run(r.targets[0], 2);
    expect(item.tags).toBe("new tags");
    expect(item.prompt).toBe("base, new tags");
    expect(r.adapter.createTags).toHaveBeenCalledTimes(2);
  });

  it("queues a new version behind an invalidated running version", async () => {
    const r = runtime(answer("Scene.<Illustration>"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    r.adapter.createImage.mockImplementationOnce(async () => {
      await gate;
      return "old data";
    });
    const old = r.runner.run(r.targets[0], 1);
    await vi.waitFor(() =>
      expect(r.adapter.createImage).toHaveBeenCalledTimes(1),
    );
    r.message.illustrations[0].version++;
    const next = r.runner.run(r.targets[0], 2);
    expect(next).not.toBe(old);
    release();
    await Promise.all([old, next]);
    expect(r.adapter.createImage).toHaveBeenCalledTimes(2);
    expect(r.adapter.storeImage).toHaveBeenCalledTimes(1);
    expect(r.message.illustrations[0]).toMatchObject({
      status: "complete",
      version: 2,
    });
  });

  it.each(["edit", "delete", "branch", "version"])(
    "discards a result invalidated by %s",
    async (mode) => {
      const r = runtime(answer("Scene.<Illustration>"));
      r.adapter.createImage.mockImplementationOnce(async () => {
        if (mode === "edit") r.message.data += "edited";
        if (mode === "delete") r.remove();
        if (mode === "branch") r.branch("other");
        if (mode === "version") r.message.illustrations[0].version++;
        return "data:image/png;base64,image";
      });
      await r.runner.run(r.targets[0], 1);
      expect(r.adapter.storeImage).not.toHaveBeenCalled();
      expect(r.message.data).not.toContain("{{inlay::");
    },
  );

  it("removes only a newly stored orphan when the answer changes during storage", async () => {
    const r = runtime(answer("Scene.<Illustration>"));
    r.adapter.storeImage.mockImplementationOnce(async () => {
      r.message.data += "edit";
      return "orphan";
    });
    await r.runner.run(r.targets[0], 1);
    expect(r.adapter.removeImage).toHaveBeenCalledWith("orphan");
    expect(r.message.data).not.toContain("{{inlay::orphan}}");
  });

  it("runs one task at a time even with many queued markers", async () => {
    const queue = new IllustrationQueue();
    let active = 0,
      maximum = 0;
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        queue.enqueue(String(i), async () => {
          active++;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active--;
        }),
      ),
    );
    expect(maximum).toBe(1);
  });
});
