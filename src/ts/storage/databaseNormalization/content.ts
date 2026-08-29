import { defaultAutoSuggestPrompt } from "../defaultPrompts";
import type { Database } from "../schema";

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
  data.selectedPersona ??= 0;
  data.personaPrompt ??= "";
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
  data.sdProvider ??= "";
  data.webUiUrl ??= "http://127.0.0.1:7860/";
  data.sdSteps ??= 30;
  data.sdCFG ??= 7;
  data.NAIImgUrl ??= "https://image.novelai.net/ai/generate-image";
  data.NAIApiKey ??= "";
  data.NAIImgModel ??= "nai-diffusion-4-5-full";
  data.NAII2I ??= false;
  data.NAIREF ??= false;
  data.textTheme ??= "standard";
  data.emotionPrompt2 ??= "";
  data.requestRetrys ??= 2;
  data.useSayNothing ??= true;
  data.bias ??= [];
  data.showUnrecommended ??= false;
  data.elevenLabKey ??= "";
  data.voicevoxUrl ??= "";
  data.supaMemoryPrompt ??= "";
  data.showMemoryLimit ??= false;
  data.showFirstMessagePages ??= false;
  data.supaMemoryKey ??= "";
  data.hypaMemoryKey ??= "";
  data.voyageApiKey ??= "";
  data.supaModelType ??= "none";
  data.askRemoval ??= true;
  data.sdConfig ??= {
    width: 512,
    height: 512,
    sampler_name: "Euler a",
    script_name: "",
    denoising_strength: 0.7,
    enable_hr: false,
    hr_scale: 1.25,
    hr_upscaler: "Latent",
  };
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
  data.customTextTheme ??= {
    FontColorStandard: "#f8f8f2",
    FontColorBold: "#f8f8f2",
    FontColorItalic: "#8C8D93",
    FontColorItalicBold: "#8C8D93",
    FontColorQuote1: "#8BE9FD",
    FontColorQuote2: "#FFB86C",
  };
  data.hordeConfig ??= {
    apiKey: "",
    model: "",
    softPrompt: "",
  };
  data.novelai ??= {
    token: "",
    model: "clio-v1",
  };
  normalizeLoreBookState(data);
  data.globalscript ??= [];
  data.sendWithEnter ??= true;
  data.autoSuggestPrompt ??= defaultAutoSuggestPrompt;
  data.autoSuggestPrefix ??= "";
  data.OAIPrediction ??= "";
  data.autoSuggestClean ??= true;
  data.imageCompression ??= true;
  data.enableBlockPartialEdit ??= false;
  data.enableDragPartialEdit ??= false;
  normalizeLegacyPersonaState(data);
}
