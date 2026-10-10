import { Buffer } from "buffer";
import {
  describeIllustrationError,
  IllustrationRequestError,
} from "./illustration.ts";

/**
 * Supplies platform-specific HTTP, reference-image and ZIP processing to the provider core.
 *
 * 한국어: 제공자 공통 로직에 플랫폼별 HTTP·참조 이미지·ZIP 처리를 제공하는 실행 계약.
 */
export interface ImageGenerationRuntime {
  /**
   * Sends a JSON request and returns parsed provider data or raw image bytes.
   *
   * 한국어: JSON 요청을 보내 파싱한 제공자 응답 또는 이미지 원시 바이트를 반환하는 함수.
   */
  fetchJson(
    url: string,
    options: {
      body?: any;
      headers?: Record<string, string>;
      method?: string;
      rawResponse?: boolean;
    },
  ): Promise<{
    ok: boolean;
    data: any;
    status?: number;
    headers?: Record<string, string>;
  }>;
  /**
   * Sends a native/raw request, including multipart bodies and image downloads.
   *
   * 한국어: 멀티파트 본문·그림 다운로드를 포함한 네이티브·원시 요청을 보내는 함수.
   */
  fetchNative(url: string, options?: RequestInit): Promise<Response>;
  /**
   * Reads a stored reference or character image by asset path.
   *
   * 한국어: 자산 경로로 저장된 참조·캐릭터 이미지를 읽는 함수.
   */
  readImage(path?: string): Promise<Uint8Array | null>;
  /**
   * Fits base64 reference bytes into the provider's required reference canvas.
   *
   * 한국어: Base64 참조 그림을 제공자가 요구하는 참조 캔버스에 맞추는 함수.
   */
  resizeReference(base64: string): Promise<string>;
  /**
   * Extracts image data from a provider's ZIP response.
   *
   * 한국어: 제공자의 ZIP 응답에서 이미지 데이터를 추출하는 함수.
   */
  unzipImage(data: Uint8Array): Promise<string>;
}

/**
 * Collects existing image-provider configuration independently of illustration instructions.
 *
 * 한국어: 삽화 지침과 분리해 기존 이미지 제공자 연결·생성 설정을 모은 계약.
 *
 * @remarks
 * May include API keys; use transiently and do not copy into illustration metadata.
 * 한국어: API 키가 포함될 수 있으므로 임시 사용하며 삽화 메타데이터에 복사 금지.
 */
export interface ImageGenerationSettings {
  openAIKey: string;
  sdProvider: ImageProviderId;
  webUiUrl: string;
  sdSteps: number;
  sdCFG: number;
  sdConfig: sdConfig;
  NAIImgUrl: string;
  NAIApiKey: string;
  NAIImgModel: string;
  NAII2I: boolean;
  NAIImgConfig: NAIImgConfig;
  google: {
    accessToken: string;
    projectId: string;
  };
  dallEQuality: string;
  stabilityModel: string;
  stabilityKey: string;
  stabllityStyle: string;
  comfyConfig: ComfyConfig;
  comfyUiUrl: string;
  falToken: string;
  falModel: string;
  falLora: string;
  falLoraScale: number;
  ImagenModel: string;
  ImagenImageSize: string;
  ImagenAspectRatio: string;
  ImagenPersonGeneration: string;
  openaiCompatImage: {
    url: string;
    key: string;
    model: string;
    size: string;
    quality: string;
  };
  wavespeedImage: {
    key: string;
    model: string;
    loras: Array<{ path: string; scale: number }>;
    reference_mode: string;
    reference_image: string;
    reference_base64image: string;
  };
}

/**
 * Lists the minimal settings adapters must read for existing image providers.
 *
 * 한국어: 기존 이미지 제공자를 위해 어댑터가 읽어야 할 최소 설정 키 목록.
 */
export const IMAGE_GENERATION_SETTING_KEYS = [
  "sdProvider",
  "webUiUrl",
  "sdConfig",
  "sdSteps",
  "sdCFG",
  "NAIImgModel",
  "NAIImgConfig",
  "NAIApiKey",
  "NAII2I",
  "NAIImgUrl",
  "dallEQuality",
  "openAIKey",
  "stabilityModel",
  "stabllityStyle",
  "stabilityKey",
  "comfyConfig",
  "comfyUiUrl",
  "falModel",
  "falToken",
  "falLora",
  "falLoraScale",
  "ImagenModel",
  "ImagenImageSize",
  "ImagenAspectRatio",
  "ImagenPersonGeneration",
  "google",
  "openaiCompatImage",
  "wavespeedImage",
] as const;

/**
 * Describes WebUI dimensions, sampling and high-resolution generation options.
 *
 * 한국어: WebUI의 크기·샘플링·고해상도 생성 옵션.
 */
interface sdConfig {
  width: number;
  height: number;
  sampler_name: string;
  script_name: string;
  denoising_strength: number;
  enable_hr: boolean;
  hr_scale: number;
  hr_upscaler: string;
}

/**
 * Preserves NovelAI sampling, image-to-image, vibe and character-reference options.
 *
 * 한국어: NovelAI 샘플링·이미지 변환·vibe·캐릭터 참조 기능을 유지하는 설정.
 */
export interface NAIImgConfig {
  width: number;
  height: number;
  sampler: string;
  noise_schedule: string;
  steps: number;
  scale: number;
  cfg_rescale: number;
  sm: boolean;
  sm_dyn: boolean;
  noise: number;
  strength: number;
  image: string;
  base64image: string;
  InfoExtracted: number;
  //add 4
  autoSmea: boolean;
  use_coords: boolean;
  legacy_uc: boolean;
  v4_prompt: NAIImgConfigV4Prompt;
  v4_negative_prompt: NAIImgConfigV4NegativePrompt;
  //add vibe
  reference_image_multiple?: string[];
  reference_strength_multiple?: number[];
  vibe_data?: NAIVibeData;
  vibe_model_selection?: string;
  //add variety+ and decrisp options
  variety_plus: boolean;
  decrisp: boolean;
  //add character reference
  reference_mode: string;
  character_image: string;
  character_base64image: string;
  style_aware: boolean;
}

/**
 * Defines the NovelAI V4 positive caption and ordering options.
 *
 * 한국어: NovelAI V4의 긍정 캡션·좌표·순서 옵션.
 */
interface NAIImgConfigV4Prompt {
  caption: NAIImgConfigV4Caption;
  use_coords: boolean;
  use_order: boolean;
}

/**
 * Groups the overall caption and per-character captions for NovelAI V4.
 *
 * 한국어: NovelAI V4의 전체 캡션과 캐릭터별 캡션 묶음.
 */
interface NAIImgConfigV4Caption {
  base_caption: string;
  char_captions: NAIImgConfigV4CharCaption[];
}

/**
 * Associates a NovelAI character caption with its normalized image coordinates.
 *
 * 한국어: NovelAI 캐릭터 캡션과 정규화한 이미지 좌표 정보.
 */
interface NAIImgConfigV4CharCaption {
  char_caption: string;
  centers: {
    x: number;
    y: number;
  }[];
}

/**
 * Defines the NovelAI V4 negative caption and legacy undesired-content mode.
 *
 * 한국어: NovelAI V4 네거티브 캡션·기존 원하지 않는 내용 처리 옵션.
 */
interface NAIImgConfigV4NegativePrompt {
  caption: NAIImgConfigV4Caption;
  legacy_uc: boolean;
}

/**
 * Describes an imported NovelAI vibe reference with model-specific cached encodings.
 *
 * 한국어: 모델별 캐시 인코딩과 가져오기 정보를 포함한 NovelAI vibe 참조 데이터.
 */
interface NAIVibeData {
  identifier: string;
  version: number;
  type: string;
  image: string;
  id: string;
  encodings: {
    [key: string]: {
      [key: string]: NAIVibeEncoding;
    };
  };
  name: string;
  thumbnail: string;
  createdAt: number;
  importInfo: {
    model: string;
    information_extracted: number;
    strength: number;
  };
}

/**
 * Stores a NovelAI vibe encoding and its extracted-information setting.
 *
 * 한국어: NovelAI vibe 인코딩과 정보 추출 설정.
 */
interface NAIVibeEncoding {
  encoding: string;
  params: {
    information_extracted: number;
  };
}

/**
 * Configures a ComfyUI workflow, legacy prompt input nodes and polling timeout.
 *
 * 한국어: ComfyUI 워크플로·기존 방식의 프롬프트 입력 노드·결과 대기 시간 설정.
 */
export interface ComfyWorkflow {
  id: string;
  name: string;
  workflow: string;
}

export interface ComfyConfig {
  workflow: string;
  workflows?: ComfyWorkflow[];
  selectedWorkflowId?: string;
  posNodeID: string;
  posInputName: string;
  negNodeID: string;
  negInputName: string;
  timeout: number;
}

/** Snapshot only the active workflow so image jobs do not copy the entire library. */
export function getComfyGenerationConfig(config: ComfyConfig): ComfyConfig {
  const selected =
    config.workflows?.find((item) => item.id === config.selectedWorkflowId) ??
    config.workflows?.[0];
  const {
    workflows: _workflows,
    selectedWorkflowId: _selectedId,
    ...settings
  } = config;
  return { ...settings, workflow: selected?.workflow ?? config.workflow };
}

/**
 * Character fields read by reference-image modes.
 *
 * 한국어: 참조 이미지 모드에서 읽는 캐릭터 필드.
 */
interface ImageGenerationCharacter {
  image?: string;
}

/**
 * Result of one provider call: an image data URL or provider URL.
 *
 * 한국어: 제공자 호출 결과. 이미지 데이터 URL 또는 제공자 URL.
 */
type ImageGenerationResult = string;

/**
 * Per-call state shared by every provider handler.
 *
 * 한국어: 모든 제공자 처리 함수가 공유하는 호출 단위 상태.
 *
 * @remarks
 * `fetchJson` and `fetchNative` are status-preserving wrappers that never resolve with a
 * non-OK response, so handlers only validate the payload of successful responses.
 * 한국어: `fetchJson`·`fetchNative`는 실패 응답을 반환하지 않고 예외로 던지는 래퍼이므로
 * 각 처리 함수는 성공 응답의 본문 검증만 담당.
 */
interface ImageGenerationContext {
  db: ImageGenerationSettings;
  runtime: ImageGenerationRuntime;
  fetchJson: ImageGenerationRuntime["fetchJson"];
  fetchNative: ImageGenerationRuntime["fetchNative"];
  prompt: string;
  negativePrompt: string;
  currentChar: ImageGenerationCharacter;
}

/**
 * Generates one image with a single provider.
 *
 * 한국어: 단일 제공자로 그림 한 장을 생성하는 처리 함수 형식.
 */
type ImageProviderHandler = (
  context: ImageGenerationContext,
) => Promise<ImageGenerationResult>;

// ---------------------------------------------------------------------------
// Shared helpers / 공통 도우미
// ---------------------------------------------------------------------------

/**
 * Wraps `runtime.fetchJson` so non-OK responses become classified illustration errors.
 *
 * 한국어: 실패 응답을 분류된 삽화 오류로 바꾸도록 `runtime.fetchJson`을 감싸는 함수.
 *
 * @remarks
 * Preserves transport status before provider-specific code reduces errors to response text.
 * Connection/timeout failures reported in the body win over the HTTP status, because some
 * platforms report browser transport failures as HTTP 400.
 * 한국어: 제공자별 코드가 오류를 응답 문자열로 축약하기 전에 전송 상태를 보존.
 * 일부 플랫폼은 브라우저 전송 실패를 HTTP 400으로 보고하므로 본문의 연결·시간 초과 판정을 우선.
 */
function createStatusPreservingFetchJson(
  runtime: ImageGenerationRuntime,
  provider: ImageProviderId,
): ImageGenerationRuntime["fetchJson"] {
  return async (url, options) => {
    const response = await runtime.fetchJson(url, options);
    if (!response.ok) {
      const transport = describeIllustrationError(response.data, "image");
      const details =
        transport.code === "connection" || transport.code === "timeout"
          ? transport
          : describeIllustrationError({ status: response.status }, "image");
      const diagnostic =
        (provider === "comfyui" || provider === "comfy") &&
        response.status === 400
          ? comfyValidationDiagnostic(response.data)
          : undefined;
      throw new IllustrationRequestError(
        details.code,
        details.status,
        diagnostic,
      );
    }
    return response;
  };
}

/** Retain validation identifiers only; details/extra_info can contain prompt values. */
function comfyValidationDiagnostic(data: unknown): string | undefined {
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return undefined;
    }
  }
  if (!data || typeof data !== "object") return undefined;
  const response = data as {
    error?: { type?: unknown };
    node_errors?: unknown;
  };
  const identifier = (value: unknown): value is string =>
    typeof value === "string" && /^[a-zA-Z_][a-zA-Z0-9_]{0,79}$/.test(value);
  const lines: string[] = [];
  if (identifier(response.error?.type))
    lines.push(`ComfyUI: ${response.error.type}`);
  if (response.node_errors && typeof response.node_errors === "object") {
    for (const [id, value] of Object.entries(response.node_errors).slice(
      0,
      8,
    )) {
      if (
        !/^\d+(?::\d+)*$/.test(id) ||
        id.length > 80 ||
        !value ||
        typeof value !== "object"
      )
        continue;
      const errors = (value as { errors?: unknown }).errors;
      if (!Array.isArray(errors)) continue;
      for (const error of errors.slice(0, 3)) {
        if (!error || !identifier(error.type)) continue;
        const input = error.extra_info?.input_name;
        lines.push(
          `Node ${id}: ${error.type}${identifier(input) ? ` (${input})` : ""}`,
        );
      }
    }
  }
  return lines.length ? lines.join("\n").slice(0, 1024) : undefined;
}

/**
 * Wraps `runtime.fetchNative` so non-OK responses become HTTP-status illustration errors.
 *
 * 한국어: 실패 응답을 HTTP 상태 기반 삽화 오류로 바꾸도록 `runtime.fetchNative`를 감싸는 함수.
 */
function createStatusPreservingFetchNative(
  runtime: ImageGenerationRuntime,
): ImageGenerationRuntime["fetchNative"] {
  return async (url, options) => {
    const response = await runtime.fetchNative(url, options);
    if (!response.ok) {
      const details = describeIllustrationError(
        { status: response.status },
        "image",
      );
      throw new IllustrationRequestError(details.code, details.status);
    }
    return response;
  };
}

/**
 * Chooses an inclusive integer seed range for provider requests.
 *
 * 한국어: 제공자 요청용 시드를 양 끝을 포함하는 정수 범위에서 선택하는 함수.
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Converts provider failures into thrown errors without depending on application alerts.
 *
 * 한국어: 앱 알림 모듈에 의존하지 않고 제공자 실패를 예외로 전달하는 함수.
 */
function throwProviderError(error: unknown): never {
  throw error instanceof Error
    ? error
    : new Error(
        typeof error === "string" ? error : "Image provider request failed",
      );
}

/**
 * Runs a provider step and normalizes any non-Error throw into an `Error`.
 *
 * 한국어: 제공자 단계를 실행하고 Error가 아닌 예외 값을 `Error`로 정규화하는 함수.
 *
 * @remarks
 * Only wraps the same scopes that the original provider branches guarded with try/catch.
 * 한국어: 기존 제공자 분기에서 try/catch로 감싸던 범위에만 동일하게 적용.
 */
async function rethrowAsError<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    return throwProviderError(error);
  }
}

/**
 * Waits for the given number of milliseconds between polling attempts.
 *
 * 한국어: 결과 조회 사이에 지정한 밀리초만큼 기다리는 함수.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps base64 PNG bytes in a data URL.
 *
 * 한국어: Base64 PNG 데이터를 데이터 URL로 감싸는 함수.
 */
function toPngDataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

/**
 * Reads the character's default image as base64, or returns an empty string when missing.
 *
 * 한국어: 캐릭터 기본 이미지를 Base64로 읽고, 없으면 빈 문자열을 반환하는 함수.
 */
async function readCharacterImageBase64(
  runtime: ImageGenerationRuntime,
  currentChar: ImageGenerationCharacter,
): Promise<string> {
  const image = await runtime.readImage(currentChar.image);
  return image ? Buffer.from(image).toString("base64") : "";
}

// ---------------------------------------------------------------------------
// Stable Diffusion WebUI
// ---------------------------------------------------------------------------

/**
 * Generates an image through the AUTOMATIC1111-compatible `txt2img` endpoint.
 *
 * 한국어: AUTOMATIC1111 호환 `txt2img` 엔드포인트로 그림을 생성하는 함수.
 */
async function generateWithWebUi(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, fetchJson, prompt, negativePrompt } = context;
  const uri = new URL(db.webUiUrl);
  uri.pathname = "/sdapi/v1/txt2img";
  return rethrowAsError(async () => {
    const response = await fetchJson(uri.toString(), {
      body: {
        width: db.sdConfig.width,
        height: db.sdConfig.height,
        seed: -1,
        steps: db.sdSteps,
        cfg_scale: db.sdCFG,
        prompt,
        negative_prompt: negativePrompt,
        sampler_name: db.sdConfig.sampler_name,
        enable_hr: db.sdConfig.enable_hr,
        denoising_strength: db.sdConfig.denoising_strength,
        hr_scale: db.sdConfig.hr_scale,
        hr_upscaler: db.sdConfig.hr_upscaler,
      },
      headers: {
        "Content-Type": "application/json",
      },
    });
    return toPngDataUrl(response.data.images[0]);
  });
}

// ---------------------------------------------------------------------------
// NovelAI
// ---------------------------------------------------------------------------

/**
 * Request shape sent to the NovelAI image endpoint.
 *
 * 한국어: NovelAI 이미지 엔드포인트로 보내는 요청 형태.
 */
interface NovelAIRequest {
  body: {
    input: string;
    model: string;
    action?: string;
    parameters: Record<string, any>;
  };
  headers: Record<string, string>;
  rawResponse: boolean;
}

/** V2/V3 model families that accept SMEA and decrisp. / SMEA·decrisp를 지원하는 V2·V3 모델 계열. */
const NAI_SMEA_MODELS = [
  "nai-diffusion-3",
  "nai-diffusion-furry-3",
  "nai-diffusion-2",
] as const;

/** V3 model families that accept dynamic SMEA. / 동적 SMEA를 지원하는 V3 모델 계열. */
const NAI_SMEA_DYN_MODELS = [
  "nai-diffusion-3",
  "nai-diffusion-furry-3",
] as const;

/** Models using the V3/V4 Variety+ sigma factor. / V3·V4 Variety+ 시그마 계수를 쓰는 모델. */
const NAI_VARIETY_PLUS_V3_V4_MODELS = [
  "nai-diffusion-4-full",
  "nai-diffusion-4-curated",
  "nai-diffusion-3",
  "nai-diffusion-furry-3",
] as const;

/** V4.5 model families (Variety+ factor and character reference). / V4.5 모델 계열(Variety+ 계수·캐릭터 참조). */
const NAI_V4_5_MODELS = [
  "nai-diffusion-4-5-full",
  "nai-diffusion-4-5-curated",
] as const;

/**
 * Maps model families to vibe encoding keys, checked in order.
 *
 * 한국어: 모델 계열을 vibe 인코딩 키로 매핑하는 순서 있는 목록.
 */
const NAI_VIBE_MODEL_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["nai-diffusion-4-full", "v4full"],
  ["nai-diffusion-4-curated", "v4curated"],
  ["nai-diffusion-4-5-full", "v4-5full"],
  ["nai-diffusion-4-5-curated", "v4-5curated"],
];

/**
 * Checks whether a NovelAI model name contains any of the given family identifiers.
 *
 * 한국어: NovelAI 모델 이름이 주어진 계열 식별자 중 하나를 포함하는지 확인하는 함수.
 */
function modelIncludesAny(model: string, families: readonly string[]): boolean {
  return families.some((family) => model.includes(family));
}

/**
 * Converts WebUI-style `(emphasis)` into NovelAI `{emphasis}` while keeping escaped `\(` `\)` literal.
 *
 * 한국어: WebUI식 `(강조)`를 NovelAI식 `{강조}`로 바꾸되, 이스케이프된 `\(` `\)`는 괄호 그대로 유지하는 함수.
 *
 * @remarks
 * Escaped parentheses are parked on placeholder glyphs during the swap.
 * 한국어: 치환 중에는 이스케이프된 괄호를 임시 기호에 잠시 보관.
 */
function convertPromptWeightsForNovelAI(prompt: string): string {
  return prompt
    .replaceAll("\\(", "♧")
    .replaceAll("\\)", "♤")
    .replaceAll("(", "{")
    .replaceAll(")", "}")
    .replaceAll("♧", "(")
    .replaceAll("♤", ")");
}

/**
 * Builds the base NovelAI request with sampling, V4 caption and empty reference slots.
 *
 * 한국어: 샘플링·V4 캡션·빈 참조 슬롯을 포함한 NovelAI 기본 요청을 만드는 함수.
 */
function buildNovelAIBaseRequest(
  db: ImageGenerationSettings,
  prompt: string,
  negativePrompt: string,
): NovelAIRequest {
  const config = db.NAIImgConfig;
  const model = db.NAIImgModel;
  const supportsSmea = modelIncludesAny(model, NAI_SMEA_MODELS);
  return {
    body: {
      input: prompt,
      model,
      parameters: {
        params_version: 3,
        add_original_image: true,
        cfg_rescale: config.cfg_rescale,
        controlnet_strength: 1,
        dynamic_thresholding: supportsSmea ? config.decrisp : false,
        n_samples: 1,
        width: config.width,
        height: config.height,
        sampler: config.sampler,
        steps: config.steps,
        scale: config.scale,
        negative_prompt: negativePrompt,
        sm: supportsSmea ? config.sm : undefined,
        sm_dyn: modelIncludesAny(model, NAI_SMEA_DYN_MODELS)
          ? config.sm_dyn
          : undefined,
        noise_schedule: config.noise_schedule,
        normalize_reference_strength_multiple: true,
        ucPreset: 3,
        uncond_scale: 1,
        qualityToggle: false,
        legacy_v3_extend: false,
        legacy: false,
        //add v4
        autoSmea: false,
        use_coords: false,
        legacy_uc: config.legacy_uc,
        v4_prompt: {
          caption: {
            base_caption: prompt,
            char_captions: [],
          },
          use_coords: false,
          use_order: true,
        },
        v4_negative_prompt: {
          caption: {
            base_caption: negativePrompt,
            char_captions: [],
          },
          legacy_uc: config.legacy_uc,
        },
        reference_image_multiple: [],
        reference_strength_multiple: [],
        //add reference image
        image: undefined,
        strength: undefined,
        noise: undefined,
        //add additional parameters
        seed: randomInt(0, 2 ** 32 - 1),
        extra_noise_seed: randomInt(0, 2 ** 32 - 1),
        prefer_brownian: true,
        deliberate_euler_ancestral_bug: false,
        skip_cfg_above_sigma: null,
        //add character reference
        director_reference_images: [],
        director_reference_descriptions: [],
        director_reference_information_extracted: [],
        director_reference_strength_values: [],
      },
    },
    headers: {
      Authorization: "Bearer " + db.NAIApiKey,
    },
    rawResponse: true,
  };
}

/**
 * Applies the Variety+ option by skipping CFG above a canvas-size-dependent sigma.
 *
 * 한국어: 캔버스 크기에 비례한 시그마 이상에서 CFG를 건너뛰도록 Variety+ 옵션을 적용하는 함수.
 */
function applyNovelAIVarietyPlus(
  parameters: Record<string, any>,
  db: ImageGenerationSettings,
): void {
  const config = db.NAIImgConfig;
  if (!config.variety_plus) return;
  const canvasScale = Math.sqrt(config.width * config.height);
  if (modelIncludesAny(db.NAIImgModel, NAI_VARIETY_PLUS_V3_V4_MODELS)) {
    parameters.skip_cfg_above_sigma = canvasScale * 0.01889;
  }
  if (modelIncludesAny(db.NAIImgModel, NAI_V4_5_MODELS)) {
    parameters.skip_cfg_above_sigma = canvasScale * 0.05766;
  }
}

/**
 * Resolves which vibe encoding set to use: the explicit selection, or one inferred from the model.
 *
 * 한국어: 사용할 vibe 인코딩 묶음을 명시 선택값 또는 현재 모델에서 추론해 결정하는 함수.
 */
function resolveNovelAIVibeModelKey(
  config: NAIImgConfig,
  model: string,
): string | null {
  return (
    config.vibe_model_selection ||
    (NAI_VIBE_MODEL_KEYS.find(([family]) => model.includes(family))?.[1] ??
      null)
  );
}

/**
 * Picks an encoding key: the one matching `InfoExtracted` when a model is selected, otherwise the first.
 *
 * 한국어: 모델을 명시 선택했다면 `InfoExtracted`와 일치하는 인코딩을, 아니면 첫 인코딩을 고르는 함수.
 */
function selectNovelAIVibeEncodingKey(
  config: NAIImgConfig,
  encodings: Record<string, NAIVibeEncoding>,
): string | undefined {
  const keys = Object.keys(encodings);
  if (!config.vibe_model_selection) return keys[0];
  const targetInformation = config.InfoExtracted || 1;
  return keys.find(
    (key) => encodings[key].params.information_extracted === targetInformation,
  );
}

/**
 * Adds a cached vibe encoding and its strength when vibe reference mode is active.
 *
 * 한국어: vibe 참조 모드일 때 캐시된 vibe 인코딩과 강도를 요청에 추가하는 함수.
 */
function applyNovelAIVibeReference(
  parameters: Record<string, any>,
  config: NAIImgConfig,
  model: string,
): void {
  if (config.reference_mode !== "vibe" || !config.vibe_data) return;
  const vibeData = config.vibe_data;
  const modelKey = resolveNovelAIVibeModelKey(config, model);
  const encodings =
    modelKey && vibeData.encodings ? vibeData.encodings[modelKey] : undefined;
  if (!encodings) return;
  const encodingKey = selectNovelAIVibeEncodingKey(config, encodings);
  if (!encodingKey) return;
  parameters.reference_image_multiple.push(encodings[encodingKey].encoding);
  parameters.reference_strength_multiple.push(
    config.reference_strength_multiple?.length
      ? config.reference_strength_multiple[0]
      : 0.5,
  );
}

/**
 * Adds a V4.5 director character reference from the uploaded image or the character's default image.
 *
 * 한국어: 업로드한 이미지 또는 캐릭터 기본 이미지로 V4.5 디렉터 캐릭터 참조를 추가하는 함수.
 */
async function applyNovelAICharacterReference(
  parameters: Record<string, any>,
  context: ImageGenerationContext,
): Promise<void> {
  const { db, runtime, currentChar } = context;
  const config = db.NAIImgConfig;
  if (
    config.reference_mode !== "character" ||
    !modelIncludesAny(db.NAIImgModel, NAI_V4_5_MODELS)
  ) {
    return;
  }
  const source = config.character_image
    ? config.character_base64image
    : await readCharacterImageBase64(runtime, currentChar);
  const reference = await runtime.resizeReference(source);
  if (!reference) return;
  parameters.director_reference_descriptions = [
    {
      caption: {
        base_caption: "character" + (config.style_aware ? "&style" : ""),
        char_captions: [],
      },
      legacy_uc: config.legacy_uc,
    },
  ];
  parameters.director_reference_images = [reference];
  parameters.director_reference_information_extracted = [1];
  parameters.director_reference_strength_values = [1];
}

/**
 * Chooses `generate` or `img2img` and attaches the img2img source image.
 *
 * 한국어: `generate`·`img2img` 동작을 정하고 img2img 원본 이미지를 첨부하는 함수.
 *
 * @remarks
 * Preserves a legacy quirk: when img2img is enabled but no source image exists, an empty
 * request object is sent instead of falling back to `generate`.
 * 한국어: 기존 동작 유지. img2img가 켜져 있으나 원본 이미지가 없으면 `generate`로 전환하지 않고
 * 빈 요청 객체를 그대로 전송.
 */
async function finalizeNovelAIRequest(
  request: NovelAIRequest,
  context: ImageGenerationContext,
): Promise<NovelAIRequest | Record<string, never>> {
  const { db, runtime, currentChar } = context;
  if (!db.NAII2I) {
    request.body.action = "generate";
    return request;
  }
  const config = db.NAIImgConfig;
  const sourceImage = config.image
    ? config.base64image
    : await readCharacterImageBase64(runtime, currentChar);
  if (!sourceImage) return {};
  request.body.action = "img2img";
  request.body.parameters.image = sourceImage;
  request.body.parameters.strength = config.strength || 0.7;
  request.body.parameters.noise = config.noise || 0;
  return request;
}

/**
 * Generates an image with NovelAI, including Variety+, vibe, character reference and img2img.
 *
 * 한국어: Variety+·vibe·캐릭터 참조·img2img를 포함해 NovelAI로 그림을 생성하는 함수.
 */
async function generateWithNovelAI(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, runtime, fetchJson } = context;
  const prompt = convertPromptWeightsForNovelAI(context.prompt);
  const request = buildNovelAIBaseRequest(db, prompt, context.negativePrompt);
  const parameters = request.body.parameters;
  applyNovelAIVarietyPlus(parameters, db);
  applyNovelAIVibeReference(parameters, db.NAIImgConfig, db.NAIImgModel);
  await applyNovelAICharacterReference(parameters, context);
  const finalRequest = await finalizeNovelAIRequest(request, context);
  return rethrowAsError(async () => {
    // NovelAI answers with a ZIP archive that contains the generated image.
    // 한국어: NovelAI는 생성 그림이 담긴 ZIP 파일로 응답.
    const response = await fetchJson(db.NAIImgUrl, finalRequest);
    return runtime.unzipImage(response.data);
  });
}

// ---------------------------------------------------------------------------
// OpenAI DALL·E / OpenAI-compatible
// ---------------------------------------------------------------------------

/**
 * Extracts the first `b64_json` image from an OpenAI image response as a PNG data URL.
 *
 * 한국어: OpenAI 이미지 응답의 첫 `b64_json` 그림을 PNG 데이터 URL로 추출하는 함수.
 */
function readOpenAIImageResponse(data: any): string {
  const base64 = data?.data?.[0]?.b64_json;
  if (!base64) throwProviderError(JSON.stringify(data));
  return toPngDataUrl(base64);
}

/**
 * Generates an image with OpenAI DALL·E 3.
 *
 * 한국어: OpenAI DALL·E 3로 그림을 생성하는 함수.
 */
async function generateWithDallE(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, fetchJson, prompt } = context;
  const response = await fetchJson(
    "https://api.openai.com/v1/images/generations",
    {
      body: {
        prompt,
        model: "dall-e-3",
        response_format: "b64_json",
        style: "natural",
        quality: db.dallEQuality || "standard",
      },
      headers: {
        Authorization: "Bearer " + db.openAIKey,
      },
    },
  );
  return readOpenAIImageResponse(response?.data);
}

/**
 * Generates an image with a user-configured OpenAI-compatible images endpoint.
 *
 * 한국어: 사용자가 설정한 OpenAI 호환 이미지 엔드포인트로 그림을 생성하는 함수.
 */
async function generateWithOpenAICompatible(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, fetchJson, prompt } = context;
  const config = db.openaiCompatImage;
  if (!config.url) throwProviderError("OpenAI Compatible API URL is not set");
  const body: Record<string, any> = {
    prompt,
    response_format: "b64_json",
    size: config.size || "1024x1024",
    quality: config.quality || "auto",
  };
  if (config.model) body.model = config.model;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.key) headers["Authorization"] = "Bearer " + config.key;
  const response = await fetchJson(config.url, { body, headers });
  return readOpenAIImageResponse(response?.data);
}

// ---------------------------------------------------------------------------
// Stability AI
// ---------------------------------------------------------------------------

/**
 * Builds the multipart form for Stability's core, ultra or SD3 endpoints.
 *
 * 한국어: Stability core·ultra·SD3 엔드포인트용 멀티파트 폼을 만드는 함수.
 *
 * @remarks
 * Core ignores negative prompts but accepts a style preset; SD3 models also need `model`.
 * 한국어: core는 네거티브 프롬프트 대신 스타일 프리셋을 받고, SD3 계열은 `model`도 필요.
 */
function buildStabilityFormData(
  db: ImageGenerationSettings,
  prompt: string,
  negativePrompt: string,
): FormData {
  const model = db.stabilityModel;
  const formData = new FormData();
  formData.append("prompt", prompt);
  if (model !== "core" && model !== "ultra") {
    formData.append("negative_prompt", negativePrompt);
    formData.append("model", model);
  }
  if (model === "core" && db.stabllityStyle) {
    formData.append("style_preset", db.stabllityStyle);
  }
  if (model === "ultra") {
    formData.append("negative_prompt", negativePrompt);
  }
  return formData;
}

/**
 * Resolves the Stability endpoint for the selected model; every non-core/ultra model uses SD3.
 *
 * 한국어: 선택한 모델의 Stability 엔드포인트를 결정하며, core·ultra 외에는 SD3를 사용하는 함수.
 */
function resolveStabilityEndpoint(model: string): string {
  const path = model === "core" ? "core" : model === "ultra" ? "ultra" : "sd3";
  return "https://api.stability.ai/v2beta/stable-image/generate/" + path;
}

/**
 * Generates an image with Stability AI and rejects JSON error payloads returned with HTTP 200.
 *
 * 한국어: Stability AI로 그림을 생성하고, HTTP 200으로 돌아온 JSON 오류 본문은 거부하는 함수.
 */
async function generateWithStability(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, fetchNative, prompt, negativePrompt } = context;
  const response = await fetchNative(
    resolveStabilityEndpoint(db.stabilityModel),
    {
      body: buildStabilityFormData(db, prompt, negativePrompt),
      headers: {
        authorization: "Bearer " + db.stabilityKey,
        accept: "image/*",
      },
      method: "POST",
    },
  );
  const body = await response.arrayBuffer();
  if (
    (response.headers.get("content-type") ?? "").startsWith("application/json")
  ) {
    throwProviderError(Buffer.from(body).toString());
  }
  return toPngDataUrl(Buffer.from(body).toString("base64"));
}

// ---------------------------------------------------------------------------
// ComfyUI
// ---------------------------------------------------------------------------

/** Interval between ComfyUI history checks. / ComfyUI 기록 조회 간격. */
const COMFY_POLL_INTERVAL_MS = 1000;

/**
 * Builds ComfyUI endpoints while preserving an optional `/api` prefix and query parameters.
 *
 * 한국어: 선택적인 `/api` 접두사·쿼리를 유지하며 ComfyUI 요청 주소를 구성하는 함수를 만드는 함수.
 */
export function createComfyUrlBuilder(
  comfyUiUrl: string,
): (pathname: string, params?: Record<string, string>) => string {
  const baseUrl = new URL(comfyUiUrl.replace(/\/+$/, "") + "/");
  return (pathname, params = {}) => {
    const url = new URL(pathname.replace(/^\/+/, ""), baseUrl);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    return url.toString();
  };
}

/**
 * Writes the prompts into a parsed ComfyUI workflow in place.
 *
 * 한국어: 파싱한 ComfyUI 워크플로에 프롬프트를 직접 기록하는 함수.
 *
 * @remarks
 * Legacy mode writes into the configured node inputs. The current mode replaces
 * `{{risu_prompt}}`/`{{risu_neg}}` placeholders in every string input and re-rolls numeric `seed` inputs.
 * 한국어: 기존 방식은 설정한 노드 입력에 기록. 현재 방식은 모든 문자열 입력의
 * `{{risu_prompt}}`·`{{risu_neg}}` 자리 표시자를 치환하고 숫자형 `seed` 입력을 새로 뽑음.
 */
function injectComfyPrompts(
  workflow: Record<string, any>,
  legacy: boolean,
  config: ComfyConfig,
  prompt: string,
  negativePrompt: string,
): void {
  if (legacy) {
    workflow[config.posNodeID].inputs[config.posInputName] = prompt;
    workflow[config.negNodeID].inputs[config.negInputName] = negativePrompt;
    return;
  }
  for (const node of Object.values(workflow)) {
    for (const inputName of Object.keys(node.inputs)) {
      let input = node.inputs[inputName];
      if (typeof input === "string") {
        input = input.replaceAll("{{risu_prompt}}", prompt);
        input = input.replaceAll("{{risu_neg}}", negativePrompt);
      }
      if (inputName === "seed" && typeof input === "number") {
        input = randomInt(0, 999_999_999);
      }
      node.inputs[inputName] = input;
    }
  }
}

/**
 * Polls ComfyUI history until the queued prompt appears or the timeout elapses.
 *
 * 한국어: 대기열에 넣은 프롬프트가 기록에 나타나거나 제한 시간이 지날 때까지 ComfyUI 기록을 조회하는 함수.
 */
async function waitForComfyHistoryItem(
  fetchNative: ImageGenerationRuntime["fetchNative"],
  createUrl: (pathname: string) => string,
  promptId: string,
  timeoutMs: number,
): Promise<any> {
  const startTime = Date.now();
  while (true) {
    const response = await fetchNative(createUrl("/history"), {
      headers: { "Content-Type": "application/json" },
      method: "GET",
    });
    const item = (await response.json())[promptId];
    if (item) return item;
    if (Date.now() - startTime >= timeoutMs) {
      throwProviderError("Error: Image generation took longer than expected.");
    }
    await sleep(COMFY_POLL_INTERVAL_MS);
  }
}

/**
 * Downloads the first output image of a finished ComfyUI prompt as a PNG data URL.
 *
 * 한국어: 완료된 ComfyUI 프롬프트의 첫 출력 그림을 PNG 데이터 URL로 내려받는 함수.
 */
async function downloadComfyImage(
  fetchNative: ImageGenerationRuntime["fetchNative"],
  createUrl: (pathname: string, params?: Record<string, string>) => string,
  historyItem: any,
): Promise<string> {
  const imageInfo = Object.values(historyItem.outputs).flatMap(
    (output: any) => output.images,
  )[0];
  const response = await fetchNative(
    createUrl("/view", {
      filename: imageInfo.filename,
      subfolder: imageInfo.subfolder,
      type: imageInfo.type,
    }),
    {
      headers: { "Content-Type": "application/json" },
      method: "GET",
    },
  );
  return toPngDataUrl(
    Buffer.from(await response.arrayBuffer()).toString("base64"),
  );
}

/**
 * Queues a ComfyUI workflow, waits for completion and downloads the result.
 *
 * 한국어: ComfyUI 워크플로를 대기열에 넣고 완료를 기다린 뒤 결과를 내려받는 함수.
 *
 * @remarks
 * `comfy` is the legacy node-ID mode and `comfyui` is the placeholder mode.
 * 한국어: `comfy`는 기존 노드 ID 방식, `comfyui`는 자리 표시자 방식.
 */
async function generateWithComfyUi(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, fetchJson, fetchNative, prompt, negativePrompt } = context;
  const legacy = db.sdProvider === "comfy";
  const createUrl = createComfyUrlBuilder(db.comfyUiUrl);
  return rethrowAsError(async () => {
    const config = getComfyGenerationConfig(db.comfyConfig);
    const workflow = JSON.parse(config.workflow);
    injectComfyPrompts(
      workflow,
      legacy,
      db.comfyConfig,
      prompt,
      negativePrompt,
    );
    const queued = await fetchJson(createUrl("/prompt"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { prompt: workflow },
    });
    const historyItem = await waitForComfyHistoryItem(
      fetchNative,
      createUrl,
      queued.data.prompt_id,
      db.comfyConfig.timeout * 1000,
    );
    return downloadComfyImage(fetchNative, createUrl, historyItem);
  });
}

// ---------------------------------------------------------------------------
// Kei (removed)
// ---------------------------------------------------------------------------

/**
 * Rejects the Kei provider, which required the removed Risu Account integration.
 *
 * 한국어: 제거된 Risu 계정 연동이 필요한 Kei 제공자를 거부하는 함수.
 */
async function rejectKeiProvider(): Promise<ImageGenerationResult> {
  return throwProviderError(
    "The Kei image provider is unavailable in Haejeok RisuAI because Risu Account integration has been removed.",
  );
}

// ---------------------------------------------------------------------------
// fal.ai
// ---------------------------------------------------------------------------

/**
 * Converts Civitai `urn:`/`civitai:` LoRA identifiers into direct SafeTensor download URLs.
 *
 * 한국어: Civitai `urn:`·`civitai:` LoRA 식별자를 SafeTensor 직접 다운로드 주소로 바꾸는 함수.
 */
function resolveFalLoraPath(loraPath: string): string {
  if (!loraPath.startsWith("urn:") && !loraPath.startsWith("civitai:")) {
    return loraPath;
  }
  const id = loraPath.split("@").pop();
  return `https://civitai.com/api/download/models/${id}?type=Model&format=SafeTensor`;
}

/**
 * Builds the fal.ai request body with model-specific LoRA and safety-checker handling.
 *
 * 한국어: 모델별 LoRA·안전 검사기 처리를 포함한 fal.ai 요청 본문을 만드는 함수.
 */
function buildFalRequestBody(
  db: ImageGenerationSettings,
  prompt: string,
): Record<string, any> {
  const body: Record<string, any> = {
    prompt,
    enable_safety_checker: false,
    sync_mode: true,
    image_size: {
      width: db.sdConfig.width,
      height: db.sdConfig.height,
    },
  };
  if (db.falModel === "fal-ai/flux-lora") {
    body.loras = [
      {
        path: resolveFalLoraPath(db.falLora),
        scale: db.falLoraScale,
      },
    ];
  }
  // flux-pro rejects the safety-checker flag. / flux-pro는 안전 검사기 옵션을 받지 않음.
  if (db.falModel === "fal-ai/flux-pro") {
    delete body.enable_safety_checker;
  }
  return body;
}

/**
 * Generates an image with fal.ai and downloads it as a persistable data URL.
 *
 * 한국어: fal.ai로 그림을 생성하고 저장 가능한 데이터 URL로 내려받는 함수.
 */
async function generateWithFal(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, fetchJson, prompt } = context;
  const response = await fetchJson("https://fal.run/" + db.falModel, {
    headers: {
      Authorization: "Key " + db.falToken,
      "Content-Type": "application/json",
    },
    method: "POST",
    body: buildFalRequestBody(db, prompt),
  });
  const image = response.data?.images?.[0]?.url;
  if (!image) throwProviderError(JSON.stringify(response.data));
  const downloaded = await fetchJson(image, {
    method: "GET",
    rawResponse: true,
  });
  const mimeType = (downloaded.headers?.["content-type"] || "image/png")
    .split(";")[0]
    .trim();
  return `data:${mimeType};base64,${Buffer.from(downloaded.data).toString("base64")}`;
}

// ---------------------------------------------------------------------------
// Google Imagen
// ---------------------------------------------------------------------------

/** Imagen models that accept an explicit sample size. / 출력 크기를 지정할 수 있는 Imagen 모델. */
const IMAGEN_SIZED_MODELS = [
  "imagen-4.0-generate-001",
  "imagen-4.0-ultra-generate-001",
] as const;

/**
 * Builds the Imagen `predict` body for a single sample.
 *
 * 한국어: 그림 한 장을 위한 Imagen `predict` 요청 본문을 만드는 함수.
 */
function buildImagenRequestBody(
  db: ImageGenerationSettings,
  prompt: string,
): Record<string, any> {
  const parameters: Record<string, any> = {
    sampleCount: 1,
    aspectRatio: db.ImagenAspectRatio,
    personGeneration: db.ImagenPersonGeneration,
  };
  if ((IMAGEN_SIZED_MODELS as readonly string[]).includes(db.ImagenModel)) {
    parameters.sampleImageSize = db.ImagenImageSize;
  }
  return {
    instances: [{ prompt }],
    parameters,
  };
}

/**
 * Generates an image with Google Imagen and keeps the returned MIME type.
 *
 * 한국어: Google Imagen으로 그림을 생성하고 응답의 MIME 형식을 유지하는 함수.
 */
async function generateWithImagen(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { db, fetchJson, prompt } = context;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${db.ImagenModel}:predict?key=${db.google.accessToken}`;
  const response = await fetchJson(url, {
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
    body: buildImagenRequestBody(db, prompt),
  });
  const prediction = response.data?.predictions?.[0];
  const base64 = prediction?.bytesBase64Encoded;
  if (!base64) throwProviderError(JSON.stringify(response.data));
  const mimeType = prediction?.mimeType || "image/png";
  return `data:${mimeType};base64,${base64}`;
}

// ---------------------------------------------------------------------------
// WaveSpeed
// ---------------------------------------------------------------------------

/** Interval between WaveSpeed task checks. / WaveSpeed 작업 조회 간격. */
const WAVESPEED_POLL_INTERVAL_MS = 3000;

/** Absolute WaveSpeed task timeout (10 minutes). / WaveSpeed 작업 절대 제한 시간(10분). */
const WAVESPEED_MAX_WAIT_MS = 10 * 60 * 1000;

/**
 * Resolves the WaveSpeed reference image from the uploaded image or the character's default image.
 *
 * 한국어: 업로드한 이미지 또는 캐릭터 기본 이미지에서 WaveSpeed 참조 그림을 결정하는 함수.
 */
async function resolveWavespeedReferenceImage(
  context: ImageGenerationContext,
): Promise<string> {
  const config = context.db.wavespeedImage;
  if (config.reference_mode === "image") return config.reference_base64image;
  if (config.reference_mode === "character") {
    return readCharacterImageBase64(context.runtime, context.currentChar);
  }
  return "";
}

/**
 * Keeps only LoRAs with a non-blank path and defaults missing scales to 1.0.
 *
 * 한국어: 경로가 비어 있지 않은 LoRA만 남기고, 강도가 없으면 1.0으로 채우는 함수.
 */
function buildWavespeedLoras(
  loras: Array<{ path: string; scale: number }>,
): Array<{ path: string; scale: number }> {
  return loras
    .filter((lora) => lora && lora.path && lora.path.trim() !== "")
    .map((lora) => ({
      path: lora.path,
      scale: typeof lora.scale === "number" ? lora.scale : 1.0,
    }));
}

/**
 * Builds the WaveSpeed task body with prompt, optional reference image and LoRAs.
 *
 * 한국어: 프롬프트·선택적 참조 그림·LoRA를 포함한 WaveSpeed 작업 본문을 만드는 함수.
 */
async function buildWavespeedRequestBody(
  context: ImageGenerationContext,
): Promise<Record<string, any>> {
  const config = context.db.wavespeedImage;
  const body: Record<string, any> = { prompt: context.prompt };
  const referenceImage = await resolveWavespeedReferenceImage(context);
  if (referenceImage) body.images = [referenceImage];
  if (config.loras && Array.isArray(config.loras)) {
    body.loras = buildWavespeedLoras(config.loras);
  }
  return body;
}

/**
 * Submits a WaveSpeed task and returns its task ID.
 *
 * 한국어: WaveSpeed 작업을 제출하고 작업 ID를 반환하는 함수.
 *
 * @remarks
 * Response: `{ code, message, data: { id } }`.
 * 한국어: 응답 형태는 `{ code, message, data: { id } }`.
 */
async function submitWavespeedTask(
  fetchJson: ImageGenerationRuntime["fetchJson"],
  apiKey: string,
  model: string,
  body: Record<string, any>,
): Promise<string> {
  const response = await fetchJson(`https://api.wavespeed.ai/api/v3/${model}`, {
    body,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
  });
  return response.data.data.id;
}

/**
 * Polls a WaveSpeed task until it completes and returns the first output URL.
 *
 * 한국어: WaveSpeed 작업이 완료될 때까지 조회하고 첫 출력 URL을 반환하는 함수.
 *
 * @remarks
 * Response: `{ code, message, data: { status, outputs } }`, where status is
 * `created`, `processing`, `completed` or `failed`, and `outputs` is empty until completion.
 * 한국어: 응답 형태는 `{ code, message, data: { status, outputs } }`이며 status는
 * `created`·`processing`·`completed`·`failed` 중 하나, `outputs`는 완료 전까지 비어 있음.
 */
async function waitForWavespeedResultUrl(
  fetchJson: ImageGenerationRuntime["fetchJson"],
  apiKey: string,
  requestId: string,
): Promise<string> {
  const taskEndpoint = `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`;
  const startTime = Date.now();
  while (true) {
    if (Date.now() - startTime > WAVESPEED_MAX_WAIT_MS) {
      throwProviderError(`Task timeout after ${WAVESPEED_MAX_WAIT_MS / 1000}s`);
    }
    const response = await fetchJson(taskEndpoint, {
      method: "GET",
      headers: {
        Authorization: "Bearer " + apiKey,
      },
    });
    const task = response.data.data;
    if (task.status === "completed") {
      const resultUrl: string | undefined = task.outputs[0];
      if (!resultUrl) throwProviderError("Task finished but no result URL");
      return resultUrl;
    }
    if (task.status === "failed") {
      throwProviderError(JSON.stringify(response.data));
    }
    await sleep(WAVESPEED_POLL_INTERVAL_MS);
  }
}

/**
 * Downloads a WaveSpeed result image and encodes it as a data URL with its MIME type.
 *
 * 한국어: WaveSpeed 결과 그림을 내려받아 MIME 형식을 담은 데이터 URL로 인코딩하는 함수.
 */
async function downloadWavespeedImage(
  fetchJson: ImageGenerationRuntime["fetchJson"],
  apiKey: string,
  resultUrl: string,
): Promise<string> {
  const response = await fetchJson(resultUrl, {
    method: "GET",
    headers: {
      Authorization: "Bearer " + apiKey,
    },
    rawResponse: true,
  });
  // JPEG by default; also PNG or WebP. Strip parameters such as "; charset=utf-8".
  // 한국어: 기본은 JPEG이며 PNG·WebP도 가능. "; charset=utf-8" 같은 매개변수는 제거.
  const contentType = response.headers?.["content-type"] || "image/jpeg";
  const mimeType = contentType.split(";")[0];
  return `data:${mimeType};base64,${Buffer.from(response.data).toString("base64")}`;
}

/**
 * Generates an image with WaveSpeed: submit the task, poll for the result, then download it.
 *
 * 한국어: WaveSpeed 작업 제출 → 결과 조회 → 그림 다운로드 순서로 그림을 생성하는 함수.
 */
async function generateWithWavespeed(
  context: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const { fetchJson } = context;
  const config = context.db.wavespeedImage;
  if (!config.key) throwProviderError("Please enter wavespeed API key");
  const body = await buildWavespeedRequestBody(context);
  return rethrowAsError(async () => {
    const requestId = await submitWavespeedTask(
      fetchJson,
      config.key,
      config.model,
      body,
    );
    const resultUrl = await waitForWavespeedResultUrl(
      fetchJson,
      config.key,
      requestId,
    );
    return downloadWavespeedImage(fetchJson, config.key, resultUrl);
  });
}

// ---------------------------------------------------------------------------
// Entry point / 진입점
// ---------------------------------------------------------------------------

/**
 * Maps every registered image provider ID to its handler.
 *
 * 한국어: 등록된 모든 이미지 제공자 ID를 처리 함수에 연결하는 등록표.
 */
export const IMAGE_PROVIDER_HANDLERS = {
  webui: generateWithWebUi,
  novelai: generateWithNovelAI,
  dalle: generateWithDallE,
  stability: generateWithStability,
  comfy: generateWithComfyUi,
  comfyui: generateWithComfyUi,
  kei: rejectKeiProvider,
  fal: generateWithFal,
  Imagen: generateWithImagen,
  "openai-compat": generateWithOpenAICompatible,
  wavespeed: generateWithWavespeed,
} as const satisfies Record<string, ImageProviderHandler>;

/**
 * Union of every provider ID that has a registered handler, derived directly from `IMAGE_PROVIDER_HANDLERS`.
 *
 * 한국어: `IMAGE_PROVIDER_HANDLERS`에서 직접 도출한 등록된 제공자 ID 유니온 타입.
 */
export type ImageProviderId = keyof typeof IMAGE_PROVIDER_HANDLERS;

/**
 * Array of every registered provider ID, derived directly from `IMAGE_PROVIDER_HANDLERS` keys.
 *
 * 한국어: `IMAGE_PROVIDER_HANDLERS`의 키로부터 직접 도출한 등록된 제공자 ID 배열.
 */
export const IMAGE_PROVIDER_IDS = Object.keys(
  IMAGE_PROVIDER_HANDLERS,
) as unknown as readonly [ImageProviderId, ...ImageProviderId[]];

/**
 * Narrows a stored `sdProvider` string to a provider that has a registered handler.
 *
 * 한국어: 저장된 `sdProvider` 문자열을 등록된 처리 함수가 있는 제공자 ID로 좁히는 타입 가드.
 *
 * @remarks
 * Uses an own-property check so inherited keys such as `toString` never match.
 * 한국어: `toString` 같은 상속 키가 일치하지 않도록 자체 속성만 검사.
 */
function isImageProviderId(value: string): value is ImageProviderId {
  return Object.prototype.hasOwnProperty.call(IMAGE_PROVIDER_HANDLERS, value);
}

/**
 * Builds, executes and decodes a request for the selected existing image provider.
 *
 * 한국어: 선택한 기존 이미지 제공자의 요청 구성·실행·결과 해석을 처리하는 공통 함수.
 *
 * @param db - Image-provider settings, including transient credentials. / 임시 인증 정보를 포함한 이미지 제공자 설정.
 * @param runtime - Browser or Node transport/image-processing operations. / 브라우저·Node 전송 및 이미지 처리 동작.
 * @param genPrompt - Final positive prompt. / 최종 긍정 프롬프트.
 * @param currentChar - Character image used by applicable reference modes. / 참조 모드에서 사용할 캐릭터 이미지.
 * @param neg - Final negative prompt where supported. / 지원 제공자에 적용할 최종 네거티브 프롬프트.
 * @returns An image data URL or provider URL. / 이미지 데이터 URL·제공자 URL.
 * @throws For unsupported providers, missing configuration, transport or decoding errors. / 미지원 제공자·설정 누락·전송·해석 오류 시.
 * @remarks
 * Creates no chat metadata or inlay assets; callers are responsible for storing the returned image.
 * Provider-specific request building and polling live in the per-provider handlers above.
 * 한국어: 채팅 메타데이터·인레이 자산 저장은 수행하지 않으며 반환한 그림 저장은 호출부에서 처리.
 * 제공자별 요청 구성·비동기 결과 조회는 위의 제공자별 처리 함수에서 담당.
 */
export async function executeImageGeneration(
  db: ImageGenerationSettings,
  runtime: ImageGenerationRuntime,
  genPrompt: string,
  currentChar: ImageGenerationCharacter,
  neg: string,
): Promise<string> {
  if (!isImageProviderId(db.sdProvider)) {
    throwProviderError(
      db.sdProvider
        ? `Unsupported image provider: ${db.sdProvider}`
        : "Image provider is not set",
    );
  }
  return IMAGE_PROVIDER_HANDLERS[db.sdProvider]({
    db,
    runtime,
    fetchJson: createStatusPreservingFetchJson(runtime, db.sdProvider),
    fetchNative: createStatusPreservingFetchNative(runtime),
    prompt: genPrompt,
    negativePrompt: neg,
    currentChar,
  });
}
