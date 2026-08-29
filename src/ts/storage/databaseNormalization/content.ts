import { defaultAutoSuggestPrompt } from "../defaultPrompts";
import type { Database } from "../schema";
import {
  defaultBoolean,
  defaultNumber,
  defaultString,
  mergeDefaults,
  parseDefaults,
} from "./valibotDefaults";

const contentScalarDefaults = {
  sdProvider: defaultString(),
  webUiUrl: defaultString("http://127.0.0.1:7860/"),
  sdSteps: defaultNumber(30),
  sdCFG: defaultNumber(7),
  NAIImgUrl: defaultString("https://image.novelai.net/ai/generate-image"),
  NAIApiKey: defaultString(),
  NAIImgModel: defaultString("nai-diffusion-4-5-full"),
  NAII2I: defaultBoolean(false),
  NAIREF: defaultBoolean(false),
  textTheme: defaultString("standard"),
  emotionPrompt2: defaultString(),
  requestRetrys: defaultNumber(2),
  useSayNothing: defaultBoolean(true),
  showUnrecommended: defaultBoolean(false),
  elevenLabKey: defaultString(),
  voicevoxUrl: defaultString(),
  supaMemoryPrompt: defaultString(),
  showMemoryLimit: defaultBoolean(false),
  showFirstMessagePages: defaultBoolean(false),
  supaMemoryKey: defaultString(),
  hypaMemoryKey: defaultString(),
  voyageApiKey: defaultString(),
  supaModelType: defaultString("none"),
  askRemoval: defaultBoolean(true),
  selectedPersona: defaultNumber(0),
  personaPrompt: defaultString(),
  sendWithEnter: defaultBoolean(true),
  autoSuggestPrompt: defaultString(defaultAutoSuggestPrompt),
  autoSuggestPrefix: defaultString(),
  OAIPrediction: defaultString(),
  autoSuggestClean: defaultBoolean(true),
  imageCompression: defaultBoolean(true),
  enableBlockPartialEdit: defaultBoolean(false),
  enableDragPartialEdit: defaultBoolean(false),
};

const sdConfigDefaults = {
  width: defaultNumber(512),
  height: defaultNumber(512),
  sampler_name: defaultString("Euler a"),
  script_name: defaultString(),
  denoising_strength: defaultNumber(0.7),
  enable_hr: defaultBoolean(false),
  hr_scale: defaultNumber(1.25),
  hr_upscaler: defaultString("Latent"),
};

const textThemeDefaults = {
  FontColorStandard: defaultString("#f8f8f2"),
  FontColorBold: defaultString("#f8f8f2"),
  FontColorItalic: defaultString("#8C8D93"),
  FontColorItalicBold: defaultString("#8C8D93"),
  FontColorQuote1: defaultString("#8BE9FD"),
  FontColorQuote2: defaultString("#FFB86C"),
};

const hordeConfigDefaults = {
  apiKey: defaultString(),
  model: defaultString(),
  softPrompt: defaultString(),
};

const novelAiDefaults = {
  token: defaultString(),
  model: defaultString("clio-v1"),
};

export type ContentValidatedDefaults = Required<
  Pick<
    Database,
    | keyof typeof contentScalarDefaults
    | "sdConfig"
    | "customTextTheme"
    | "hordeConfig"
    | "novelai"
  >
>;

function createNovelAiV4Prompt() {
  return {
    caption: {
      base_caption: "",
      char_captions: [],
    },
    use_coords: false,
    use_order: true,
  };
}

function createNovelAiV4NegativePrompt() {
  return {
    caption: {
      base_caption: "",
      char_captions: [],
    },
    legacy_uc: false,
  };
}

function migrateNovelAiV4Config(data: Database): void {
  if (data.NAIImgConfig.v4_prompt != null) return;

  data.NAIImgConfig.autoSmea = false;
  data.NAIImgConfig.use_coords = false;
  data.NAIImgConfig.legacy_uc = false;
  data.NAIImgConfig.v4_prompt = createNovelAiV4Prompt();
  data.NAIImgConfig.v4_negative_prompt = createNovelAiV4NegativePrompt();
}

function normalizeLoreBookState(data: Database): void {
  if (data.loreBook == null) {
    data.loreBookPage = 0;
    data.loreBook = [{ name: "My First LoreBook", data: [] }];
  }
  if (data.loreBookPage == null || data.loreBook.length < data.loreBookPage) {
    data.loreBookPage = 0;
  }
}

function normalizeLegacyPersonaState(data: Database): void {
  if (!data.formatingOrder.includes("personaPrompt")) {
    data.formatingOrder.splice(
      data.formatingOrder.indexOf("main"),
      0,
      "personaPrompt",
    );
  }
  data.personas ??= [
    {
      name: data.username,
      personaPrompt: data.personaPrompt,
      icon: data.userIcon,
      note: data.userNote,
      largePortrait: false,
    },
  ];
}

export function normalizeContentDatabaseSettings(data: Database): void {
  Object.assign(data, parseDefaults(contentScalarDefaults, data));
  data.bias ??= [];
  data.sdConfig = mergeDefaults(sdConfigDefaults, data.sdConfig);
  data.NAIImgConfig ??= {
    width: 1024,
    height: 1024,
    sampler: "k_euler_ancestral",
    noise_schedule: "karras",
    steps: 28,
    scale: 5,
    cfg_rescale: 0,
    sm: true,
    sm_dyn: false,
    noise: 0.0,
    strength: 0.6,
    image: "",
    base64image: "",
    InfoExtracted: 1,
    //add 4
    autoSmea: false,
    legacy_uc: false,
    use_coords: false,
    v4_prompt: createNovelAiV4Prompt(),
    v4_negative_prompt: createNovelAiV4NegativePrompt(),
    variety_plus: false,
    decrisp: false,
    reference_mode: "",
    character_image: "",
    character_base64image: "",
    style_aware: false,
  };
  migrateNovelAiV4Config(data);
  data.customTextTheme = mergeDefaults(
    textThemeDefaults,
    data.customTextTheme,
  );
  data.hordeConfig = mergeDefaults(hordeConfigDefaults, data.hordeConfig);
  data.novelai = mergeDefaults(novelAiDefaults, data.novelai);
  normalizeLoreBookState(data);
  data.globalscript ??= [];
  normalizeLegacyPersonaState(data);
}
