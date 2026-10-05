import {
  buildIllustrationPrompt,
  findIllustrationMarkers,
  fitIllustrationPrompt,
  illustrationSourceHash,
  isIllustrationBusy,
  prepareIllustrations,
  resolveIllustrationSettings,
  validIllustration,
  type Illustration,
  type IllustrationAction,
  type IllustrationContext,
  type IllustrationJobRequest,
  type IllustrationJobResponse,
  type IllustrationTarget,
  IllustrationQueue,
} from "@risuai/protocol/dist/illustration.mjs";
import {
  canUpdateIllustration,
  createIllustrationRunner,
  illustrationJobKey,
  type IllustrationRecord,
} from "@risuai/protocol/dist/illustrationRunner.mjs";
import {
  readIllustrationHistory,
  readIllustrationMessage,
} from "@risuai/protocol/dist/illustrationStorage.mjs";
import { characterStore } from "../../stores/domain/characterStore.svelte";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { presetStore } from "../../stores/domain/presetStore.svelte";
import { messageStore } from "../../stores/domain/messageStore.svelte";
import { getSqlStorage } from "../../storage/sql/sqlStorageFactory";
import { mutateSqlMessage } from "../../storage/sql/sqlCommitCoordinator";
import { sqlMessageData } from "../../storage/sql/sqlCommit";
import { safeStructuredClone } from "../../polyfill";
import { NodeStorage } from "../../storage/files/nodeStorage";
import { forageStorage } from "../../globalApi.svelte";
import { encode } from "../../tokenizer";
import { requestChatDataMain } from "../request/request";
import { prepareBrowserProviderContext } from "../request/providerContextAdapter";
import { LLMFormat } from "../../model/modellist";
import type { character, Message } from "../../storage/database/schema";
import { v4 } from "uuid";

const appRunId = v4();
const contexts = new Map<string, IllustrationContext>();
const scheduling = new Set<string>();
const submissions = new Set<string>();
const actions = new Set<string>();
const serverSubmissions = new IllustrationQueue();

function resolveTarget(
  target: Pick<IllustrationTarget, "characterId" | "chatId">,
) {
  const char = characterStore.characters.find(
    (c) => c.chaId === target.characterId,
  );
  const chat = char?.chats?.find((c) => c.id === target.chatId);
  return char && char.type !== "group" && chat
    ? { char: char as character, chat }
    : null;
}

function getSettings(target: IllustrationTarget) {
  const resolved = resolveTarget(target);
  if (!resolved) throw new Error("The illustration chat was removed");
  return resolveIllustrationSettings(
    settingsStore.state.illustration,
    resolved.char.illustration,
  );
}

async function update(
  target: IllustrationTarget,
  version: number,
  change: (record: IllustrationRecord) => void,
) {
  const storage = await getSqlStorage();
  const result = await mutateSqlMessage(storage, async () => {
    const resolved = resolveTarget(target);
    if (!resolved) return null;
    const stored = await readIllustrationMessage(storage, target);
    if (!stored || stored.branchId !== resolved.chat.activeBranchId)
      return null;
    const resident = resolved.chat.message.find(
      (m) => m.chatId === target.messageId,
    );
    const message: Message = safeStructuredClone(resident ?? stored.message);
    const item = message.illustrations?.find(
      (i) => i.id === target.illustrationId,
    );
    if (!item) return null;
    const record = { message, item, branchId: stored.branchId };
    if (!canUpdateIllustration(record, version)) return null;
    const originalData = message.data;
    change(record);
    // A user may have edited or deleted the resident message while SQL was loading.
    const latest = resolveTarget(target);
    const latestMessage = latest?.chat.message.find(
      (m) => m.chatId === target.messageId,
    );
    if (
      !latest ||
      latest.chat.activeBranchId !== stored.branchId ||
      (resident && (!latestMessage || latestMessage.data !== originalData))
    )
      return null;
    return {
      commit: {
        baseRevision: 0,
        root: { upserts: [], deletes: [] },
        characters: [],
        chats: [],
        chatManifests: [],
        messages: [
          {
            id: target.messageId,
            chatId: target.chatId,
            position: stored.position,
            data: sqlMessageData(message),
          },
        ],
        messageManifests: [],
      },
      result: { ...record, originalData },
    };
  });
  if (result) {
    const resident = resolveTarget(target)?.chat.message.find(
      (m) => m.chatId === target.messageId,
    );
    if (
      resident?.data === result.originalData &&
      resident.illustrations?.find((i) => i.id === target.illustrationId)
        ?.version === version
    ) {
      resident.data = result.message.data;
      resident.illustrations = result.message.illustrations;
    }
  }
  return result;
}

async function tagArguments(
  target: IllustrationTarget,
  record: IllustrationRecord,
) {
  const storage = await getSqlStorage();
  const located = await readIllustrationMessage(storage, target);
  const resolved = resolveTarget(target);
  if (!located || !resolved)
    throw new Error("The illustration message was removed");
  const settings = getSettings(target);
  const history = await readIllustrationHistory(
    storage,
    target.chatId,
    located.position,
    settings.recentMessages,
  );
  const { currentIllustrationContext } = await import("./illustrationContext");
  const context =
    contexts.get(illustrationJobKey(target)) ??
    (await currentIllustrationContext(
      storage,
      target,
      resolved.char,
      resolved.chat,
      record.message as Message,
      record.item,
      located.position,
      settings,
    ));
  const arg = {
    formated: [],
    bias: {},
    currentChar: resolved.char,
    triggerTarget: { characterId: target.characterId, chatId: target.chatId },
    temperature: 0.2,
    maxTokens: 300,
    useStreaming: false,
    noMultiGen: true,
    tools: [],
    extractJson: "",
  };
  const { prepared } = prepareBrowserProviderContext(arg, "submodel");
  const formated = await fitIllustrationPrompt(
    buildIllustrationPrompt(
      settings,
      history,
      record.message,
      record.item,
      context,
    ),
    async (messages) => {
      let total = 0;
      for (const m of messages)
        total += (await encode(m.content, prepared.aiModel)).length + 8;
      return total;
    },
    presetStore.state.maxContext,
  );
  return { ...arg, formated, staticModel: prepared.aiModel };
}

export function usesAppIllustrationExecutor(): boolean {
  if (!(forageStorage.realStorage instanceof NodeStorage)) return true;
  const { prepared } = prepareBrowserProviderContext(
    { formated: [], bias: {} },
    "submodel",
  );
  return (
    prepared.modelInfo.format === LLMFormat.Plugin ||
    prepared.modelInfo.format === LLMFormat.WebLLM
  );
}

const runner = createIllustrationRunner({
  update,
  createTags: async (target, record) => {
    const response = await requestChatDataMain(
      await tagArguments(target, record),
      "submodel",
    );
    if (response.type === "multiline")
      return response.result.map((entry) => entry[1]).join("\n");
    if (response.type !== "success")
      throw new Error("The submodel returned no image tags");
    return response.result;
  },
  prompts: async (tags, target) => {
    const settings = getSettings(target);
    return {
      prompt: [settings.basePrompt, tags].filter(Boolean).join(", "),
      negativePrompt: settings.negativePrompt,
    };
  },
  createImage: async (prompt, negative, target) => {
    const { executeImageGeneration } =
      await import("@risuai/protocol/dist/imageGeneration.mjs");
    const { browserImageRuntime, getImageGenerationSettings } =
      await import("../imageGenerationBrowser");
    const char = resolveTarget(target)?.char;
    if (!char) throw new Error("The illustration character was removed");
    const image = await executeImageGeneration(
      getImageGenerationSettings(),
      browserImageRuntime,
      prompt,
      char,
      negative,
    );
    if (!image) throw new Error("The image provider returned no image");
    return image;
  },
  storeImage: async (data) => {
    const { writeInlayImageFromBytes } = await import("../files/inlays");
    if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(data))
      throw new Error("The image provider returned invalid image data");
    const mime = /^data:image\/([a-z0-9.+-]+)/i.exec(data)[1];
    return writeInlayImageFromBytes(
      new Uint8Array(Buffer.from(data.slice(data.indexOf(",") + 1), "base64")),
      { ext: mime, durable: true },
    );
  },
  removeImage: async (id) => {
    const { removeInlayAsset } = await import("../files/inlays");
    await removeInlayAsset(id);
  },
  // Provider bodies may echo credentials. Keep only safe actionable errors in persisted metadata.
  summarizeError: (error) => {
    const text =
      error instanceof Error ? error.message : "Illustration generation failed";
    return /^(Illustration instructions and current scene exceed the submodel context limit|The submodel returned no image tags|The illustration (chat|message|character) was removed|The image provider returned (invalid image data|no image)|Image canvas is unavailable)$/.test(
      text,
    )
      ? text
      : "Illustration generation or storage failed. Check the submodel and image provider settings, then retry.";
  },
});

async function serverRequest(
  storage: NodeStorage,
  path: string,
  body?: unknown,
): Promise<IllustrationJobResponse> {
  const response = await storage.apiClient.request(path, {
    method: body ? "POST" : "GET",
    headers: {
      "risu-auth": await storage.getCachedAuth(),
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      data.error ?? `Illustration server request failed (${response.status})`,
    );
  if (!data.illustration || typeof data.runId !== "string")
    throw new Error("Invalid illustration server response");
  return data;
}

async function submit(
  target: IllustrationTarget,
  item: Illustration,
  action?: IllustrationAction,
) {
  const key = illustrationJobKey(target);
  if (submissions.has(key) || runner.has(target)) return;
  submissions.add(key);
  let serverDispatched = false;
  try {
    const storage = forageStorage.realStorage;
    if (item.executor === "server" && storage instanceof NodeStorage) {
      await serverSubmissions.enqueue(`${key}:${item.version}`, async () => {
        const located = await readIllustrationMessage(
          await getSqlStorage(),
          target,
        );
        const latestItem = located?.message.illustrations?.find(
          (i) => i.id === target.illustrationId,
        );
        if (
          !located ||
          !latestItem ||
          !validIllustration(
            located.message,
            latestItem,
            located.branchId,
            item.version,
          )
        )
          return;
        const record = { ...located, item: latestItem };
        let tagRequest: IllustrationJobRequest["tagRequest"];
        if (!record.item.tags || action === "rewrite") {
          const response = await requestChatDataMain(
            { ...(await tagArguments(target, record)), previewBody: true },
            "submodel",
          );
          if (response.type !== "success")
            throw new Error("Unable to prepare the submodel request");
          const prepared = JSON.parse(response.result);
          if (!prepared.url || !prepared.body)
            throw new Error(
              "This submodel cannot prepare a server illustration request",
            );
          tagRequest = {
            url: prepared.url,
            headers: prepared.headers ?? {},
            body: prepared.body,
          };
        }
        serverDispatched = true;
        await serverRequest(storage, "/api/illustrations/jobs", {
          ...target,
          version: item.version,
          action,
          tagRequest,
        } satisfies IllustrationJobRequest);
        // SQL realtime events carry all later progress, including completion after this client exits.
      });
    } else {
      await runner.run(target, item.version);
    }
  } catch {
    // An accepted server job outlives this request; a lost response must not fail it.
    if (serverDispatched) {
      await queryServerIllustration(target);
      return;
    }
    await update(target, item.version, ({ item }) => {
      item.status = "failed";
      item.error =
        "Unable to start the illustration. Check the submodel, image provider and connection, then retry.";
    });
  } finally {
    submissions.delete(key);
    contexts.delete(key);
  }
}

export async function enqueueAnswerIllustrations(
  target: Omit<IllustrationTarget, "illustrationId">,
  context: IllustrationContext,
) {
  const answerKey = JSON.stringify(target);
  if (scheduling.has(answerKey)) return;
  scheduling.add(answerKey);
  try {
    let resolved = resolveTarget(target);
    let message = resolved?.chat.message.find(
      (m) => m.chatId === target.messageId,
    );
    if (
      !resolved ||
      !message ||
      message.role !== "char" ||
      !resolveIllustrationSettings(
        settingsStore.state.illustration,
        resolved.char.illustration,
      ).enabled
    )
      return;
    if (!findIllustrationMarkers(message.data).length) return;
    const originalData = message.data,
      originalBranch = resolved.chat.activeBranchId;
    await characterStore.flush();
    await messageStore.flush();
    const persistedChat = await (
      await getSqlStorage()
    ).loadChat(target.chatId, { messageLimit: 1 });
    resolved = resolveTarget(target);
    message = resolved?.chat.message.find((m) => m.chatId === target.messageId);
    if (
      !persistedChat ||
      !resolved ||
      !message ||
      message.data !== originalData ||
      resolved.chat.activeBranchId !== originalBranch ||
      (originalBranch && originalBranch !== persistedChat.activeBranchId)
    )
      return;
    // Newly created chats have no resident branch ID until their first SQL hydration.
    resolved.chat.activeBranchId = persistedChat.activeBranchId;
    const items = prepareIllustrations(
      message,
      v4,
      persistedChat.activeBranchId,
      usesAppIllustrationExecutor() ? "app" : "server",
      appRunId,
    );
    await messageStore.commitMessages(target.chatId, [message], [], true);
    await messageStore.flush();
    for (const item of items) {
      const slot = { ...target, illustrationId: item.id };
      contexts.set(illustrationJobKey(slot), context);
      // Queue every slot now; the executor processes image requests one at a time.
      void submit(slot, item);
    }
  } finally {
    scheduling.delete(answerKey);
  }
}

export async function illustrationAction(
  target: IllustrationTarget,
  action: IllustrationAction,
) {
  const key = illustrationJobKey(target);
  if (actions.has(key) || submissions.has(key) || runner.has(target)) return;
  actions.add(key);
  try {
    let resolved = resolveTarget(target);
    let message = resolved?.chat.message.find(
      (m) => m.chatId === target.messageId,
    );
    let item = message?.illustrations?.find(
      (i) => i.id === target.illustrationId,
    );
    if (!resolved || !item || !message.data.includes(item.token)) return;
    if (
      item.executor === "server" &&
      isIllustrationBusy(item.status) &&
      forageStorage.realStorage instanceof NodeStorage
    ) {
      const status = await queryServerIllustration(target);
      if (!status || isIllustrationBusy(status.illustration.status)) return;
      // Re-resolve after the query: realtime hydration may have replaced these objects.
      resolved = resolveTarget(target);
      message = resolved?.chat.message.find(
        (m) => m.chatId === target.messageId,
      );
      item = message?.illustrations?.find(
        (i) => i.id === target.illustrationId,
      );
      if (!resolved || !item || !message.data.includes(item.token)) return;
    }
    item.version++;
    item.branchId = resolved.chat.activeBranchId;
    item.sourceHash = illustrationSourceHash(message);
    item.status = "queued";
    item.runId = appRunId;
    item.executor = usesAppIllustrationExecutor() ? "app" : "server";
    delete item.error;
    if (action === "rewrite") {
      delete item.tags;
      delete item.prompt;
      delete item.negativePrompt;
    }
    await messageStore.commitMessages(target.chatId, [message], [], true);
    await messageStore.flush();
    void submit(target, item, action);
  } finally {
    actions.delete(key);
  }
}

export async function queryServerIllustration(
  target: IllustrationTarget,
): Promise<IllustrationJobResponse | null> {
  const storage = forageStorage.realStorage;
  if (!(storage instanceof NodeStorage)) return null;
  const query = new URLSearchParams({ ...target });
  const result = await serverRequest(
    storage,
    `/api/illustrations/jobs?${query}`,
  ).catch(() => null);
  if (result) {
    const resolved = resolveTarget(target);
    const resident = resolved?.chat.message.find(
      (m) => m.chatId === target.messageId,
    );
    const item = resident?.illustrations?.find(
      (i) => i.id === target.illustrationId,
    );
    if (resident && item?.version === result.illustration.version) {
      const located = await readIllustrationMessage(storage.sql, target);
      if (
        located &&
        located.branchId === resolved.chat.activeBranchId &&
        illustrationSourceHash(resident) ===
          illustrationSourceHash(located.message)
      ) {
        resident.data = located.message.data;
        resident.illustrations = located.message.illustrations;
      }
    }
  }
  return result;
}

/** Viewing a historical message may mark an abandoned job; it never starts generation. */
export async function recoverIllustration(target: IllustrationTarget) {
  const resolved = resolveTarget(target);
  const message = resolved?.chat.message.find(
    (m) => m.chatId === target.messageId,
  );
  const item = message?.illustrations?.find(
    (i) => i.id === target.illustrationId,
  );
  if (
    !item ||
    !isIllustrationBusy(item.status) ||
    scheduling.has(
      JSON.stringify({
        characterId: target.characterId,
        chatId: target.chatId,
        messageId: target.messageId,
      }),
    ) ||
    submissions.has(illustrationJobKey(target)) ||
    runner.has(target)
  )
    return;
  if (item.executor === "server") {
    await queryServerIllustration(target);
    return;
  }
  if (!runner.has(target)) {
    item.status = "interrupted";
    item.error = "Illustration interrupted. Retry to continue.";
    await messageStore.commitMessages(target.chatId, [message], [], true);
  }
}
