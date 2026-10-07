/**
 * Configures marker instructions, tag generation and optional scene context.
 *
 * 한국어: 표식 지침, 태그 생성 및 장면 문맥 포함 여부를 지정하는 공통 설정.
 *
 * @remarks
 * Credentials and conversation snapshots must never be stored in these settings.
 * 한국어: 인증 정보와 전체 대화 사본을 저장하지 않는 설정 계약.
 */
export interface IllustrationSettings {
  enabled: boolean;
  displayWidth: number;
  recentMessages: number;
  includeDescription: boolean;
  includePersona: boolean;
  includeLorebook: boolean;
  includeMemory: boolean;
  markerInstructions: string;
  tagInstructions: string;
  basePrompt: string;
  negativePrompt: string;
}

/**
 * Provides opt-in defaults with six previous messages and character/persona context.
 *
 * 한국어: 기능 끄기, 이전 메시지 6개, 캐릭터 설명·페르소나 포함을 기본으로 하는 설정.
 */
export const DEFAULT_ILLUSTRATION_SETTINGS: Readonly<IllustrationSettings> = {
  enabled: false,
  displayWidth: 50,
  recentMessages: 6,
  includeDescription: true,
  includePersona: true,
  includeLorebook: false,
  includeMemory: false,
  markerInstructions:
    "Place <Illustration> after an important visual description or scene transition when an illustration would enrich the story. The marker depicts the scene immediately before it. Use the exact marker in narrative text, outside code and reasoning. Do not write image tags yourself.",
  tagInstructions:
    "Describe the scene immediately before the illustration marker using concise English image generation tags. Include the visible characters, appearance, expressions, actions, setting, lighting and composition. Respect the supplied character and persona descriptions. Return only the tags, without commentary or reasoning.",
  basePrompt: "",
  negativePrompt: "",
};

export type IllustrationOverrides = Partial<IllustrationSettings>;
export type IllustrationStatus =
  "queued" | "tagging" | "generating" | "complete" | "failed" | "interrupted";
export type IllustrationAction = "retry" | "regenerate" | "rewrite";

export type IllustrationErrorStage =
  "prepare" | "tags" | "image" | "save" | "status";
export type IllustrationErrorCode =
  | "connection"
  | "timeout"
  | "auth"
  | "rateLimit"
  | "server"
  | "http"
  | "configuration"
  | "contextLimit"
  | "emptyTags"
  | "noImage"
  | "invalidResponse"
  | "unknown";
export interface IllustrationErrorDetails {
  stage: IllustrationErrorStage;
  code: IllustrationErrorCode;
  status?: number;
}

/** Carries safe transport diagnostics without retaining provider bodies or credentials. */
export class IllustrationRequestError extends Error {
  constructor(
    readonly code: IllustrationErrorCode,
    readonly status?: number,
  ) {
    super(
      status ? `Request failed (HTTP ${status})` : `Request failed: ${code}`,
    );
    this.name = "IllustrationRequestError";
  }
}

/** Classifies errors into bounded diagnostics; arbitrary response text is never persisted. */
export function describeIllustrationError(
  error: unknown,
  stage: IllustrationErrorStage,
): IllustrationErrorDetails {
  if (error instanceof IllustrationRequestError)
    return {
      stage,
      code: error.code,
      ...(error.status ? { status: error.status } : {}),
    };
  const value = error as {
    message?: unknown;
    name?: unknown;
    cause?: { code?: unknown };
    status?: unknown;
  } | null;
  const text = (
    typeof error === "string"
      ? error
      : typeof value?.message === "string"
        ? value.message
        : ""
  ).slice(0, 4096);
  let code: IllustrationErrorCode = "unknown";
  if (
    value?.name === "TimeoutError" ||
    /timed?\s*out|timeout|took longer than expected/i.test(text)
  )
    code = "timeout";
  else if (
    /Failed to fetch|fetch failed|NetworkError|Network request failed|Load failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|ERR_CONNECTION/i.test(
      `${text} ${value?.cause?.code ?? ""}`,
    )
  )
    code = "connection";
  else if (
    value?.name === "SyntaxError" ||
    /invalid image data|no accepted image|Cannot read properties|not valid JSON|Unexpected token/i.test(
      text,
    )
  )
    code = "invalidResponse";
  else if (/exceed.*context limit/i.test(text)) code = "contextLimit";
  else if (/no image tags/i.test(text)) code = "emptyTags";
  else if (/returned no image|no result URL/i.test(text)) code = "noImage";
  else if (
    /Invalid URL|URL is not set|enter .*API key|prepared submodel request is missing|cannot prepare a server illustration request|provider is unavailable|provider is not set|unsupported.*provider/i.test(
      text,
    )
  )
    code = "configuration";
  else if (
    /incorrect API key|invalid.api.key|unauthorized|authentication failed/i.test(
      text,
    )
  )
    code = "auth";
  else if (/rate.limit|insufficient.quota|quota exceeded/i.test(text))
    code = "rateLimit";
  if (code !== "unknown") return { stage, code };
  const status =
    typeof value?.status === "number"
      ? value.status
      : Number(
          /\b(?:HTTP|status(?: code)?)\s*[:=]?\s*([45]\d{2})\b/i.exec(
            text,
          )?.[1],
        );
  if (Number.isInteger(status) && status >= 400 && status <= 599)
    return {
      stage,
      status,
      code:
        status === 401 || status === 403
          ? "auth"
          : status === 429
            ? "rateLimit"
            : status >= 500
              ? "server"
              : "http",
    };
  return { stage, code };
}

export function summarizeIllustrationError(error: unknown): string {
  const { code, status } = describeIllustrationError(error, "prepare");
  return `Illustration operation failed: ${code}${status ? ` (HTTP ${status})` : ""}.`;
}

/**
 * Persists one slot's identity, edit guards, progress and reusable generation results.
 *
 * 한국어: 삽화 한 자리의 식별자, 편집 검증 정보, 진행 상태와 재생성 결과를 보관하는 메타데이터.
 *
 * @remarks
 * Keep image bytes, credentials and full scene context outside this record.
 * 한국어: 이미지 바이트·인증 정보·전체 장면 문맥을 제외한 저장 정보.
 */
export interface Illustration {
  id: string;
  token: string;
  status: IllustrationStatus;
  version: number;
  sourceHash: string;
  branchId?: string;
  executor: "app" | "server";
  runId: string;
  tags?: string;
  prompt?: string;
  negativePrompt?: string;
  imageId?: string;
  /** Generated inlay IDs in chronological order, without loading image bytes. */
  imageIds?: string[];
  error?: string;
  errorDetails?: IllustrationErrorDetails;
}

/**
 * Identifies a slot across chat switches using stable IDs rather than array indices.
 *
 * 한국어: 배열 인덱스 대신 안정적인 ID로 채팅 전환 후에도 삽화 자리를 식별하는 대상 정보.
 */
export interface IllustrationTarget {
  characterId: string;
  chatId: string;
  messageId: string;
  illustrationId: string;
}

/**
 * Defines the message fields required by the portable illustration helpers.
 *
 * 한국어: 플랫폼 공통 삽화 로직에 필요한 최소 메시지 필드.
 */
export interface IllustrationMessage {
  role: "user" | "char";
  data: string;
  chatId?: string;
  illustrations?: Illustration[];
}

/**
 * Holds optional scene text temporarily while a job prepares its tag request.
 *
 * 한국어: 작업의 태그 요청을 준비하는 동안만 보관하는 선택적 장면 문맥.
 */
export interface IllustrationContext {
  description?: string;
  persona?: string;
  lorebook?: string;
  memory?: string;
}

/**
 * Represents a provider-neutral message sent to the tag-writing submodel.
 *
 * 한국어: 태그 작성용 보조 모델에 전달하는 제공자 공통 프롬프트 메시지.
 */
export interface IllustrationPromptMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Carries a prepared HTTP submodel request for the lifetime of a server job only.
 *
 * 한국어: 서버 작업 실행 중에만 보관하는 준비된 보조 모델 HTTP 요청.
 *
 * @remarks
 * Headers may contain credentials; never persist this object in message metadata or logs.
 * 한국어: 인증 정보가 포함될 수 있으므로 메시지 메타데이터·로그에 저장 금지.
 */
export interface IllustrationTagRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Requests execution or a user action for a specific version of a persisted slot.
 *
 * 한국어: 저장된 삽화 자리의 특정 작업 버전에 대한 실행·사용자 조작 요청.
 */
export interface IllustrationJobRequest extends IllustrationTarget {
  version: number;
  action?: IllustrationAction;
  tagRequest?: IllustrationTagRequest;
}

/**
 * Returns the server process identity and the slot's latest persisted state.
 *
 * 한국어: 서버 실행 식별자와 삽화 자리의 최신 저장 상태를 전달하는 응답.
 */
export interface IllustrationJobResponse {
  runId: string;
  illustration: Illustration;
}

/**
 * Joins nonempty instruction sections with a blank line.
 *
 * 한국어: 비어 있지 않은 지침 구간을 빈 줄로 연결하는 보조 함수.
 */
const append = (a: string, b: string) => [a, b].filter(Boolean).join("\n\n");

/**
 * Resolves defaults, global settings and character overrides into effective settings.
 *
 * 한국어: 기본값·범용 설정·캐릭터별 변경값으로 실제 적용 설정을 구성하는 함수.
 *
 * @param global - Global settings. / 범용 설정.
 * @param character - Character overrides and appended text. / 캐릭터별 변경값·추가 지침.
 * @returns Settings with appended text and a nonnegative integer history count. / 텍스트를 이어 붙이고 이전 메시지 수를 정규화한 설정.
 * @remarks
 * Scalar fields override inherited values; instruction and prompt fields append character text.
 * 한국어: 단일 값은 상속값을 덮어쓰고, 지침·그림 프롬프트는 범용 내용 뒤에 캐릭터 내용을 추가.
 */
export function resolveIllustrationSettings(
  global?: Partial<IllustrationSettings>,
  character?: IllustrationOverrides,
): IllustrationSettings {
  const base = { ...DEFAULT_ILLUSTRATION_SETTINGS, ...global };
  const result = { ...base, ...character };
  for (const key of [
    "markerInstructions",
    "tagInstructions",
    "basePrompt",
    "negativePrompt",
  ] as const) {
    result[key] = append(base[key] ?? "", character?.[key] ?? "");
  }
  result.recentMessages = Number.isFinite(result.recentMessages)
    ? Math.max(0, Math.floor(result.recentMessages))
    : 6;
  result.displayWidth = Number.isFinite(result.displayWidth)
    ? Math.max(10, Math.min(100, Math.round(result.displayWidth)))
    : DEFAULT_ILLUSTRATION_SETTINGS.displayWidth;
  return result;
}

/**
 * Builds the internal placeholder for an unfinished illustration slot.
 *
 * 한국어: 아직 완성되지 않은 삽화 자리의 내부 대체 토큰을 만드는 함수.
 *
 * @param id - Stable illustration ID. / 안정적인 삽화 ID.
 * @returns The pending-slot token. / 대기 자리 토큰.
 */
export const illustrationToken = (id: string) => `{{illustration::${id}}}`;
/**
 * Checks whether a slot is queued or actively generating tags or an image.
 *
 * 한국어: 삽화가 대기·태그 작성·이미지 생성 중인지 확인하는 함수.
 */
export const isIllustrationBusy = (status: IllustrationStatus) =>
  status === "queued" || status === "tagging" || status === "generating";

/**
 * Finds eligible narrative markers in their order of appearance.
 *
 * 한국어: 본문에서 삽화로 처리할 표식 위치를 등장 순서대로 찾는 함수.
 *
 * @param text - Completed answer text, including all continuations. / 자동 이어쓰기를 포함한 완성 답변.
 * @returns UTF-16 offsets of eligible markers. / 처리 가능한 표식의 UTF-16 위치 목록.
 * @remarks
 * Skips fenced/indented code, matching backtick spans, reasoning/pre/code regions and escaped markers.
 * 한국어: 코드 블록·들여쓴 코드·인라인 코드·사고 및 pre/code 영역·이스케이프 표식은 제외.
 */
export function findIllustrationMarkers(text: string): number[] {
  const positions: number[] = [];
  let fence = "";
  let inline = 0;
  const thoughts: string[] = [];
  for (let i = 0; i < text.length;) {
    if (i === 0 || text[i - 1] === "\n") {
      const line = text.slice(
        i,
        text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i),
      );
      const fenced = /^( {0,3})(`{3,}|~{3,})/.exec(line);
      if (fenced) {
        const run = fenced[2];
        if (!fence) fence = run;
        else if (
          run[0] === fence[0] &&
          run.length >= fence.length &&
          /^\s*$/.test(line.slice(fenced[0].length))
        )
          fence = "";
        i += line.length + (i + line.length < text.length ? 1 : 0);
        continue;
      }
      if (fence || /^( {4}|\t)/.test(line)) {
        i += line.length + (i + line.length < text.length ? 1 : 0);
        continue;
      }
    }
    if (text[i] === "`" && (i === 0 || text[i - 1] !== "\\")) {
      const run = /^`+/.exec(text.slice(i))![0].length;
      if (inline === run) inline = 0;
      else if (!inline) {
        const closing = /`+/g;
        closing.lastIndex = i + run;
        let match: RegExpExecArray | null;
        while ((match = closing.exec(text))) {
          if (match[0].length === run && text[match.index - 1] !== "\\") {
            inline = run;
            break;
          }
        }
      }
      i += run;
      continue;
    }
    if (!inline) {
      const tag =
        /^<(\/)?(thoughts?|think|analysis|reasoning|pre|code)\b[^>]*>/i.exec(
          text.slice(i),
        );
      if (tag) {
        const name = tag[2].toLowerCase();
        if (!tag[1]) thoughts.push(name);
        else if (thoughts.at(-1) === name) thoughts.pop();
        i += tag[0].length;
        continue;
      }
      if (
        !thoughts.length &&
        text.startsWith("<Illustration>", i) &&
        (i === 0 || text[i - 1] !== "\\")
      ) {
        positions.push(i);
        i += "<Illustration>".length;
        continue;
      }
    }
    i++;
  }
  return positions;
}

/**
 * Restores each known pending or completed token to its original narrative marker.
 *
 * 한국어: 알려진 대기·완성 토큰을 원래 표식으로 되돌려 비교용 본문을 만드는 함수.
 *
 * @returns Text whose identity does not change when a slot becomes an inlay. / 삽화가 인레이로 바뀌어도 동일한 비교용 본문.
 */
export function canonicalIllustrationText(
  message: IllustrationMessage,
): string {
  let text = message.data;
  for (const item of message.illustrations ?? []) {
    text = text.replace(item.token, "<Illustration>");
  }
  return text;
}

/**
 * Calculates a compact deterministic fingerprint of the canonical message text.
 *
 * 한국어: 정규화한 메시지 본문의 변경 여부를 확인하는 작은 결정적 지문을 계산하는 함수.
 *
 * @returns Length and two integer hashes for edit detection. / 본문 길이와 편집 감지용 정수 해시 두 개.
 * @remarks
 * This is an edit guard, not a cryptographic hash; it retains no conversation copy.
 * 한국어: 대화 사본을 보관하지 않는 편집 검증값이며 암호학적 해시는 아님.
 */
export function illustrationSourceHash(message: IllustrationMessage): string {
  const text = canonicalIllustrationText(message);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < text.length; i++) {
    a = Math.imul(a ^ text.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ text.charCodeAt(i);
  }
  return `${text.length}:${a >>> 0}:${b >>> 0}`;
}

/**
 * Replaces eligible markers with queued slots and attaches their metadata to the message.
 *
 * 한국어: 처리 가능한 표식을 대기 자리로 교체하고 메시지에 삽화 메타데이터를 추가하는 함수.
 *
 * @param message - Message mutated in place. / 본문·메타데이터를 직접 변경할 메시지.
 * @param branchId - Active branch captured at preparation. / 준비 시점의 활성 분기 ID.
 * @param executor - App or server responsible for execution. / 작업을 실행할 앱 또는 서버.
 * @param runId - Current executor process/session ID. / 현재 실행 주체의 실행 ID.
 * @returns Newly prepared slots in narrative order. / 본문 등장 순서대로 준비한 새 삽화 목록.
 */
export function prepareIllustrations(
  message: IllustrationMessage,
  branchId: string | undefined,
  executor: Illustration["executor"],
  runId: string,
): Illustration[] {
  const positions = findIllustrationMarkers(message.data);
  if (!positions.length) return [];
  const items = positions.map((): Illustration => {
    const id = crypto.randomUUID();
    return {
      id,
      token: illustrationToken(id),
      status: "queued",
      version: 1,
      sourceHash: "",
      branchId,
      executor,
      runId,
    };
  });
  for (let i = positions.length - 1; i >= 0; i--) {
    message.data =
      message.data.slice(0, positions[i]) +
      items[i].token +
      message.data.slice(positions[i] + 14);
  }
  message.illustrations = [...(message.illustrations ?? []), ...items];
  const hash = illustrationSourceHash(message);
  for (const item of items) item.sourceHash = hash;
  return items;
}

/**
 * Rejects stale jobs after a message edit, token removal, version change or branch switch.
 *
 * 한국어: 메시지 편집·토큰 제거·작업 버전 변경·분기 전환으로 무효화된 작업을 판별하는 함수.
 *
 * @returns Whether the version, branch, unique token and source fingerprint still match. / 버전·분기·유일한 토큰·본문 지문의 일치 여부.
 */
export function validIllustration(
  message: IllustrationMessage,
  item: Illustration,
  branchId: string | undefined,
  version: number,
): boolean {
  return (
    item.version === version &&
    item.branchId === branchId &&
    message.data.split(item.token).length === 2 &&
    illustrationSourceHash(message) === item.sourceHash
  );
}

/**
 * Removes reasoning and embedded media markers from text passed to the tag submodel.
 *
 * 한국어: 태그 보조 모델에 전달할 텍스트에서 사고 영역과 미디어 표식을 제거하는 함수.
 */
export function stripIllustrationMedia(text: string): string {
  return text
    .replace(
      /<(thoughts?|think|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi,
      "",
    )
    .replace(
      /{{(?:inlay|inlayed|inlayeddata|illustration)::[^}]+}}|<Illustration>/g,
      "",
    )
    .trim();
}

/**
 * Builds required instructions/current scene separately from removable prior dialogue.
 *
 * 한국어: 필수 지침·현재 장면과 길이 조절 가능한 이전 대화를 분리해 구성하는 함수.
 *
 * @param settings - Effective instructions and context inclusion flags. / 실제 적용 지침·문맥 포함 설정.
 * @param history - Messages preceding the target answer. / 대상 답변 이전의 메시지 목록.
 * @param message - Answer containing this slot. / 해당 삽화 자리가 있는 답변.
 * @param item - Slot whose preceding scene should be illustrated. / 직전 장면을 그릴 삽화 자리.
 * @param context - Captured or reconstructed optional scene information. / 캡처하거나 재구성한 선택 문맥.
 * @returns Required prompt sections and recent dialogue. / 필수 프롬프트 구간과 최근 대화.
 * @throws When the slot token is absent. / 삽화 자리 토큰이 없는 경우.
 * @remarks
 * Only text before the target slot is included from the current answer.
 * 한국어: 현재 답변은 대상 자리 직전까지만 포함하므로 이후 장면은 제외.
 */
export function buildIllustrationPrompt(
  settings: IllustrationSettings,
  history: IllustrationMessage[],
  message: IllustrationMessage,
  item: Illustration,
  context: IllustrationContext,
): {
  required: IllustrationPromptMessage[];
  history: IllustrationPromptMessage[];
} {
  const sections: string[] = [];
  for (const [flag, key, title] of [
    ["includeDescription", "description", "Character"],
    ["includePersona", "persona", "Persona"],
    ["includeLorebook", "lorebook", "Active lorebook"],
    ["includeMemory", "memory", "Used memory"],
  ] as const) {
    if (settings[flag] && context[key])
      sections.push(`${title}:\n${context[key]}`);
  }
  const position = message.data.indexOf(item.token);
  if (position < 0) throw new Error("Illustration position was removed");
  return {
    required: [
      {
        role: "system",
        content: append(settings.tagInstructions, sections.join("\n\n")),
      },
      {
        role: "user",
        content: `Current scene (illustrate its final moment):\n${stripIllustrationMedia(message.data.slice(0, position))}`,
      },
    ],
    history: (settings.recentMessages
      ? history.slice(-settings.recentMessages)
      : []
    ).map((m) => ({
      role: m.role === "char" ? "assistant" : "user",
      content: stripIllustrationMedia(m.data),
    })),
  };
}

/**
 * Drops the oldest dialogue until the prompt and reserved output fit the submodel limit.
 *
 * 한국어: 프롬프트와 출력 예약량이 보조 모델 한도에 들어갈 때까지 오래된 대화부터 줄이는 함수.
 *
 * @param prompt - Required sections and removable history. / 필수 구간과 제거 가능한 이전 대화.
 * @param count - Token counter for the selected submodel. / 선택한 보조 모델의 토큰 계산 함수.
 * @param maxContext - Maximum total context tokens. / 전체 문맥의 최대 토큰 수.
 * @param outputTokens - Reserved output tokens, defaulting to 300. / 출력 예약 토큰 수, 기본값 300.
 * @returns A prompt that fits without truncating required sections. / 필수 구간을 자르지 않고 한도에 맞춘 프롬프트.
 * @throws When instructions and the current scene alone exceed the limit. / 지침과 현재 장면만으로도 한도를 초과하는 경우.
 */
export async function fitIllustrationPrompt(
  prompt: ReturnType<typeof buildIllustrationPrompt>,
  count: (messages: IllustrationPromptMessage[]) => Promise<number>,
  maxContext: number,
  outputTokens = 300,
): Promise<IllustrationPromptMessage[]> {
  const history = [...prompt.history];
  while (true) {
    const messages = [prompt.required[0], ...history, prompt.required[1]];
    if ((await count(messages)) + outputTokens <= maxContext) return messages;
    if (!history.length)
      throw new Error(
        "Illustration instructions and current scene exceed the submodel context limit",
      );
    history.shift();
  }
}

/**
 * Cleans the submodel output into nonempty image tags without reasoning or code wrappers.
 *
 * 한국어: 보조 모델 출력에서 사고·미디어·코드 포장을 제거해 그림 태그를 추출하는 함수.
 *
 * @throws When no tags remain. / 정리 후 태그가 남지 않는 경우.
 */
export function cleanIllustrationTags(text: string): string {
  const tags = stripIllustrationMedia(text)
    .replace(/^```(?:\w+)?\s*|\s*```$/g, "")
    .trim();
  if (!tags) throw new Error("The submodel returned no image tags");
  return tags;
}

/**
 * Serializes work within one executor and deduplicates pending jobs by key.
 *
 * 한국어: 실행 주체 하나의 작업을 순차 처리하고 같은 키의 대기 작업을 합치는 큐.
 *
 * @remarks
 * A failed task does not block later jobs; duplicate submissions share the same promise.
 * 한국어: 실패한 작업이 후속 작업을 막지 않으며 중복 요청은 같은 Promise를 공유.
 */
export class IllustrationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<void>>();
  /**
   * Checks whether an exact job key is queued or running.
   *
   * 한국어: 특정 작업 키가 대기·실행 중인지 확인하는 메서드.
   */
  has(key: string): boolean {
    return this.pending.has(key);
  }
  /**
   * Checks for pending versions sharing a target-key prefix.
   *
   * 한국어: 대상 키 접두사를 공유하는 작업 버전이 대기·실행 중인지 확인하는 메서드.
   */
  hasPrefix(prefix: string): boolean {
    for (const key of this.pending.keys())
      if (key.startsWith(prefix)) return true;
    return false;
  }
  /**
   * Queues work after earlier jobs or returns the existing promise for the same key.
   *
   * 한국어: 앞선 작업 뒤에 실행을 예약하거나 같은 키의 기존 Promise를 반환하는 메서드.
   *
   * @param key - Deduplication key including the job version. / 작업 버전을 포함한 중복 방지 키.
   * @param work - Work executed when earlier jobs settle. / 앞선 작업 종료 후 실행할 함수.
   * @returns Completion of this work; its failure does not stop the queue. / 해당 작업의 완료 Promise, 실패해도 큐는 계속 진행.
   */
  enqueue(key: string, work: () => Promise<void>): Promise<void> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.tail
      .catch(() => {})
      .then(work)
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, task);
    this.tail = task.catch(() => {});
    return task;
  }
}
