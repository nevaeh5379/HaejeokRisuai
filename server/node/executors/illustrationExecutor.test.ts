// @vitest-environment node
import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNodeIllustrationExecutor,
  decodeIllustrationTagResponse,
} from "./illustrationExecutor.js";
import { createIllustrationImages } from "./illustrationImages.js";
import {
  prepareIllustrations,
  resolveIllustrationSettings,
  type IllustrationJobRequest,
} from "../../../packages/protocol/dist/illustration.cjs";
import { decodeInlayAssetBackup } from "../../../packages/backup-core/src/inlayCodec";
import {
  makeHarness,
  makeTauriStorage,
} from "../../../src/ts/storage/sql/sqlite/sqliteTestHarness";
import { buildFullDatabase } from "../../../src/ts/storage/sql/sqlite/sqliteTestFixtures";
import schema from "../../../packages/storage-sqlite/src/schema/schema.sql?raw";
import type { ISqlStorage } from "../../../src/ts/storage/sql/ISqlStorage";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function listen(app: express.Express) {
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  return `http://127.0.0.1:${typeof address === "object" ? address.port : 0}`;
}

async function fixture(
  useChatIllustrations = true,
  generationCount = 1,
  tagRequestMode: "sequential" | "parallel" = "sequential",
) {
  const image = await sharp({
    create: { width: 8, height: 8, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  const provider = express();
  provider.use(express.json());
  let images = 0,
    tags = 0;
  let rejectImage = false;
  let beforeImage: (() => Promise<void> | void) | undefined;
  let beforeTags: ((index: number) => Promise<void> | void) | undefined;
  let activeTags = 0,
    maximumTags = 0;
  provider.post("/tags", async (_req, res) => {
    const index = ++tags;
    activeTags++;
    maximumTags = Math.max(maximumTags, activeTags);
    await beforeTags?.(index);
    await new Promise((r) => setTimeout(r, 30));
    activeTags--;
    res.send({
      choices: [
        { message: { content: "<think>reason</think>sunset, red dress" } },
      ],
    });
  });
  provider.post("/sdapi/v1/txt2img", async (req, res) => {
    images++;
    await beforeImage?.();
    if (rejectImage) {
      res.status(503).send({ error: "api-key-secret must never be persisted" });
      return;
    }
    expect(req.body).toMatchObject({
      prompt: "quality, sunset, red dress",
      negative_prompt: "bad anatomy",
    });
    res.send({ images: [image.toString("base64")] });
  });
  const providerUrl = await listen(provider);
  const { storage, database } = makeHarness(makeTauriStorage, schema);
  await storage.init();
  const db = buildFullDatabase();
  db.useChatIllustrations = useChatIllustrations;
  db.illustration = resolveIllustrationSettings({
    generationCount,
    tagRequestMode,
    enabled: true,
    basePrompt: "quality",
    negativePrompt: "bad anatomy",
  });
  db.sdProvider = "webui";
  db.webUiUrl = providerUrl;
  db.sdSteps = 20;
  db.sdCFG = 7;
  db.sdConfig = {
    width: 512,
    height: 512,
    sampler_name: "Euler",
    script_name: "",
    enable_hr: false,
    denoising_strength: 0.7,
    hr_scale: 1,
    hr_upscaler: "",
  };
  db.characters[0].chats[0].message[1].data = "A sunset.<Illustration>";
  await storage.replaceDatabase(db);
  cleanups.push(() => database.close());
  const chat = await storage.loadChat("chat-1");
  const message = chat.message[1];
  const [item] = prepareIllustrations(
    message,
    chat.activeBranchId,
    "server",
    "client-run",
  );
  await storage.commit({
    baseRevision: storage.getRevision(),
    root: { upserts: [], deletes: [] },
    characters: [],
    chats: [],
    chatManifests: [],
    messages: [
      { id: "m2", chatId: "chat-1", position: 1, data: { ...message } },
    ],
    messageManifests: [],
  });

  const files = new Map<string, Uint8Array>();
  const catalog = new Map<string, number>();
  const assets = {
    read: async (key: string) => files.get(key),
    write: async (key: string, data: Uint8Array) => {
      files.set(key, data);
    },
    remove: async (keys: string[]) => {
      keys.forEach((key) => files.delete(key));
    },
  };
  const imageAdapter = createIllustrationImages(
    () => assets,
    async (entries) => {
      entries.forEach(({ key, size }) => catalog.set(key, size));
    },
    async (keys) => {
      keys.forEach((key) => catalog.delete(key));
    },
  );
  const deps = {
    getStorage: () => ({
      loadChat: storage.loadChat.bind(storage),
      loadChatMessagePage: storage.loadChatMessagePage.bind(storage),
      loadCharacter: storage.loadCharacter.bind(storage),
      loadSettingKey: async (key: string) => ({
        value: await storage.loadSettingKey(key),
      }),
      getStorageSyncSummary: async () => ({ revision: storage.getRevision() }),
    }),
    commit: (payload) => storage.commit(payload),
    imageRuntime: imageAdapter.runtime,
    storeImage: imageAdapter.storeImage,
    removeImage: imageAdapter.removeImage,
  };
  const executor = createNodeIllustrationExecutor(deps);
  const api = express();
  executor.registerRoutes(api, {
    auth: async (req, res) => {
      if (req.headers["risu-auth"] !== "authenticated") {
        res.sendStatus(401);
        return false;
      }
      return true;
    },
    jsonParser: express.json(),
  });
  const apiUrl = await listen(api);
  const target = {
    characterId: "char-1",
    chatId: "chat-1",
    messageId: "m2",
    illustrationId: item.id,
  };
  const request: IllustrationJobRequest = {
    ...target,
    version: 1,
    tagRequest: {
      url: `${providerUrl}/tags`,
      body: {},
      headers: { Authorization: "Bearer api-key-secret" },
    },
  };
  return {
    storage,
    deps,
    executor,
    target,
    request,
    apiUrl,
    files,
    catalog,
    counts: () => ({ images, tags }),
    failImage: (value: boolean) => {
      rejectImage = value;
    },
    duringImage: (fn: () => Promise<void> | void) => {
      beforeImage = fn;
    },
    duringTags: (fn: (index: number) => Promise<void> | void) => {
      beforeTags = fn;
    },
    tagConcurrency: () => maximumTags,
    message: async () =>
      (await storage.loadChat("chat-1")).message.find((m) => m.chatId === "m2"),
  };
}

async function finished(f: Awaited<ReturnType<typeof fixture>>) {
  await vi.waitFor(
    async () => {
      const item = (await f.message())?.illustrations[0];
      expect(
        item && ["complete", "failed", "interrupted"].includes(item.status),
      ).toBe(true);
    },
    { timeout: 5000 },
  );
}

async function addSlots(f: Awaited<ReturnType<typeof fixture>>, count: number) {
  const chat = await f.storage.loadChat("chat-1");
  const message = chat.message.find((m) => m.chatId === "m2");
  message.data = "A sunset." + "<Illustration>".repeat(count);
  message.illustrations = [];
  const items = prepareIllustrations(
    message,
    chat.activeBranchId,
    "server",
    "client-run",
  );
  await f.storage.commit({
    baseRevision: f.storage.getRevision(),
    root: { upserts: [], deletes: [] },
    characters: [],
    chats: [],
    chatManifests: [],
    messageManifests: [],
    messages: [{ id: "m2", chatId: "chat-1", position: 1, data: message }],
  });
  return items.map((item) => ({ ...f.request, illustrationId: item.id }));
}

describe("Node illustrations with real SQLite and HTTP providers", () => {
  it("notifies the saved image after SQL commit while subsequent images are still pending", async () => {
    const f = await fixture(true, 4, "parallel");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.duringImage(() => (f.counts().images === 2 ? blocked : undefined));
    const onProgress = vi.fn();
    const executor = createNodeIllustrationExecutor({ ...f.deps, onProgress });
    await executor.accept(f.request);
    try {
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1));
      expect(onProgress).toHaveBeenCalledWith(f.target);
      const item = (await f.message()).illustrations[0];
      expect(item.imageIds).toHaveLength(1);
      expect(item.progress).toBeGreaterThan(0);
      expect(item.status).not.toBe("complete");
      expect(f.files.size).toBe(1);
    } finally {
      release();
    }
    await finished(f);
    expect(onProgress).toHaveBeenCalledTimes(5); // Four saved images and the final state.
  });
  it("sends parallel submodel HTTP requests and saves the first image before the remaining tags arrive", async () => {
    const f = await fixture(true, 4, "parallel");
    let release!: () => void;
    const blockedTags = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.duringTags((index) => (index === 1 ? undefined : blockedTags));
    await f.executor.accept(f.request);
    try {
      await vi.waitFor(
        () => {
          expect(f.counts()).toEqual({ tags: 4, images: 1 });
          expect(f.files.size).toBe(1);
        },
        { timeout: 5000 },
      );
      expect(f.tagConcurrency()).toBe(4);
      expect((await f.message()).illustrations[0].status).not.toBe("complete");
    } finally {
      release();
    }
    await finished(f);
    expect(f.counts()).toEqual({ tags: 4, images: 4 });
    expect((await f.message()).illustrations[0].imageIds).toHaveLength(4);
    expect((await f.message()).illustrations[0].status).toBe("complete");
  });
  it("stores four images in one slot and retries only the failed member without repeating tags", async () => {
    const f = await fixture(true, 4);
    f.duringImage(() => {
      const { images } = f.counts();
      if (images > 1) expect(f.files.size).toBeGreaterThan(0);
      f.failImage(images === 2);
    });
    await f.executor.accept(f.request);
    await finished(f);
    const item = (await f.message()).illustrations[0];
    expect(f.counts()).toEqual({ tags: 4, images: 4 });
    expect(item.status).toBe("failed");
    expect(item.imageIds).toHaveLength(3);
    expect(f.catalog.size).toBe(3);
    await f.executor.accept({ ...f.target, version: 1, action: "retry" });
    await finished(f);
    const complete = (await f.message()).illustrations[0];
    expect(f.counts()).toEqual({ tags: 4, images: 5 });
    expect(complete.status).toBe("complete");
    expect(complete.imageIds).toHaveLength(4);
    expect(complete.batch!.entries.every((entry) => entry.imageId)).toBe(true);
    expect(f.files.size).toBe(4);
    expect(f.catalog.size).toBe(4);
  });
  it("bounds accepted and accepting jobs, returns 429, and frees capacity after completion", async () => {
    const f = await fixture();
    const requests = await addSlots(f, 9);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    f.duringImage(() => blocked);
    try {
      const accepting = requests
        .slice(0, 8)
        .map((request) => f.executor.accept(request));
      const response = await fetch(`${f.apiUrl}/api/illustrations/jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "risu-auth": "authenticated",
        },
        body: JSON.stringify(requests[8]),
      });
      expect(response.status).toBe(429);
      await Promise.all(accepting);
      expect((await f.message()).illustrations[8].runId).toBe("client-run");
    } finally {
      unblock();
    }
    await vi.waitFor(
      () => {
        expect(requests.some((request) => f.executor.has(request))).toBe(false);
      },
      { timeout: 5000 },
    );
    await f.executor.accept(requests[8]);
    await vi.waitFor(() => expect(f.executor.has(requests[8])).toBe(false), {
      timeout: 5000,
    });
  });

  it("bounds aggregate request bytes before SQL acceptance and releases rejected reservations", async () => {
    const f = await fixture();
    const requests = await addSlots(f, 3);
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    f.duringImage(() => blocked);
    const largeRequests = requests.map((request) => ({
      ...request,
      tagRequest: {
        ...request.tagRequest,
        body: { padding: "x".repeat(11 * 1024 * 1024) },
      },
    }));
    const executor = createNodeIllustrationExecutor({
      ...f.deps,
      // Avoid transmitting oversized mock prompts; retain them in the actual executor queue.
      fetchImpl: async () =>
        new Response(JSON.stringify({ text: "sunset, red dress" })),
    });
    try {
      const first = executor.accept(largeRequests[0]);
      const second = executor.accept(largeRequests[1]);
      await expect(executor.accept(largeRequests[2])).rejects.toThrow(
        "queue is full",
      );
      await Promise.all([first, second]);
    } finally {
      unblock();
    }
    await vi.waitFor(
      () =>
        expect(requests.some((request) => executor.has(request))).toBe(false),
      { timeout: 5000 },
    );
    // Invalid acceptance must also release its reservation, even on repeated failures.
    for (let i = 0; i < 10; i++) {
      await expect(
        executor.accept({ ...requests[2], version: 0 }),
      ).rejects.toThrow("Invalid illustration version");
    }
    await executor.accept(requests[2]);
    await vi.waitFor(() => expect(executor.has(requests[2])).toBe(false), {
      timeout: 5000,
    });
  });

  it("removes the logical catalog entry if the answer is edited after the inlay is stored", async () => {
    const f = await fixture();
    const executor = createNodeIllustrationExecutor({
      ...f.deps,
      storeImage: async (data) => {
        const id = await f.deps.storeImage(data);
        expect(f.catalog.has(`inlay_${id}.risuinlay`)).toBe(true);
        const message = await f.message();
        message.data += "user edit";
        await f.storage.commit({
          baseRevision: f.storage.getRevision(),
          root: { upserts: [], deletes: [] },
          characters: [],
          chats: [],
          chatManifests: [],
          messageManifests: [],
          messages: [
            { id: "m2", chatId: "chat-1", position: 1, data: message },
          ],
        });
        return id;
      },
    });
    await executor.accept(f.request);
    await vi.waitFor(() => expect(executor.has(f.target)).toBe(false), {
      timeout: 5000,
    });
    expect(f.files.size).toBe(0);
    expect(f.catalog.size).toBe(0);
    expect((await f.message()).illustrations[0].imageId).toBeUndefined();
  });

  it("rejects generation when the beta feature is disabled even with enabled illustration settings", async () => {
    const f = await fixture(false);
    await expect(f.executor.accept(f.request)).rejects.toThrow(
      "Chat illustrations are disabled",
    );
    expect(f.counts()).toEqual({ images: 0, tags: 0 });
    expect((await f.message()).illustrations[0].status).toBe("queued");
  });

  it("finishes after HTTP acceptance without any client polling, stores an inlay, and ignores replay", async () => {
    const f = await fixture();
    const response = await fetch(`${f.apiUrl}/api/illustrations/jobs`, {
      method: "POST",
      headers: {
        "risu-auth": "authenticated",
        "content-type": "application/json",
      },
      body: JSON.stringify(f.request),
    });
    expect(response.status).toBe(202);
    await response.json();
    // No live client connection or polling is needed from this point onward.
    await finished(f);
    const message = await f.message();
    const item = message.illustrations[0];
    expect(item.status, JSON.stringify({ item, counts: f.counts() })).toBe(
      "complete",
    );
    expect(message.data).toBe(`A sunset.{{inlay::${item.imageId}}}`);
    expect(item.tags).toBe("sunset, red dress");
    expect(f.files.size).toBe(1);
    const stored = decodeInlayAssetBackup([...f.files.values()][0]);
    expect(stored).toMatchObject({
      type: "image",
      width: 8,
      height: 8,
      ext: "png",
    });
    await f.executor.accept(f.request);
    expect(f.counts()).toEqual({ images: 1, tags: 1 });
    expect(JSON.stringify(message)).not.toContain("api-key-secret");
  });

  it("requires authentication for create, query and retry", async () => {
    const f = await fixture();
    for (const [path, method] of [
      ["/api/illustrations/jobs", "POST"],
      ["/api/illustrations/jobs/retry", "POST"],
      ["/api/illustrations/jobs", "GET"],
    ]) {
      expect(
        (
          await fetch(f.apiUrl + path, {
            method,
            headers: { "content-type": "application/json" },
            ...(method === "POST" ? { body: JSON.stringify(f.request) } : {}),
          })
        ).status,
      ).toBe(401);
    }
    expect(f.counts()).toEqual({ images: 0, tags: 0 });
  });

  it("deduplicates concurrent submissions and marks an abandoned server version as interrupted after restart", async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.executor.accept(f.request),
      f.executor.accept(f.request),
    ]);
    expect(results[0].runId).toBe(results[1].runId);
    await finished(f);
    expect(f.counts()).toEqual({ images: 1, tags: 1 });
    const message = await f.message();
    message.illustrations[0].status = "generating";
    await f.storage.commit({
      baseRevision: f.storage.getRevision(),
      root: { upserts: [], deletes: [] },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [{ id: "m2", chatId: "chat-1", position: 1, data: message }],
      messageManifests: [],
    });
    const restarted = createNodeIllustrationExecutor(f.deps);
    expect((await restarted.get(f.target)).illustration.status).toBe(
      "interrupted",
    );
    expect((await f.message()).illustrations[0].status).toBe("interrupted");
    expect(f.counts()).toEqual({ images: 1, tags: 1 });
  });

  it("preserves tags on provider failure, redacts errors, and retries images without calling the submodel", async () => {
    const f = await fixture();
    f.failImage(true);
    await f.executor.accept(f.request);
    await finished(f);
    const message = await f.message();
    expect(message.illustrations[0]).toMatchObject({
      status: "failed",
      tags: "sunset, red dress",
      errorDetails: { stage: "image", code: "server", status: 503 },
    });
    expect(JSON.stringify(message)).not.toContain("api-key-secret");
    message.illustrations[0].version++;
    message.illustrations[0].status = "queued";
    await f.storage.commit({
      baseRevision: f.storage.getRevision(),
      root: { upserts: [], deletes: [] },
      characters: [],
      chats: [],
      chatManifests: [],
      messages: [{ id: "m2", chatId: "chat-1", position: 1, data: message }],
      messageManifests: [],
    });
    f.failImage(false);
    await f.executor.accept({ ...f.target, version: 2, action: "retry" });
    await finished(f);
    expect((await f.message()).illustrations[0].status).toBe("complete");
    expect(f.counts()).toEqual({ images: 2, tags: 1 });
  });

  it("discards a generated image when the user edits the answer before completion", async () => {
    const f = await fixture();
    f.duringImage(async () => {
      const message = await f.message();
      message.data += "user edit";
      await f.storage.commit({
        baseRevision: f.storage.getRevision(),
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [{ id: "m2", chatId: "chat-1", position: 1, data: message }],
        messageManifests: [],
      });
    });
    await f.executor.accept(f.request);
    await vi.waitFor(
      () => {
        expect(f.executor.has(f.target)).toBe(false);
      },
      { timeout: 5000 },
    );
    expect((await f.message()).data).toContain("user edit");
    expect(f.files.size).toBe(0);
    expect((await f.executor.get(f.target)).illustration.status).toBe(
      "interrupted",
    );
  });

  it("supports authenticated direct retry and tag rewrite with version guards", async () => {
    const f = await fixture();
    f.failImage(true);
    await f.executor.accept(f.request);
    await finished(f);
    f.failImage(false);
    const response = await fetch(`${f.apiUrl}/api/illustrations/jobs/retry`, {
      method: "POST",
      headers: {
        "risu-auth": "authenticated",
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...f.target, version: 1 }),
    });
    expect(response.status).toBe(202);
    expect((await response.json()).illustration.version).toBe(2);
    await finished(f);
    const oldImage = (await f.message()).illustrations[0].imageId;
    await f.executor.accept({ ...f.request, version: 2, action: "rewrite" });
    expect((await f.message()).data).toContain(oldImage);
    await finished(f);
    expect((await f.message()).illustrations[0]).toMatchObject({
      version: 3,
      status: "complete",
    });
    expect(f.counts()).toEqual({ tags: 2, images: 3 });
    await expect(
      f.executor.accept({ ...f.request, version: 1, action: "retry" }),
    ).rejects.toThrow("edited");
    await expect(
      f.executor.accept({ ...f.request, action: "unknown" as any }),
    ).rejects.toThrow("action");
  });

  it("retains settings and metadata through SQL export/restore and branch creation", async () => {
    const f = await fixture();
    await f.executor.accept(f.request);
    await finished(f);
    const source = await f.storage.exportDatabaseSnapshot();
    const restored = makeHarness(makeTauriStorage, schema);
    await restored.storage.init();
    cleanups.push(() => restored.database.close());
    await restored.storage.replaceDatabase(source.database);
    expect(await restored.storage.loadSettingKey("illustration")).toMatchObject(
      { enabled: true, basePrompt: "quality" },
    );
    expect(
      (await restored.storage.loadChat("chat-1")).message[1].illustrations,
    ).toEqual((await f.message()).illustrations);
    const sourceChat = await restored.storage.loadChat("chat-1");
    const branch = await restored.storage.createChatBranch({
      id: "illustration-branch",
      chatId: "chat-1",
      parentBranchId: sourceChat.activeBranchId,
      forkMessageId: "m2",
      reason: "manual",
      createdAt: 100,
    });
    expect(
      (await restored.storage.loadBranchMessages("chat-1", branch.id)).find(
        (m) => m.chatId === "m2",
      ).illustrations,
    ).toEqual((await f.message()).illustrations);
  });
});

describe("submodel tag response decoding", () => {
  it.each([
    [{ choices: [{ message: { content: "tags" } }] }],
    [{ choices: [{ text: "tags" }] }],
    [
      {
        content: [
          { type: "thinking", text: "secret" },
          { type: "text", text: "tags" },
        ],
      },
    ],
    [
      {
        candidates: [
          {
            content: {
              parts: [{ thought: true, text: "secret" }, { text: "tags" }],
            },
          },
        ],
      },
    ],
    [
      {
        output: [
          { type: "message", content: [{ type: "output_text", text: "tags" }] },
        ],
      },
    ],
    [{ message: { content: "tags" } }],
    [{ output: "tags" }],
    [{ data: ["tags"] }],
  ])("decodes existing provider response %j", (data) => {
    expect(decodeIllustrationTagResponse(data)).toBe("tags");
  });
});
