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

function runtime(message = answer()) {
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
    update,
    createTags: vi.fn(async () => "tags"),
    prompts: vi.fn(async (tags) => ({
      prompt: `base, ${tags}`,
      negativePrompt: "negative",
    })),
    createImage: vi.fn(async () => "data:image/png;base64,image"),
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
  });

  it("rewrites tags while preserving the old image", async () => {
    const r = runtime(answer("Scene.<Illustration>"));
    await r.runner.run(r.targets[0], 1);
    const item = r.message.illustrations[0];
    item.version++;
    item.status = "queued";
    delete item.tags;
    delete item.prompt;
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
