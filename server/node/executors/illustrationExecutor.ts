import { randomUUID } from "node:crypto";
import {
  isIllustrationBusy,
  resolveIllustrationSettings,
  illustrationSourceHash,
  type IllustrationJobRequest,
  type IllustrationJobResponse,
  type IllustrationTagRequest,
  type IllustrationTarget,
} from "../../../packages/protocol/dist/illustration.cjs";
import {
  canUpdateIllustration,
  createIllustrationRunner,
  illustrationJobKey,
  type IllustrationRecord,
} from "../../../packages/protocol/dist/illustrationRunner.cjs";
import {
  readIllustrationMessage,
  type IllustrationStorageReader,
} from "../../../packages/protocol/dist/illustrationStorage.cjs";
import {
  executeImageGeneration,
  IMAGE_GENERATION_SETTING_KEYS,
  type ImageGenerationRuntime,
  type ImageGenerationSettings,
} from "../../../packages/protocol/dist/imageGeneration.cjs";

type Storage = IllustrationStorageReader & {
  loadCharacter(id: string): Promise<any>;
  loadSettingKey(key: string): Promise<unknown>;
  getStorageSyncSummary(): Promise<{ revision: number }>;
};

interface Dependencies {
  getStorage(): Storage;
  commit(payload: unknown): Promise<unknown>;
  imageRuntime: ImageGenerationRuntime;
  storeImage(data: string): Promise<string>;
  removeImage(id: string): Promise<void>;
  fetchImpl?: typeof fetch;
  /** Uses the same URL policy as the existing authenticated model proxy. */
  sanitizeUrl?(url: string): string | null;
}

function normalizeTarget(value: any): IllustrationTarget {
  const target = {} as IllustrationTarget;
  for (const key of [
    "characterId",
    "chatId",
    "messageId",
    "illustrationId",
  ] as const) {
    if (
      typeof value?.[key] !== "string" ||
      !value[key].length ||
      value[key].length > 256 ||
      /[\x00-\x1f]/.test(value[key])
    )
      throw new TypeError(`Invalid ${key}`);
    target[key] = value[key];
  }
  return target;
}

export function decodeIllustrationTagResponse(data: any): string {
  const result =
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.message?.content ??
    data?.output_text ??
    data?.text ??
    data?.output ??
    data?.results?.[0]?.text ??
    data?.generations?.[0]?.text ??
    data?.data?.[0];
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result)
    ? result
    : (data?.content ?? data?.candidates?.[0]?.content?.parts);
  if (Array.isArray(blocks))
    return blocks
      .filter((b) => b.type !== "thinking" && !b.thought)
      .map(
        (b) =>
          b.text ??
          b.content
            ?.filter?.((c) => c.type === "output_text")
            .map((c) => c.text)
            .join("\n") ??
          "",
      )
      .join("\n");
  throw new Error("The submodel returned no image tags");
}

export function createNodeIllustrationExecutor(deps: Dependencies) {
  const runId = randomUUID();
  const inputs = new Map<string, IllustrationTagRequest | undefined>();
  const accepting = new Set<string>();
  let acceptance: Promise<unknown> = Promise.resolve();

  async function update(
    target: IllustrationTarget,
    version: number,
    change: (record: IllustrationRecord) => void,
    interrupt = false,
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const storage = deps.getStorage();
      const { revision } = await storage.getStorageSyncSummary();
      const located = await readIllustrationMessage(storage, target);
      if (!located) return null;
      const item = located.message.illustrations?.find(
        (i) => i.id === target.illustrationId,
      );
      if (!item || item.version !== version) return null;
      const record: IllustrationRecord = { ...located, item };
      if (!interrupt && !canUpdateIllustration(record, version)) return null;
      change(record);
      const { chatId: _id, ...data } = record.message;
      try {
        await deps.commit({
          baseRevision: revision,
          action: "illustration",
          root: { upserts: [], deletes: [] },
          characters: [],
          chats: [],
          chatManifests: [],
          messages: [
            {
              id: target.messageId,
              chatId: target.chatId,
              position: located.position,
              data,
            },
          ],
          messageManifests: [],
        });
        return record;
      } catch (error) {
        if (!Number.isSafeInteger(error?.currentRevision) || attempt === 4)
          throw error;
      }
    }
    return null;
  }

  async function settings(target: IllustrationTarget) {
    const storage = deps.getStorage();
    const char = await storage.loadCharacter(target.characterId);
    if (
      !char ||
      char.type === "group" ||
      !char.chats?.some((c) => c.id === target.chatId)
    )
      throw new TypeError("The illustration character or chat was removed");
    return {
      char,
      illustration: resolveIllustrationSettings(
        (await storage.loadSettingKey("illustration")) as any,
        char.illustration,
      ),
    };
  }

  const runner = createIllustrationRunner({
    update,
    createTags: async (target, record) => {
      const request = inputs.get(
        `${illustrationJobKey(target)}:${record.item.version}`,
      );
      if (!request) throw new Error("The prepared submodel request is missing");
      if (request.url === "risu:echo") {
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(600000, Math.max(0, Number(request.body.delayMs) || 0)),
          ),
        );
        return String(request.body.message ?? "Echo Message");
      }
      const response = await (deps.fetchImpl ?? fetch)(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(10 * 60 * 1000),
      });
      if (!response.ok) throw new Error(`Submodel HTTP ${response.status}`);
      const data = await response.json();
      // Horde accepts a task first; poll its authenticated result on the server.
      if (request.url.includes("/api/v2/generate/text/async")) {
        const url = new URL(request.url);
        url.pathname = `/api/v2/generate/text/status/${encodeURIComponent(data.id)}`;
        const start = Date.now();
        while (Date.now() - start < 10 * 60 * 1000) {
          const status = await (deps.fetchImpl ?? fetch)(url, {
            headers: request.headers,
            signal: AbortSignal.timeout(60000),
            redirect: "error",
          });
          if (!status.ok) throw new Error(`Submodel HTTP ${status.status}`);
          const result = await status.json();
          if (result.faulted) throw new Error("The submodel job failed");
          if (result.done) return decodeIllustrationTagResponse(result);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error("The submodel job timed out");
      }
      return decodeIllustrationTagResponse(data);
    },
    prompts: async (tags, target) => {
      const { illustration } = await settings(target);
      return {
        prompt: [illustration.basePrompt, tags].filter(Boolean).join(", "),
        negativePrompt: illustration.negativePrompt,
      };
    },
    createImage: async (prompt, negative, target) => {
      const { char } = await settings(target);
      const storage = deps.getStorage();
      const imageSettings: ImageGenerationSettings = Object.fromEntries(
        await Promise.all(
          IMAGE_GENERATION_SETTING_KEYS.map(async (key) => [
            key,
            await storage.loadSettingKey(key),
          ]),
        ),
      ) as any;
      const image = await executeImageGeneration(
        imageSettings,
        deps.imageRuntime,
        prompt,
        char,
        negative,
      );
      if (!image) throw new Error("The image provider returned no image");
      return image;
    },
    storeImage: deps.storeImage,
    removeImage: deps.removeImage,
    summarizeError: (error) => {
      const text = error instanceof Error ? error.message : "";
      return /^(Submodel HTTP \d+|The submodel returned no image tags|The submodel job (failed|timed out)|The image provider returned no image)$/.test(
        text,
      )
        ? text
        : "Illustration generation or storage failed. Check provider settings and retry.";
    },
  });

  async function get(
    target: IllustrationTarget,
  ): Promise<IllustrationJobResponse> {
    const located = await readIllustrationMessage(deps.getStorage(), target);
    let item = located?.message.illustrations?.find(
      (i) => i.id === target.illustrationId,
    );
    if (!item) throw new TypeError("Illustration not found");
    if (
      item.executor === "server" &&
      isIllustrationBusy(item.status) &&
      !runner.has(target, item.version) &&
      !accepting.has(illustrationJobKey(target))
    ) {
      const interrupted = await update(
        target,
        item.version,
        ({ item }) => {
          item.status = "interrupted";
          item.error = "Server illustration interrupted. Retry to continue.";
        },
        true,
      );
      item = interrupted?.item ?? item;
    }
    return { runId, illustration: item };
  }

  function accept(
    raw: IllustrationJobRequest,
  ): Promise<IllustrationJobResponse> {
    const task = acceptance
      .catch(() => {})
      .then(async () => {
        const target = normalizeTarget(raw);
        if (!Number.isSafeInteger(raw.version) || raw.version < 1)
          throw new TypeError("Invalid illustration version");
        if (
          raw.action !== undefined &&
          !["retry", "regenerate", "rewrite"].includes(raw.action)
        )
          throw new TypeError("Invalid illustration action");
        if (runner.has(target, raw.version)) return get(target);
        await settings(target);
        const existing = await readIllustrationMessage(
          deps.getStorage(),
          target,
        );
        const existingItem = existing?.message.illustrations?.find(
          (i) => i.id === target.illustrationId,
        );
        if (
          existingItem?.version === raw.version &&
          !raw.action &&
          (existingItem.status === "complete" ||
            existingItem.status === "failed")
        ) {
          return { runId, illustration: existingItem };
        }
        let request: IllustrationTagRequest | undefined;
        if (raw.tagRequest) {
          const url =
            raw.tagRequest.url === "risu:echo"
              ? raw.tagRequest.url
              : deps.sanitizeUrl
                ? deps.sanitizeUrl(raw.tagRequest.url)
                : raw.tagRequest.url;
          if (!url || (url !== "risu:echo" && !/^https?:\/\//.test(url)))
            throw new TypeError("Invalid submodel URL");
          if (
            !raw.tagRequest.body ||
            typeof raw.tagRequest.body !== "object" ||
            Array.isArray(raw.tagRequest.body)
          )
            throw new TypeError("Invalid submodel body");
          const headers: Record<string, string> = {
            "content-type": "application/json",
          };
          for (const [key, value] of Object.entries(
            raw.tagRequest.headers ?? {},
          )) {
            if (typeof value !== "string" || /[\r\n]/.test(key + value))
              throw new TypeError("Invalid submodel header");
            if (
              !/^(host|connection|content-length|risu-auth|x-risu-client-id)$/i.test(
                key,
              )
            )
              headers[key.toLowerCase()] = value;
          }
          request = { url, headers, body: { ...raw.tagRequest.body } };
          if ("stream" in request.body) request.body.stream = false;
          if (Buffer.byteLength(JSON.stringify(request)) > 16 * 1024 * 1024)
            throw new TypeError("Submodel request exceeds 16 MiB");
        }
        accepting.add(illustrationJobKey(target));
        let record: IllustrationRecord | null;
        try {
          record = await update(
            target,
            raw.version,
            ({ item, message, branchId }) => {
              if (item.executor !== "server")
                throw new TypeError(
                  "Illustration is assigned to the app executor",
                );
              if (raw.action && !isIllustrationBusy(item.status)) {
                if (!message.data.includes(item.token))
                  throw new TypeError("Illustration position was removed");
                item.version++;
                item.branchId = branchId;
                item.sourceHash = illustrationSourceHash(message);
                if (raw.action === "rewrite") {
                  delete item.tags;
                  delete item.prompt;
                  delete item.negativePrompt;
                }
              }
              if (!item.tags && !request)
                throw new TypeError("A prepared submodel request is required");
              Object.assign(item, { runId, status: "queued" });
              delete item.error;
            },
            Boolean(raw.action),
          );
        } catch (error) {
          accepting.delete(illustrationJobKey(target));
          throw error;
        }
        if (!record) accepting.delete(illustrationJobKey(target));
        if (!record)
          throw new TypeError(
            "Illustration was edited, deleted or switched to another branch",
          );
        const key = `${illustrationJobKey(target)}:${record.item.version}`;
        inputs.set(key, request);
        void runner.run(target, record.item.version).finally(() => {
          inputs.delete(key);
        });
        accepting.delete(illustrationJobKey(target));
        return { runId, illustration: record.item };
      });
    acceptance = task.catch(() => {});
    return task;
  }

  function registerRoutes(
    app: any,
    {
      auth,
      limiter,
      jsonParser,
    }: {
      auth: (req: any, res: any) => Promise<boolean>;
      limiter?: any;
      jsonParser?: any;
    },
  ) {
    const guards = [limiter, jsonParser].filter(Boolean);
    for (const route of [
      "/api/illustrations/jobs",
      "/api/illustrations/jobs/retry",
    ]) {
      app.post(route, ...guards, async (req: any, res: any) => {
        if (!(await auth(req, res))) return;
        try {
          res
            .status(202)
            .send(
              await accept(
                route.endsWith("/retry")
                  ? { ...req.body, action: req.body?.action ?? "retry" }
                  : req.body,
              ),
            );
        } catch (error) {
          res
            .status(error instanceof TypeError ? 400 : 500)
            .send({
              error:
                error instanceof TypeError
                  ? error.message
                  : "Unable to start the illustration",
            });
        }
      });
    }
    app.get(
      "/api/illustrations/jobs",
      ...(limiter ? [limiter] : []),
      async (req: any, res: any) => {
        if (!(await auth(req, res))) return;
        try {
          res.send(await get(normalizeTarget(req.query)));
        } catch (error) {
          res
            .status(error instanceof TypeError ? 404 : 500)
            .send({ error: "Illustration not found or unavailable" });
        }
      },
    );
  }
  return { accept, get, registerRoutes, runId, has: runner.has };
}
