import {
  buildIllustrationPrompt,
  findIllustrationMarkers,
  fitIllustrationPrompt,
  illustrationSourceHash,
  isIllustrationBusy,
  needsIllustrationTags,
  prepareIllustrations,
  prepareIllustrationRegeneration,
  retainIllustrationImageTags,
  resolveIllustrationSettings,
  validIllustration,
  describeIllustrationError,
  IllustrationRequestError,
  summarizeIllustrationError,
  type Illustration,
  type IllustrationAction,
  type IllustrationContext,
  type IllustrationJobRequest,
  type IllustrationJobResponse,
  type IllustrationTarget,
  IllustrationQueue,
} from "@risuai/protocol/dist/illustration.mjs";
import { applyIllustrationProgress } from "./illustrationProgress";
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
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["haejeok-risuai", "illustration"]);
const appRunId = v4();
const contexts = new Map<string, IllustrationContext>();
const scheduling = new Set<string>();
const submissions = new Set<string>();
const actions = new Set<string>();
const serverSubmissions = new IllustrationQueue();

/**
 * Resolves a stable chat target from the currently resident character store.
 *
 * 한국어: 안정적인 대상 ID로 현재 캐릭터 저장소에 적재된 채팅을 찾는 함수.
 * @deprecated 중복
 * @returns A one-to-one character/chat pair, or null for groups or missing targets. / 1:1 캐릭터·채팅 쌍 또는 그룹·삭제된 대상일 때 null.
 */
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

/**
 * Reads the target character's current effective illustration settings.
 *
 * 한국어: 대상 캐릭터의 현재 범용·개별 설정을 합쳐 실제 삽화 설정을 읽는 함수.
 *
 * @throws When the resident chat no longer exists. / 적재된 대상 채팅이 사라진 경우.
 */
function getSettings(target: IllustrationTarget) {
  if (!settingsStore.state.useChatIllustrations)
    throw new Error("Chat illustrations are disabled");
  const resolved = resolveTarget(target);
  if (!resolved) throw new Error("The illustration chat was removed");
  return resolveIllustrationSettings(
    settingsStore.state.illustration,
    resolved.char.illustration,
  );
}

/**
 * Persists a slot transition against fresh SQL data and mirrors it to a matching resident message.
 *
 * 한국어: 최신 SQL 데이터를 검증해 삽화 상태 변경을 저장하고 일치하는 적재 메시지에도 반영하는 함수.
 *
 * @param target - Stable slot identifiers. / 안정적인 삽화 대상 ID.
 * @param version - Expected job version. / 일치해야 하는 작업 버전.
 * @param change - Mutation applied to a validated record. / 검증한 정보에 적용할 변경 함수.
 * @returns Updated record, or null for an edited, deleted or switched target. / 갱신 정보 또는 편집·삭제·분기 전환 시 null.
 * @remarks
 * Rechecks resident edits after asynchronous reads and rebuilds changes on SQL revision conflicts.
 * 한국어: 비동기 조회 후 메모리상의 편집을 다시 확인하고 SQL 리비전 충돌 시 변경을 새로 준비.
 */
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
    item.progress = (item.progress ?? 0) + 1;
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

/**
 * Prepares a bounded submodel prompt for this slot using captured or historical context.
 *
 * 한국어: 캡처한 문맥 또는 과거 장면 문맥으로 해당 자리의 보조 모델 요청을 한도에 맞춰 준비하는 함수.
 *
 * @remarks
 * Automatic jobs reuse the answer's actual lore/memory; explicit rewrites reconstruct current context.
 * Token counting uses the selected submodel without changing the global model preset.
 * 한국어: 자동 작업은 답변의 실제 로어·메모리를 재사용하고 명시적 재작성은 현재 설정으로 문맥을 재구성.
 * 범용 모델 프리셋을 바꾸지 않고 선택한 보조 모델로 토큰 수를 계산.
 */
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

/**
 * Selects app execution for local storage or browser-only Plugin/WebLLM submodels.
 *
 * 한국어: 로컬 저장소 또는 브라우저 전용 Plugin·WebLLM 보조 모델이면 앱 실행을 선택하는 함수.
 *
 * @returns False only when Node storage can use a server-capable submodel. / Node 저장소에서 서버 지원 보조 모델을 사용하는 경우에만 false.
 */
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
  generationCount: async (target) => getSettings(target).generationCount,
  tagRequestMode: async (target) => getSettings(target).tagRequestMode,
  update,
  /**
   * Calls the submodel and flattens supported nonstreaming tag responses.
   *
   * 한국어: 보조 모델을 호출하고 지원되는 비스트리밍 태그 응답을 하나의 텍스트로 합치는 함수.
   */
  createTags: async (target, record) => {
    const response = await requestChatDataMain(
      await tagArguments(target, record),
      "submodel",
    );
    if (response.type === "multiline")
      return response.result.map((entry) => entry[1]).join("\n");
    if (response.type !== "success")
      throw new Error(
        response.type === "fail"
          ? response.result
          : "The submodel returned no image tags",
      );
    return response.result;
  },
  /**
   * Combines scene tags with the target's current independent illustration prompts.
   *
   * 한국어: 장면 태그에 대상의 현재 삽화 전용 기본·네거티브 프롬프트를 적용하는 함수.
   */
  prompts: async (tags, target) => {
    const settings = getSettings(target);
    return {
      prompt: [settings.basePrompt, tags].filter(Boolean).join(", "),
      negativePrompt: settings.negativePrompt,
    };
  },
  /**
   * Lazily loads the image core/browser adapter and generates an image for the latest character.
   *
   * 한국어: 이미지 공통 로직·브라우저 어댑터를 지연 로딩해 최신 대상 캐릭터의 그림을 생성하는 함수.
   */
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
  /**
   * Validates a base64 image data URL and durably saves it as an inlay before returning its ID.
   *
   * 한국어: Base64 그림 데이터 URL을 검증하고 인레이 영구 저장 후 ID를 반환하는 함수.
   */
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
  /**
   * Lazily loads asset cleanup for a newly orphaned inlay.
   *
   * 한국어: 새로 생긴 미사용 인레이를 정리하는 자산 모듈을 지연 로딩하는 함수.
   */
  removeImage: async (id) => {
    const { removeInlayAsset } = await import("../files/inlays");
    await removeInlayAsset(id);
  },
  /**
   * Keeps allowlisted actionable errors and hides provider responses that may contain credentials.
   *
   * 한국어: 허용한 해결 가능한 오류만 남기고 인증 정보가 포함될 수 있는 제공자 응답을 숨기는 함수.
   */
  summarizeError: summarizeIllustrationError,
});

/**
 * Sends an authenticated illustration API request and checks its response shape.
 *
 * 한국어: 인증된 삽화 API 요청을 보내고 응답 형식을 확인하는 함수.
 *
 * @param storage - Node storage owning the API client and authentication. / API 클라이언트·인증을 소유한 Node 저장소.
 * @param path - Illustration API path. / 삽화 API 경로.
 * @param body - Optional POST body; omission selects GET. / POST 본문, 생략 시 GET 요청.
 * @returns Server execution identity and slot state. / 서버 실행 식별자·삽화 상태.
 * @throws When the request fails or the response lacks required fields. / 요청 실패 또는 필수 응답 필드 누락 시.
 */
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
  if (!response.ok)
    throw new IllustrationRequestError(
      describeIllustrationError({ status: response.status }, "prepare").code,
      response.status,
    );
  const data = await response.json();
  if (!data.illustration || typeof data.runId !== "string")
    throw new Error("Invalid illustration server response");
  return data;
}

/**
 * Deduplicates and dispatches a slot version to the app queue or detached Node queue.
 *
 * 한국어: 삽화 버전의 중복 요청을 막고 앱 큐 또는 독립 Node 큐로 보내는 함수.
 *
 * @remarks
 * Prepares server tag requests sequentially and releases captured context after dispatch/execution.
 * A lost acceptance response queries server state rather than overwriting a potentially running job.
 * 한국어: 서버 태그 요청을 순차 준비하고 전송·실행 종료 후 캡처 문맥을 해제.
 * 접수 응답 유실 시 서버 상태를 조회해 실행 중일 수 있는 작업을 실패 상태로 덮어쓰지 않는 방식.
 */
async function submit(
  target: IllustrationTarget,
  item: Illustration,
  action?: IllustrationAction,
  selectedImageId?: string,
) {
  const key = illustrationJobKey(target);
  if (!settingsStore.state.useChatIllustrations) {
    contexts.delete(key);
    return;
  }
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
        if (
          needsIllustrationTags(
            record.item,
            getSettings(target).generationCount,
            action,
          )
        ) {
          const response = await requestChatDataMain(
            { ...(await tagArguments(target, record)), previewBody: true },
            "submodel",
          );
          if (response.type !== "success")
            throw new Error(
              response.type === "fail"
                ? response.result
                : "Unable to prepare the submodel request",
            );
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
          selectedImageId,
        } satisfies IllustrationJobRequest);
        // SQL realtime events carry all later progress, including completion after this client exits.
      });
    } else {
      await runner.run(target, item.version);
    }
  } catch (error) {
    // An accepted server job outlives this request; a lost response must not fail it.
    if (serverDispatched) {
      const recovered = await queryServerIllustration(target);
      if (
        recovered ||
        !(error instanceof IllustrationRequestError) ||
        !error.status ||
        error.status >= 500
      )
        return;
    }
    await update(target, item.version, ({ item }) => {
      item.status = "failed";
      item.error = summarizeIllustrationError(error);
      item.errorDetails = describeIllustrationError(error, "prepare");
    });
  } finally {
    submissions.delete(key);
    contexts.delete(key);
  }
}

/**
 * Prepares and schedules all markers only after a new one-to-one answer has fully completed.
 *
 * 한국어: 새 1:1 답변이 완전히 끝난 뒤 모든 삽화 표식을 준비하고 실행을 예약하는 함수.
 *
 * @param target - IDs captured for the completed answer. / 완성된 답변에서 캡처한 대상 ID.
 * @param context - Description/persona and actual lore/memory from that generation. / 해당 생성에서 사용한 설명·페르소나·실제 로어·메모리.
 * @throws When the initial character, chat or message lookup fails. / 최초 캐릭터·채팅·메시지 조회 실패 시.
 * @remarks
 * Flushes the answer first, revalidates its text/branch, then durably commits tokens before queueing.
 * Submits background jobs without awaiting image completion so subsequent chats remain available.
 * 한국어: 답변 저장 후 본문·분기를 다시 확인하고 대기 토큰을 영구 저장한 뒤 큐에 등록.
 * 그림 완료를 기다리지 않는 백그라운드 작업으로 다음 채팅을 허용.
 */
export async function enqueueAnswerIllustrations(
  target: Omit<IllustrationTarget, "illustrationId">,
  context: IllustrationContext,
) {
  if (!settingsStore.state.useChatIllustrations) return;
  const answerKey = JSON.stringify(target);
  if (scheduling.has(answerKey)) return;
  scheduling.add(answerKey);
  try {
    let targetChar = characterStore.getById(target.characterId);
    if (!targetChar) {
      throw new Error(
        `Illustration character not found: ${target.characterId}`,
      );
    }

    if (targetChar.type === "group") {
      logger.warn(`targetChar type is group: ${targetChar.chaId}`);
      return;
    }
    let targetChat = targetChar.chats?.find(
      (chat) => chat.id === target.chatId,
    );
    if (!targetChat) {
      throw new Error(`Illustration chat not found: ${target.chatId}`);
    }
    let targetMessage = targetChat.message.find(
      (message) => message.chatId === target.messageId,
    );
    if (!targetMessage) {
      throw new Error(`Illustration message not found: ${target.messageId}`);
    }

    //TODO 이 조건문은 enqueueAnswerIllustrations 함수 불러오기전에 했어야 합니다.
    // if (
    //   targetMessage.role !== "char" ||
    //   !resolveIllustrationSettings(
    //     settingsStore.state.illustration,
    //     targetChar.illustration,
    //   ).enabled
    // )
    // return;
    if (!findIllustrationMarkers(targetMessage.data).length) return;
    const items = prepareIllustrations(
      targetMessage,
      targetChat.activeBranchId,
      usesAppIllustrationExecutor() ? "app" : "server",
      appRunId,
    );
    await messageStore.commitMessages(target.chatId, [targetMessage], [], true);
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

/**
 * Starts an explicit retry, same-tag regeneration or full tag rewrite for a slot.
 *
 * 한국어: 삽화 자리의 재시도·같은 태그 재생성·태그부터 다시 작성을 시작하는 함수.
 *
 * @param target - Stable slot identifiers. / 안정적인 삽화 대상 ID.
 * @param action - Requested retry/regenerate/rewrite operation. / 재시도·재생성·태그 재작성 조작.
 * @remarks
 * Deduplicates clicks, increments the version and keeps the old image until replacement succeeds.
 * Regeneration uses the selected image's saved tags; rewriting requests new tags.
 * The new task uses the currently selected executor.
 * 한국어: 중복 클릭 방지·버전 증가 후 교체 성공까지 기존 그림을 유지.
 * 재생성은 선택한 그림의 저장된 태그를 사용하고 재작성은 새 태그를 요청.
 * 새 작업은 현재 선택한 실행 주체를 사용.
 */
export async function illustrationAction(
  target: IllustrationTarget,
  action: IllustrationAction,
  selectedImageId?: string,
) {
  if (!settingsStore.state.useChatIllustrations) return;
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
    if (action === "regenerate")
      prepareIllustrationRegeneration(
        item,
        selectedImageId,
        getSettings(target).generationCount,
      );
    item.version++;
    if (action === "retry" && item.batch) item.batch.version = item.version;
    item.branchId = resolved.chat.activeBranchId;
    item.sourceHash = illustrationSourceHash(message);
    item.status = "queued";
    item.runId = appRunId;
    item.executor = usesAppIllustrationExecutor() ? "app" : "server";
    delete item.error;
    delete item.errorDetails;
    if (action === "rewrite") {
      retainIllustrationImageTags(item);
      delete item.batch;
      delete item.tags;
      delete item.prompt;
      delete item.negativePrompt;
    }
    await messageStore.commitMessages(target.chatId, [message], [], true);
    await messageStore.flush();
    void submit(target, item, action, selectedImageId);
  } finally {
    actions.delete(key);
  }
}

/**
 * Queries Node job state and refreshes the resident message only when version/branch/text still match.
 *
 * 한국어: Node 작업 상태를 조회하고 버전·분기·본문이 일치할 때만 적재 메시지를 갱신하는 함수.
 *
 * @returns Server state, or null outside Node storage or when the API request fails. / 서버 상태 또는 Node 저장소가 아니거나 API 요청 실패 시 null.
 */
const statusQueries = new Map<string, Promise<IllustrationJobResponse>>();

export async function queryServerIllustration(
  target: IllustrationTarget,
  throwOnFailure = false,
): Promise<IllustrationJobResponse | null> {
  const storage = forageStorage.realStorage;
  if (!(storage instanceof NodeStorage)) return null;
  const key = illustrationJobKey(target);
  let task = statusQueries.get(key);
  if (!task) {
    task = (async () => {
      const query = new URLSearchParams({ ...target });
      const result = await serverRequest(
        storage,
        `/api/illustrations/jobs?${query}`,
      );
      // Re-resolve after the request: SSE hydration may have replaced the message.
      const resolved = resolveTarget(target);
      const resident = resolved?.chat.message.find(
        (m) => m.chatId === target.messageId,
      );
      if (resident)
        applyIllustrationProgress(
          resident,
          result.illustration,
          resolved.chat.activeBranchId,
        );
      return result;
    })().finally(() => {
      statusQueries.delete(key);
    });
    statusQueries.set(key, task);
  }
  return task.catch((error) => {
    if (throwOnFailure) throw error;
    return null;
  });
}

/** Refreshes only an already resident slot when its server commit notification arrives. */
const progressRefreshes = new Map<
  string,
  { dirty: boolean; task: Promise<void> }
>();

export function refreshServerIllustration(
  target: IllustrationTarget,
): Promise<void> {
  const resolved = resolveTarget(target);
  const item = resolved?.chat.message
    .find((m) => m.chatId === target.messageId)
    ?.illustrations?.find((i) => i.id === target.illustrationId);
  if (item?.executor !== "server") return Promise.resolve();
  const key = illustrationJobKey(target);
  const pending = progressRefreshes.get(key);
  if (pending) {
    pending.dirty = true;
    return pending.task;
  }
  const refresh = { dirty: false, task: Promise.resolve() };
  refresh.task = (async () => {
    do {
      refresh.dirty = false;
      await queryServerIllustration(target);
    } while (refresh.dirty);
  })().finally(() => {
    progressRefreshes.delete(key);
  });
  progressRefreshes.set(key, refresh);
  return refresh.task;
}

/**
 * Reconciles a busy slot on view without automatically starting a generation request.
 *
 * 한국어: 화면에 보인 처리 중 삽화의 상태를 확인하되 자동 생성 요청은 시작하지 않는 함수.
 *
 * @remarks
 * Polls server jobs and marks abandoned app jobs interrupted so the user can retry explicitly.
 * 한국어: 서버 작업은 조회하고 중단된 앱 작업은 interrupted로 표시해 사용자 재시도를 기다리는 방식.
 */
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
    await queryServerIllustration(target, true);
    return;
  }
  if (!runner.has(target)) {
    item.status = "interrupted";
    item.error = "Illustration interrupted. Retry to continue.";
    delete item.errorDetails;
    await messageStore.commitMessages(target.chatId, [message], [], true);
  }
}
