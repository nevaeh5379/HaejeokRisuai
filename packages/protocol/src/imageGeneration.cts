import { Buffer } from "buffer";

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
  sdProvider: string;
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
interface ComfyConfig {
  workflow: string;
  posNodeID: string;
  posInputName: string;
  negNodeID: string;
  negInputName: string;
  timeout: number;
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
 * @returns An image data URL or provider URL, or a false/empty failure result. / 이미지 데이터 URL·제공자 URL 또는 실패 시 false·빈 문자열.
 * @throws For provider, transport or decoding errors not handled by a provider branch. / 제공자 분기에서 처리하지 않은 요청·전송·해석 오류 시.
 * @remarks
 * Creates no chat metadata or inlay assets; callers are responsible for storing the returned image.
 * Existing provider-specific options and asynchronous polling stay in this shared core.
 * 한국어: 채팅 메타데이터·인레이 자산 저장은 수행하지 않으며 반환한 그림 저장은 호출부에서 처리.
 * 기존 제공자별 옵션·비동기 결과 조회를 공통 로직에서 유지.
 */
export async function executeImageGeneration(
  db: ImageGenerationSettings,
  runtime: ImageGenerationRuntime,
  genPrompt: string,
  currentChar: {
    image?: string;
  },
  neg: string,
): Promise<string | false> {
  const {
    fetchJson: globalFetch,
    fetchNative,
    readImage,
    unzipImage: processZip,
  } = runtime;
  /**
   * Chooses an inclusive integer seed range for provider requests.
   *
   * 한국어: 제공자 요청용 시드를 양 끝을 포함하는 정수 범위에서 선택하는 함수.
   */
  const random = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;
  /**
   * Converts provider failures into thrown errors without depending on application alerts.
   *
   * 한국어: 앱 알림 모듈에 의존하지 않고 제공자 실패를 예외로 전달하는 함수.
   */
  const alertError = (error: unknown): never => {
    throw error instanceof Error
      ? error
      : new Error(
          typeof error === "string" ? error : "Image provider request failed",
        );
  };
  if (db.sdProvider === "webui") {
    const uri = new URL(db.webUiUrl);
    uri.pathname = "/sdapi/v1/txt2img";
    try {
      const da = await globalFetch(uri.toString(), {
        body: {
          width: db.sdConfig.width,
          height: db.sdConfig.height,
          seed: -1,
          steps: db.sdSteps,
          cfg_scale: db.sdCFG,
          prompt: genPrompt,
          negative_prompt: neg,
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
      {
        if (da.ok) {
          return `data:image/png;base64,${da.data.images[0]}`;
        } else {
          alertError(JSON.stringify(da.data));
          return "";
        }
      }
      return "";
    } catch (error) {
      alertError(error);
      return false;
    }
  }
  if (db.sdProvider === "novelai") {
    genPrompt = genPrompt
      .replaceAll("\\(", "♧")
      .replaceAll("\\)", "♤")
      .replaceAll("(", "{")
      .replaceAll(")", "}")
      .replaceAll("♧", "(")
      .replaceAll("♤", ")");
    let reqlist: any = {};
    const commonReq: {
      body: {
        input: string;
        model: string;
        action?: string;
        parameters: Record<string, any>;
      };
      headers: Record<string, string>;
      rawResponse: boolean;
    } = {
      body: {
        input: genPrompt,
        model: db.NAIImgModel,
        parameters: {
          params_version: 3,
          add_original_image: true,
          cfg_rescale: db.NAIImgConfig.cfg_rescale,
          controlnet_strength: 1,
          dynamic_thresholding:
            db.NAIImgModel.includes("nai-diffusion-3") ||
            db.NAIImgModel.includes("nai-diffusion-furry-3") ||
            db.NAIImgModel.includes("nai-diffusion-2")
              ? db.NAIImgConfig.decrisp
              : false,
          n_samples: 1,
          width: db.NAIImgConfig.width,
          height: db.NAIImgConfig.height,
          sampler: db.NAIImgConfig.sampler,
          steps: db.NAIImgConfig.steps,
          scale: db.NAIImgConfig.scale,
          negative_prompt: neg,
          sm:
            db.NAIImgModel.includes("nai-diffusion-3") ||
            db.NAIImgModel.includes("nai-diffusion-furry-3") ||
            db.NAIImgModel.includes("nai-diffusion-2")
              ? db.NAIImgConfig.sm
              : undefined,
          sm_dyn:
            db.NAIImgModel.includes("nai-diffusion-3") ||
            db.NAIImgModel.includes("nai-diffusion-furry-3")
              ? db.NAIImgConfig.sm_dyn
              : undefined,
          noise_schedule: db.NAIImgConfig.noise_schedule,
          normalize_reference_strength_multiple: true,
          ucPreset: 3,
          uncond_scale: 1,
          qualityToggle: false,
          legacy_v3_extend: false,
          legacy: false,
          //add v4
          autoSmea: false,
          use_coords: false,
          legacy_uc: db.NAIImgConfig.legacy_uc,
          v4_prompt: {
            caption: {
              base_caption: genPrompt,
              char_captions: [],
            },
            use_coords: false,
            use_order: true,
          },
          v4_negative_prompt: {
            caption: {
              base_caption: neg,
              char_captions: [],
            },
            legacy_uc: db.NAIImgConfig.legacy_uc,
          },
          reference_image_multiple: [],
          reference_strength_multiple: [],
          //add reference image
          image: undefined,
          strength: undefined,
          noise: undefined,
          //add additional parameters
          seed: random(0, 2 ** 32 - 1),
          extra_noise_seed: random(0, 2 ** 32 - 1),
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
    // Add Variety+ option
    if (db.NAIImgConfig.variety_plus) {
      if (
        db.NAIImgModel.includes("nai-diffusion-4-full") ||
        db.NAIImgModel.includes("nai-diffusion-4-curated") ||
        db.NAIImgModel.includes("nai-diffusion-3") ||
        db.NAIImgModel.includes("nai-diffusion-furry-3")
      ) {
        commonReq.body.parameters.skip_cfg_above_sigma =
          Math.sqrt(db.NAIImgConfig.width * db.NAIImgConfig.height) * 0.01889;
      }
      if (
        db.NAIImgModel.includes("nai-diffusion-4-5-full") ||
        db.NAIImgModel.includes("nai-diffusion-4-5-curated")
      ) {
        commonReq.body.parameters.skip_cfg_above_sigma =
          Math.sqrt(db.NAIImgConfig.width * db.NAIImgConfig.height) * 0.05766;
      }
    }
    // Add vibe reference_image_multiple if exists
    if (
      db.NAIImgConfig.reference_mode === "vibe" &&
      db.NAIImgConfig.vibe_data
    ) {
      const vibeData = db.NAIImgConfig.vibe_data;
      // Determine which model to use based on vibe_model_selection or fallback to current model
      const modelKey =
        db.NAIImgConfig.vibe_model_selection ||
        (db.NAIImgModel.includes("nai-diffusion-4-full")
          ? "v4full"
          : db.NAIImgModel.includes("nai-diffusion-4-curated")
            ? "v4curated"
            : db.NAIImgModel.includes("nai-diffusion-4-5-full")
              ? "v4-5full"
              : db.NAIImgModel.includes("nai-diffusion-4-5-curated")
                ? "v4-5curated"
                : null);
      if (modelKey && vibeData.encodings && vibeData.encodings[modelKey]) {
        // Initialize arrays if they don't exist
        if (!commonReq.body.parameters.reference_image_multiple) {
          commonReq.body.parameters.reference_image_multiple = [];
        }
        if (!commonReq.body.parameters.reference_strength_multiple) {
          commonReq.body.parameters.reference_strength_multiple = [];
        }
        // Use selected encoding or first available
        let encodingKey = db.NAIImgConfig.vibe_model_selection
          ? Object.keys(vibeData.encodings[modelKey]).find(
              (key) =>
                vibeData.encodings[modelKey][key].params
                  .information_extracted ===
                (db.NAIImgConfig.InfoExtracted || 1),
            )
          : Object.keys(vibeData.encodings[modelKey])[0];
        if (encodingKey) {
          const encoding = vibeData.encodings[modelKey][encodingKey].encoding;
          // Add encoding to the array
          commonReq.body.parameters.reference_image_multiple.push(encoding);
          // Add reference_strength_multiple if it exists
          const strength =
            db.NAIImgConfig.reference_strength_multiple &&
            db.NAIImgConfig.reference_strength_multiple.length > 0
              ? db.NAIImgConfig.reference_strength_multiple[0]
              : 0.5;
          commonReq.body.parameters.reference_strength_multiple.push(strength);
        }
      }
    }
    if (
      db.NAIImgConfig.reference_mode === "character" &&
      (db.NAIImgModel.includes("nai-diffusion-4-5-full") ||
        db.NAIImgModel.includes("nai-diffusion-4-5-curated"))
    ) {
      let base64img = "";
      if (
        !db.NAIImgConfig.character_image ||
        db.NAIImgConfig.character_image === ""
      ) {
        const charimg = currentChar.image;
        const img = await readImage(charimg);
        if (img) {
          base64img = Buffer.from(img).toString("base64");
        }
      } else {
        base64img = db.NAIImgConfig.character_base64image;
      }
      base64img = await runtime.resizeReference(base64img);
      if (base64img) {
        commonReq.body.parameters.director_reference_descriptions = [
          {
            caption: {
              base_caption:
                "character" + (db.NAIImgConfig.style_aware ? "&style" : ""),
              char_captions: [],
            },
            legacy_uc: db.NAIImgConfig.legacy_uc,
          },
        ];
        commonReq.body.parameters.director_reference_images = [base64img];
        commonReq.body.parameters.director_reference_information_extracted = [
          1,
        ];
        commonReq.body.parameters.director_reference_strength_values = [1];
      }
    }
    if (db.NAII2I) {
      let seed = random(0, 1000000000);
      let base64img = "";
      if (!db.NAIImgConfig.image || db.NAIImgConfig.image === "") {
        const charimg = currentChar.image;
        const img = await readImage(charimg);
        if (img) {
          base64img = Buffer.from(img).toString("base64");
        }
      } else {
        base64img = db.NAIImgConfig.base64image;
      }
      if (base64img) {
        reqlist = commonReq;
        reqlist.body.action = "img2img";
        reqlist.body.parameters.image = base64img;
        reqlist.body.parameters.strength = db.NAIImgConfig.strength || 0.7;
        reqlist.body.parameters.noise = db.NAIImgConfig.noise || 0;
      }
    } else {
      reqlist = commonReq;
      reqlist.body.action = "generate";
    }
    try {
      const da = await globalFetch(db.NAIImgUrl, reqlist);
      {
        if (da.ok) {
          const img = await processZip(da.data);
          return img;
        } else {
          alertError(Buffer.from(da.data).toString());
          return "";
        }
      }
      return "";
    } catch (error) {
      alertError(error);
      return false;
    }
  }
  if (db.sdProvider === "dalle") {
    const da = await globalFetch(
      "https://api.openai.com/v1/images/generations",
      {
        body: {
          prompt: genPrompt,
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
    {
      let res = da?.data?.data?.[0]?.b64_json;
      if (!res) {
        alertError(JSON.stringify(da.data));
        return "";
      }
      return `data:image/png;base64,${res}`;
    }
    return "";
  }
  if (db.sdProvider === "stability") {
    const formData = new FormData();
    const model = db.stabilityModel;
    formData.append("prompt", genPrompt);
    if (model !== "core" && model !== "ultra") {
      formData.append("negative_prompt", neg);
      formData.append("model", model);
    }
    if (model === "core") {
      if (db.stabllityStyle) {
        formData.append("style_preset", db.stabllityStyle);
      }
    }
    if (model === "ultra") {
      formData.append("negative_prompt", neg);
    }
    const uri = model === "core" ? "core" : model === "ultra" ? "ultra" : "sd3";
    const da = await fetchNative(
      "https://api.stability.ai/v2beta/stable-image/generate/" + uri,
      {
        body: formData,
        headers: {
          authorization: "Bearer " + db.stabilityKey,
          accept: "image/*",
        },
        method: "POST",
      },
    );
    const res = await da.arrayBuffer();
    if (!da.ok) {
      alertError(Buffer.from(res).toString());
      return false;
    }
    if ((da.headers.get("content-type") ?? "").startsWith("application/json")) {
      alertError(Buffer.from(res).toString());
      return false;
    }
    {
      return `data:image/png;base64,${Buffer.from(res).toString("base64")}`;
    }
  }
  if (db.sdProvider === "comfy" || db.sdProvider === "comfyui") {
    const legacy = db.sdProvider === "comfy"; // Legacy Comfy mode
    const { workflow, posNodeID, posInputName, negNodeID, negInputName } =
      db.comfyConfig;
    const baseUrl = new URL(db.comfyUiUrl);
    /**
     * Builds a ComfyUI endpoint while preserving its optional API prefix and query parameters.
     *
     * 한국어: 선택적인 API 접두사·쿼리를 유지하며 ComfyUI 요청 주소를 구성하는 함수.
     */
    const createUrl = (
      pathname: string,
      params: Record<string, string> = {},
    ) => {
      const url = db.comfyUiUrl.endsWith("/api")
        ? new URL(`${db.comfyUiUrl}${pathname}`)
        : new URL(pathname, baseUrl);
      url.search = new URLSearchParams(params).toString();
      return url.toString();
    };
    /**
     * Sends a ComfyUI JSON request and rejects unsuccessful provider responses.
     *
     * 한국어: ComfyUI JSON 요청을 보내고 실패 응답을 예외로 처리하는 함수.
     */
    const fetchWrapper = async (url: string, options = {}) => {
      const response = await globalFetch(url, options);
      if (!response.ok) {
        throw new Error(JSON.stringify(response.data));
      }
      return response.data;
    };
    try {
      const prompt = JSON.parse(workflow);
      if (legacy) {
        prompt[posNodeID].inputs[posInputName] = genPrompt;
        prompt[negNodeID].inputs[negInputName] = neg;
      } else {
        //search all nodes for the prompt and negative prompt
        const keys = Object.keys(prompt);
        for (let i = 0; i < keys.length; i++) {
          const node = prompt[keys[i]];
          const inputKeys = Object.keys(node.inputs);
          for (let j = 0; j < inputKeys.length; j++) {
            let input = node.inputs[inputKeys[j]];
            if (typeof input === "string") {
              input = input.replaceAll("{{risu_prompt}}", genPrompt);
              input = input.replaceAll("{{risu_neg}}", neg);
            }
            if (inputKeys[j] === "seed" && typeof input === "number") {
              input = Math.floor(Math.random() * 1000000000);
            }
            node.inputs[inputKeys[j]] = input;
          }
        }
      }
      const { prompt_id: id } = await fetchWrapper(createUrl("/prompt"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { prompt: prompt },
      });
      let item;
      const startTime = Date.now();
      const timeout = db.comfyConfig.timeout * 1000;
      while (
        !(item = (
          await (
            await fetchNative(createUrl("/history"), {
              headers: { "Content-Type": "application/json" },
              method: "GET",
            })
          ).json()
        )[id])
      ) {
        if (Date.now() - startTime >= timeout) {
          alertError("Error: Image generation took longer than expected.");
          return false;
        }
        await new Promise((r) => setTimeout(r, 1000));
      } // Check history until the generation is complete.
      const genImgInfo = Object.values(item.outputs).flatMap(
        (output: any) => output.images,
      )[0];
      const imgResponse = await fetchNative(
        createUrl("/view", {
          filename: genImgInfo.filename,
          subfolder: genImgInfo.subfolder,
          type: genImgInfo.type,
        }),
        {
          headers: { "Content-Type": "application/json" },
          method: "GET",
        },
      );
      const img64 = Buffer.from(await imgResponse.arrayBuffer()).toString(
        "base64",
      );
      {
        return `data:image/png;base64,${img64}`;
      }
      return "";
    } catch (error) {
      alertError(error);
      return false;
    }
  }
  if (db.sdProvider === "kei") {
    alertError(
      "The Kei image provider is unavailable in Haejeok RisuAI because Risu Account integration has been removed.",
    );
    return false;
  }
  if (db.sdProvider === "fal") {
    const model = db.falModel;
    const token = db.falToken;
    let body: {
      [key: string]: any;
    } = {
      prompt: genPrompt,
      enable_safety_checker: false,
      sync_mode: true,
      image_size: {
        width: db.sdConfig.width,
        height: db.sdConfig.height,
      },
    };
    if (db.falModel === "fal-ai/flux-lora") {
      let loraPath = db.falLora;
      if (loraPath.startsWith("urn:") || loraPath.startsWith("civitai:")) {
        const id = loraPath.split("@").pop();
        loraPath = `https://civitai.com/api/download/models/${id}?type=Model&format=SafeTensor`;
      }
      body.loras = [
        {
          path: loraPath,
          scale: db.falLoraScale,
        },
      ];
    }
    if (db.falModel === "fal-ai/flux-pro") {
      delete body.enable_safety_checker;
    }
    const res = await globalFetch("https://fal.run/" + model, {
      headers: {
        Authorization: "Key " + token,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: body,
    });
    if (!res.ok) {
      alertError(JSON.stringify(res.data));
      return false;
    }
    let image = res.data?.images?.[0]?.url;
    if (!image) {
      alertError(JSON.stringify(res.data));
      return false;
    }
    {
      return image;
    }
  }
  if (db.sdProvider === "Imagen") {
    const model = db.ImagenModel;
    const size = db.ImagenImageSize;
    const aspect = db.ImagenAspectRatio;
    const person = db.ImagenPersonGeneration;
    let body: any = {
      instances: [
        {
          prompt: genPrompt,
        },
      ],
      parameters: {
        sampleCount: 1,
        aspectRatio: aspect,
        personGeneration: person,
      },
    };
    if (
      model === "imagen-4.0-generate-001" ||
      model === "imagen-4.0-ultra-generate-001"
    ) {
      body.parameters = {
        ...body.parameters,
        sampleImageSize: size,
      };
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${db.google.accessToken}`;
    const res = await globalFetch(url, {
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
      body: body,
    });
    if (!res.ok) {
      alertError(JSON.stringify(res.data));
      return false;
    }
    const img64 = res.data?.predictions?.[0]?.bytesBase64Encoded;
    if (!img64) {
      alertError(JSON.stringify(res.data));
      return false;
    }
    const mimeType = res.data?.predictions?.[0]?.mimeType || "image/png";
    return `data:${mimeType};base64,${img64}`;
  }
  if (db.sdProvider === "openai-compat") {
    const config = db.openaiCompatImage;
    if (!config.url) {
      alertError("OpenAI Compatible API URL is not set");
      return false;
    }
    const body: {
      [key: string]: any;
    } = {
      prompt: genPrompt,
      response_format: "b64_json",
      size: config.size || "1024x1024",
      quality: config.quality || "auto",
    };
    if (config.model) {
      body.model = config.model;
    }
    const headers: {
      [key: string]: string;
    } = {
      "Content-Type": "application/json",
    };
    if (config.key) {
      headers["Authorization"] = "Bearer " + config.key;
    }
    const da = await globalFetch(config.url, {
      body: body,
      headers: headers,
    });
    {
      let res = da?.data?.data?.[0]?.b64_json;
      if (!res) {
        alertError(JSON.stringify(da.data));
        return "";
      }
      return `data:image/png;base64,${res}`;
    }
  }
  if (db.sdProvider === "wavespeed") {
    const config = db.wavespeedImage;
    if (!config.key) {
      alertError("Please enter wavespeed API key");
      return false;
    }
    const body: {
      [key: string]: any;
    } = {};
    // Prompt
    body.prompt = genPrompt;
    // reference image
    let base64img = "";
    if (config.reference_mode === "image") {
      // reference: uploaded image
      base64img = config.reference_base64image;
    } else if (config.reference_mode === "character") {
      // reference: auto use the character's default image
      const charimg = currentChar.image;
      const img = await readImage(charimg);
      if (img) {
        base64img = Buffer.from(img).toString("base64");
      }
    }
    if (base64img) {
      body.images = [base64img];
    }
    // LoRAs
    if (config.loras && Array.isArray(config.loras)) {
      body.loras = [];
      for (const lora of config.loras) {
        if (lora && lora.path && lora.path.trim() !== "") {
          body.loras.push({
            path: lora.path,
            scale: typeof lora.scale === "number" ? lora.scale : 1.0,
          });
        }
      }
    }
    // Request
    try {
      // First: submit task
      const requestEndpoint = `https://api.wavespeed.ai/api/v3/${config.model}`;
      const requestResponse = await globalFetch(requestEndpoint, {
        body: body,
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.key,
        },
      });
      let requestId: string;
      if (requestResponse.ok) {
        /*
         * submit response:
         * {
         *   code: number = HTTP status code (e.g., 200 for success)
         *   message: string = Status message (e.g., “success”)
         *   data: {
         *     id: string = Unique identifier for the prediction, Task Id
         *   }
         * }
         * */
        requestId = requestResponse.data.data.id;
      } else {
        alertError(
          `Submit task failed ${requestResponse.status}: ${requestResponse.data}`,
        );
        return false;
      }
      // Second: monitor task
      const taskEndpoint = `https://api.wavespeed.ai/api/v3/predictions/${requestId}/result`;
      let resultEndpoint: string | undefined;
      const POLL_INTERVAL = 3000; // monitor every 3 seconds
      const MAX_WAIT_TIME = 10 * 60 * 1000; // 10 minutes absolute timeout
      const startTime = Date.now();
      while (true) {
        const elapsedTime = Date.now() - startTime;
        if (elapsedTime > MAX_WAIT_TIME) {
          alertError(`Task timeout after ${MAX_WAIT_TIME / 1000}s`);
          break;
        }
        const taskResponse = await globalFetch(taskEndpoint, {
          method: "GET",
          headers: {
            Authorization: "Bearer " + config.key,
          },
        });
        if (taskResponse.ok) {
          /*
           * monitor response:
           * {
           *   code: number = HTTP status code (e.g., 200 for success)
           *   message: string = Status message (e.g., “success”)
           *   data: {
           *     status: string = Status of the task: created, processing, completed, or failed
           *     outputs: string[] = Array of URLs to the generated content (empty when status is not completed)
           *   }
           * }
           * */
          if (taskResponse.data.data.status === "completed") {
            resultEndpoint = taskResponse.data.data.outputs[0];
            break;
          } else if (taskResponse.data.data.status === "failed") {
            alertError(JSON.stringify(taskResponse.data));
            break;
          }
          // else keep loop
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
        } else {
          alertError(JSON.stringify(taskResponse.data));
          break;
        }
      }
      if (!resultEndpoint) {
        alertError("Task finished but no result URL");
        return false;
      }
      // Third: get result
      const resultResponse = await globalFetch(resultEndpoint, {
        method: "GET",
        headers: {
          Authorization: "Bearer " + config.key,
        },
        rawResponse: true,
      });
      if (resultResponse.ok) {
        // mime-type: jpeg (default), png, webp
        const contentType =
          resultResponse.headers?.["content-type"] || "image/jpeg";
        const mimeType = contentType.split(";")[0]; // resolve "image/png; charset=utf-8"
        // binary image file, need to convert to base64
        const binary = resultResponse.data;
        const res = Buffer.from(binary).toString("base64");
        const img = `data:${mimeType};base64,${res}`;
        {
          return img;
        }
      } else {
        alertError(JSON.stringify(resultResponse.data));
        return false;
      }
    } catch (error) {
      alertError(error);
      return false;
    }
  }
  return "";
}
