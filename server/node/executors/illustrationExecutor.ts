import { randomUUID } from "node:crypto";
import {
  isIllustrationBusy,
  needsIllustrationTags,
  resolveIllustrationSettings,
  illustrationSourceHash,
  describeIllustrationError,
  IllustrationRequestError,
  summarizeIllustrationError,
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

/**
 * Extends paged message reads with settings, character metadata and SQL revisions.
 *
 * 한국어: 메시지 페이지 조회에 설정·캐릭터 메타데이터·SQL 리비전 조회를 추가한 서버 저장소 계약.
 */
type Storage = IllustrationStorageReader & {
  /**
   * Loads character metadata used to validate chat ownership and generation settings.
   *
   * 한국어: 채팅 소속·생성 설정 검증에 사용할 캐릭터 메타데이터를 읽는 함수.
   */
  loadCharacter(id: string): Promise<any>;
  /**
   * Reads one setting without retaining the full application database.
   *
   * 한국어: 앱 데이터베이스 전체를 보관하지 않고 설정 한 항목을 읽는 함수.
   */
  loadSettingKey(key: string): Promise<{ value: unknown }>;
  /**
   * Reads the SQL revision used to reject stale message commits.
   *
   * 한국어: 오래된 메시지 저장을 거부하기 위한 SQL 리비전을 읽는 함수.
   */
  getStorageSyncSummary(): Promise<{ revision: number }>;
};

/**
 * Injects server persistence and image transport.
 *
 * 한국어: 서버 저장·이미지 전송을 주입하는 의존성 계약.
 */
interface Dependencies {
  /**
   * Resolves the currently active SQL storage backend.
   *
   * 한국어: 현재 활성 SQL 저장소를 찾는 함수.
   */
  getStorage(): Storage;
  /**
   * Commits a revision-guarded mutation through the existing SQL notification path.
   *
   * 한국어: 기존 SQL 변경 알림 경로로 리비전 검증 변경을 저장하는 함수.
   */
  commit(payload: unknown): Promise<unknown>;
  imageRuntime: ImageGenerationRuntime;
  /**
   * Saves image data durably and returns its inlay ID.
   *
   * 한국어: 이미지 데이터를 영구 저장하고 인레이 ID를 반환하는 함수.
   */
  storeImage(data: string): Promise<string>;
  /**
   * Removes a newly stored image when its message update is invalidated.
   *
   * 한국어: 메시지 갱신이 무효화된 새 그림을 제거하는 함수.
   */
  removeImage(id: string): Promise<void>;
  fetchImpl?: typeof fetch;
  onProgress?(target: IllustrationTarget): void;
}

// Include jobs still awaiting SQL acceptance so that chain cannot retain unlimited bodies.
const MAX_PENDING_JOBS = 8;
const MAX_PENDING_REQUEST_BYTES = 32 * 1024 * 1024;
const MAX_TAG_REQUEST_BYTES = 16 * 1024 * 1024;

class IllustrationQueueFullError extends Error {
  constructor() {
    super("Illustration queue is full. Retry after pending jobs finish.");
  }
}

/**
 * Validates all target IDs at the HTTP boundary and copies only accepted fields.
 *
 * 한국어: HTTP 입력의 대상 ID를 검증하고 허용된 필드만 복사하는 함수.
 *
 * @throws For missing, oversized or control-character-containing IDs. / 누락·길이 초과·제어 문자 포함 ID 입력 시.
 */
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

/**
 * Extracts tag text from supported provider response shapes, excluding thinking blocks.
 *
 * 한국어: 지원하는 제공자 응답 형식에서 사고 블록을 제외한 태그 텍스트를 추출하는 함수.
 *
 * @param data - Parsed JSON response from the submodel. / 보조 모델의 파싱된 JSON 응답.
 * @returns Joined visible text; the shared runner performs final tag cleanup. / 화면용 텍스트를 합친 결과, 최종 태그 정리는 공통 실행기에서 처리.
 * @throws When no supported text field or block list exists. / 지원하는 텍스트 필드·블록 목록이 없는 경우.
 */
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

/**
 * Creates a detached server illustration queue independent of the main chat job lock.
 *
 * 한국어: 메인 채팅 작업 잠금과 독립적으로 실행되는 서버 삽화 큐를 만드는 함수.
 *
 * @param deps - SQL, transport and asset storage adapters. / SQL·전송·자산 저장 어댑터.
 * @returns Job acceptance, state queries, route registration and pending-job checks. / 작업 접수·상태 조회·라우트 등록·대기 작업 조회 기능.
 * @remarks
 * Accepted jobs outlive the client connection. Prepared requests, including credentials, stay in RAM
 * only until completion; persisted metadata contains progress and results, not those requests.
 * 한국어: 접수 작업은 클라이언트 연결 종료 후에도 계속 진행.
 * 인증 정보를 포함한 준비 요청은 종료까지 메모리에만 보관하며 저장 메타데이터에는 상태·결과만 기록.
 */
export function createNodeIllustrationExecutor(deps: Dependencies) {
  const runId = randomUUID();
  const inputs = new Map<string, IllustrationTagRequest | undefined>();
  const accepting = new Set<string>();
  let acceptance: Promise<unknown> = Promise.resolve();
  let pendingJobs = 0;
  let pendingRequestBytes = 0;

  /**
   * Reloads and commits a slot transition, retrying up to five times on SQL revision conflicts.
   *
   * 한국어: 삽화 상태 변경을 다시 읽어 저장하고 SQL 리비전 충돌 시 최대 5회 시도하는 함수.
   *
   * @param target - Stable slot identifiers. / 안정적인 삽화 대상 ID.
   * @param version - Expected persisted version. / 일치해야 하는 저장 버전.
   * @param change - Transition applied to the latest loaded record. / 최신 정보에 적용할 상태 변경.
   * @param interrupt - Allows recovery/actions to bypass text/branch guards while retaining the version check. / 복구·조작 시 버전 검증은 유지하고 본문·분기 검증을 생략할지 여부.
   * @returns Updated record, or null if missing or invalidated. / 갱신 정보 또는 대상 누락·무효화 시 null.
   */
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
      const previousImageId = item.imageId;
      const previousStatus = item.status;
      change(record);
      item.progress = (item.progress ?? 0) + 1;
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
        if (
          item.imageId !== previousImageId ||
          (item.status !== previousStatus && !isIllustrationBusy(item.status))
        ) {
          try {
            deps.onProgress?.(target);
          } catch (error) {
            console.warn("Illustration progress notification failed", error);
          }
        }
        return record;
      } catch (error) {
        if (!Number.isSafeInteger(error?.currentRevision) || attempt === 4)
          throw error;
      }
    }
    return null;
  }

  /**
   * Checks character/chat ownership and resolves current global/character illustration settings.
   *
   * 한국어: 캐릭터·채팅 소속을 검증하고 현재 범용·캐릭터 삽화 설정을 합치는 함수.
   *
   * @throws For deleted targets or unsupported group chats. / 삭제된 대상 또는 지원하지 않는 그룹 채팅인 경우.
   */
  async function settings(target: IllustrationTarget) {
    const storage = deps.getStorage();
    if ((await storage.loadSettingKey("useChatIllustrations")).value !== true)
      throw new TypeError("Chat illustrations are disabled");
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
        (await storage.loadSettingKey("illustration")).value as any,
        char.illustration,
      ),
    };
  }

  const runner = createIllustrationRunner({
    update,
    generationCount: async (target) =>
      (await settings(target)).illustration.generationCount,
    tagRequestMode: async (target) =>
      (await settings(target)).illustration.tagRequestMode,
    /**
     * Executes the transient submodel request, including Echo delays and Horde result polling.
     *
     * 한국어: 작업 중 임시 보관한 보조 모델 요청을 실행하고 Echo 지연·Horde 결과 조회도 처리하는 함수.
     */
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
      if (!response.ok)
        throw new IllustrationRequestError(
          describeIllustrationError({ status: response.status }, "tags").code,
          response.status,
        );
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
          if (!status.ok)
            throw new IllustrationRequestError(
              describeIllustrationError({ status: status.status }, "tags").code,
              status.status,
            );
          const result = await status.json();
          if (result.faulted) throw new Error("The submodel job failed");
          if (result.done) return decodeIllustrationTagResponse(result);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        throw new Error("The submodel job timed out");
      }
      return decodeIllustrationTagResponse(data);
    },
    /**
     * Applies current illustration base/negative prompts to generated scene tags.
     *
     * 한국어: 생성된 장면 태그에 현재 삽화 기본·네거티브 프롬프트를 적용하는 함수.
     */
    prompts: async (tags, target) => {
      const { illustration } = await settings(target);
      return {
        prompt: [illustration.basePrompt, tags].filter(Boolean).join(", "),
        negativePrompt: illustration.negativePrompt,
      };
    },
    /**
     * Reads only image-provider settings and invokes the shared core with the Node runtime.
     *
     * 한국어: 이미지 제공자 설정만 읽어 Node 실행 어댑터로 공통 그림 생성 로직을 호출하는 함수.
     */
    createImage: async (prompt, negative, target) => {
      const { char } = await settings(target);
      const storage = deps.getStorage();
      const imageSettings: ImageGenerationSettings = Object.fromEntries(
        await Promise.all(
          IMAGE_GENERATION_SETTING_KEYS.map(async (key) => [
            key,
            (await storage.loadSettingKey(key)).value,
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
    /**
     * Persists allowlisted summaries while hiding arbitrary provider responses and secrets.
     *
     * 한국어: 허용된 오류 요약만 저장하고 임의의 제공자 응답·인증 정보를 숨기는 함수.
     */
    summarizeError: summarizeIllustrationError,
  });

  /**
   * Returns persisted job state and marks server work absent from this process as interrupted.
   *
   * 한국어: 저장된 작업 상태를 반환하고 현재 프로세스에 없는 서버 작업을 중단 상태로 표시하는 함수.
   *
   * @remarks
   * Does not restart jobs after a server restart; retries require an explicit action.
   * 한국어: 서버 재시작 후 자동 재실행 없이 명시적 재시도를 기다리는 방식.
   */
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
          delete item.errorDetails;
        },
        true,
      );
      item = interrupted?.item ?? item;
    }
    return { runId, illustration: item };
  }

  /**
   * Serializes request acceptance, validates inputs and starts detached versioned work.
   *
   * 한국어: 요청 접수를 순차 처리하고 입력 검증 후 독립적인 버전별 작업을 시작하는 함수.
   *
   * @param raw - Submitted target, version, action and optional prepared tag request. / 요청 대상·버전·조작·선택적 준비 태그 요청.
   * @returns Accepted persisted state without waiting for generation completion. / 생성 완료를 기다리지 않는 접수 상태 응답.
   * @remarks
   * Repeated initial submissions reuse existing terminal/pending work. Validates headers,
   * body and request size; forces nonstreaming tags and releases transient requests after completion.
   * 한국어: 반복된 최초 접수는 기존 완료·실패·대기 작업을 재사용.
   * 헤더·본문·요청 크기 검증 후 비스트리밍 태그 작성으로 고정하고 종료 후 임시 요청을 해제.
   */
  function accept(
    raw: IllustrationJobRequest,
  ): Promise<IllustrationJobResponse> {
    let requestBytes: number;
    try {
      if (pendingJobs >= MAX_PENDING_JOBS)
        throw new IllustrationQueueFullError();
      requestBytes = Buffer.byteLength(JSON.stringify(raw));
      if (requestBytes > MAX_TAG_REQUEST_BYTES + 4096)
        throw new TypeError("Illustration request exceeds 16 MiB");
      if (pendingRequestBytes + requestBytes > MAX_PENDING_REQUEST_BYTES)
        throw new IllustrationQueueFullError();
    } catch (error) {
      return Promise.reject(error);
    }
    pendingJobs++;
    pendingRequestBytes += requestBytes;
    let handedToRunner = false;
    const release = () => {
      pendingJobs--;
      pendingRequestBytes -= requestBytes;
    };
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
        const { illustration } = await settings(target);
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
          request = {
            url: raw.tagRequest.url,
            headers,
            body: { ...raw.tagRequest.body },
          };
          if ("stream" in request.body) request.body.stream = false;
          if (
            Buffer.byteLength(JSON.stringify(request)) > MAX_TAG_REQUEST_BYTES
          )
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
                if (raw.action === "retry" && item.batch)
                  item.batch.version = item.version;
                item.branchId = branchId;
                item.sourceHash = illustrationSourceHash(message);
                if (raw.action === "rewrite") {
                  delete item.batch;
                  delete item.tags;
                  delete item.prompt;
                  delete item.negativePrompt;
                }
              }
              if (
                needsIllustrationTags(
                  item,
                  illustration.generationCount,
                  raw.action,
                ) &&
                !request
              )
                throw new TypeError("A prepared submodel request is required");
              Object.assign(item, { runId, status: "queued" });
              delete item.error;
              delete item.errorDetails;
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
        handedToRunner = true;
        void runner.run(target, record.item.version).finally(() => {
          inputs.delete(key);
          release();
        });
        accepting.delete(illustrationJobKey(target));
        return { runId, illustration: record.item };
      })
      .finally(() => {
        if (!handedToRunner) release();
      });
    acceptance = task.catch(() => {});
    return task;
  }

  /**
   * Registers authenticated create/retry/query routes with caller-provided request guards.
   *
   * 한국어: 전달받은 요청 보호 미들웨어와 인증으로 삽화 생성·재시도·조회 라우트를 등록하는 함수.
   *
   * @param app - Express-compatible HTTP application. / Express 호환 HTTP 앱.
   * @remarks
   * Uses the supplied authentication, optional limiter and JSON parser. Accepted POST requests
   * return HTTP 202; untrusted internal errors are replaced by safe messages.
   * 한국어: 전달한 인증·선택적 요청 제한·JSON 파서를 사용.
   * 접수된 POST 요청은 HTTP 202를 반환하고 내부 오류 내용은 안전한 안내로 대체.
   */
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
            .status(
              error instanceof IllustrationQueueFullError
                ? 429
                : error instanceof TypeError
                  ? 400
                  : 500,
            )
            .send({
              error:
                error instanceof TypeError ||
                error instanceof IllustrationQueueFullError
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
