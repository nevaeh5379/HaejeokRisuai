import { checkNullish } from "../util";
import { defaultAutoSuggestPrompt, defaultJailbreak, defaultMainPrompt } from "./defaultPrompts";
import { prebuiltNAIpresets } from "../process/templates/templates";
import { defaultColorScheme } from "../gui/colorscheme";
import { createHypaV3Preset } from "../process/memory/hypav3Preset";
import { normalizeTranslatorPresetState } from "../translator/presets";
import { isTauri, isNodeServer } from "../platform";
import { safeStructuredClone } from "../polyfill";
import {
  DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  normalizeChatLoadPages,
} from "../chatLoadPages";
import { defaultHotkeys } from "../defaulthotkeys";
import type { Database, PortableDatabase } from "./schema";
import { defaultAIN, defaultOoba, presetTemplate } from "./presetDefaults";
import { normalizePromptTemplate } from "./presetService";
import { LLMFormat } from "../model/types";
import type { StreamingDisplayOptimizationMode } from "./schema";

const supportedHypaModels = new Set([
  "custom",
  "ada",
  "openai3small",
  "openai3large",
  "voyageContext3",
]);

/**
 * Applies schema defaults and migrations without installing the database.
 * SQL adapters use this on their plain core-data snapshot without accessing
 * lazy domain getters, so a new or sparse SQL database receives the same
 * defaults as legacy storage without eagerly loading those domains.
 */
export function normalizeDatabaseDefaults(data: Database) {
  if (checkNullish(data.characters)) {
    data.characters = [];
  }
  if (checkNullish(data.apiType)) {
    data.apiType = "gemini-3-flash-preview";
  }
  if (checkNullish(data.openAIKey)) {
    data.openAIKey = "";
  }
  if (checkNullish(data.mainPrompt)) {
    data.mainPrompt = defaultMainPrompt;
  }
  if (checkNullish(data.jailbreak)) {
    data.jailbreak = defaultJailbreak;
  }
  if (checkNullish(data.globalNote)) {
    data.globalNote = ``;
  }
  if (checkNullish(data.temperature)) {
    data.temperature = 80;
  }
  if (checkNullish(data.maxContext)) {
    data.maxContext = 4000;
  }
  if (checkNullish(data.maxResponse)) {
    data.maxResponse = 500;
  }
  if (checkNullish(data.frequencyPenalty)) {
    data.frequencyPenalty = 70;
  }
  if (checkNullish(data.PresensePenalty)) {
    data.PresensePenalty = 70;
  }
  if (checkNullish(data.aiModel)) {
    data.aiModel = "gemini-3-flash-preview";
  }
  if (checkNullish(data.jailbreakToggle)) {
    data.jailbreakToggle = false;
  }
  if (checkNullish(data.formatingOrder)) {
    data.formatingOrder = [
      "main",
      "description",
      "personaPrompt",
      "chats",
      "lastChat",
      "jailbreak",
      "lorebook",
      "globalNote",
      "authorNote",
    ];
  }
  if (checkNullish(data.loreBookDepth)) {
    data.loreBookDepth = 5;
  }
  if (checkNullish(data.loreBookToken)) {
    data.loreBookToken = 800;
  }
  if (checkNullish(data.username)) {
    data.username = "User";
  }
  if (checkNullish(data.userIcon)) {
    data.userIcon = "";
  }
  if (checkNullish(data.userNote)) {
    data.userNote = "";
  }
  if (checkNullish(data.additionalPrompt)) {
    data.additionalPrompt =
      "The assistant must act as {{char}}. user is {{user}}.";
  }
  if (checkNullish(data.descriptionPrefix)) {
    data.descriptionPrefix = "description of {{char}}: ";
  }
  if (checkNullish(data.forceReplaceUrl)) {
    data.forceReplaceUrl = "";
  }
  if (checkNullish(data.language)) {
    data.language = "en";
  }
  if (checkNullish(data.swipe)) {
    data.swipe = true;
  }
  if (checkNullish(data.translator)) {
    data.translator = "";
  }
  if (checkNullish(data.translatorMaxResponse)) {
    data.translatorMaxResponse = 1000;
  }
  if (checkNullish(data.currentPluginProvider)) {
    data.currentPluginProvider = "";
  }
  if (checkNullish(data.plugins)) {
    data.plugins = [];
  }
  if (checkNullish(data.pluginCustomStorage)) {
    data.pluginCustomStorage = {};
  }
  if (checkNullish(data.zoomsize)) {
    data.zoomsize = 100;
  }
  if (checkNullish(data.customBackground)) {
    data.customBackground = "";
  }
  if (checkNullish(data.textgenWebUIStreamURL)) {
    data.textgenWebUIStreamURL = "wss://localhost/api/";
  }
  if (checkNullish(data.textgenWebUIBlockingURL)) {
    data.textgenWebUIBlockingURL = "https://localhost/api/";
  }
  if (checkNullish(data.autoTranslate)) {
    data.autoTranslate = false;
  }
  if (checkNullish(data.fullScreen)) {
    data.fullScreen = false;
  }
  if (checkNullish(data.playMessage)) {
    data.playMessage = false;
  }
  if (checkNullish(data.iconsize)) {
    data.iconsize = 100;
  }
  if (checkNullish(data.theme)) {
    data.theme = "";
  }
  if (checkNullish(data.subModel)) {
    data.subModel = "gemini-3-flash-preview";
  }
  if (checkNullish(data.waifuWidth)) {
    data.waifuWidth = 100;
  }
  if (checkNullish(data.waifuWidth2)) {
    data.waifuWidth2 = 100;
  }
  if (checkNullish(data.emotionPrompt)) {
    data.emotionPrompt = "";
  }
  if (checkNullish(data.proxyKey)) {
    data.proxyKey = "";
  }
  const portableData = data as Database & Partial<PortableDatabase>;
  if (checkNullish(portableData.botPresets)) {
    let defaultPreset = presetTemplate;
    defaultPreset.name = "Default";
    portableData.botPresets = [defaultPreset];
  }
  if (checkNullish(portableData.botPresetsId)) {
    portableData.botPresetsId = 0;
  }
  if (Array.isArray(data.promptTemplate)) {
    data.promptTemplate = normalizePromptTemplate(data.promptTemplate);
  } else {
    data.promptTemplate = [];
  }
  if (checkNullish(data.sdProvider)) {
    data.sdProvider = "";
  }
  if (checkNullish(data.webUiUrl)) {
    data.webUiUrl = "http://127.0.0.1:7860/";
  }
  if (checkNullish(data.sdSteps)) {
    data.sdSteps = 30;
  }
  if (checkNullish(data.sdCFG)) {
    data.sdCFG = 7;
  }
  if (checkNullish(data.NAIImgUrl)) {
    data.NAIImgUrl = "https://image.novelai.net/ai/generate-image";
  }
  if (checkNullish(data.NAIApiKey)) {
    data.NAIApiKey = "";
  }
  if (checkNullish(data.NAIImgModel)) {
    data.NAIImgModel = "nai-diffusion-4-5-full";
  }
  if (checkNullish(data.NAII2I)) {
    data.NAII2I = false;
  }
  if (checkNullish(data.NAIREF)) {
    data.NAIREF = false;
  }
  if (checkNullish(data.textTheme)) {
    data.textTheme = "standard";
  }
  if (checkNullish(data.emotionPrompt2)) {
    data.emotionPrompt2 = "";
  }
  if (checkNullish(data.requestRetrys)) {
    data.requestRetrys = 2;
  }
  if (checkNullish(data.useSayNothing)) {
    data.useSayNothing = true;
  }
  if (checkNullish(data.bias)) {
    data.bias = [];
  }
  if (checkNullish(data.showUnrecommended)) {
    data.showUnrecommended = false;
  }
  if (checkNullish(data.elevenLabKey)) {
    data.elevenLabKey = "";
  }
  if (checkNullish(data.voicevoxUrl)) {
    data.voicevoxUrl = "";
  }
  if (checkNullish(data.supaMemoryPrompt)) {
    data.supaMemoryPrompt = "";
  }
  if (checkNullish(data.showMemoryLimit)) {
    data.showMemoryLimit = false;
  }
  if (checkNullish(data.showFirstMessagePages)) {
    data.showFirstMessagePages = false;
  }
  if (checkNullish(data.supaMemoryKey)) {
    data.supaMemoryKey = "";
  }
  if (checkNullish(data.hypaMemoryKey)) {
    data.hypaMemoryKey = "";
  }
  if (checkNullish(data.voyageApiKey)) {
    data.voyageApiKey = "";
  }
  if (checkNullish(data.supaModelType)) {
    data.supaModelType = "none";
  }
  if (checkNullish(data.askRemoval)) {
    data.askRemoval = true;
  }
  if (checkNullish(data.sdConfig)) {
    data.sdConfig = {
      width: 512,
      height: 512,
      sampler_name: "Euler a",
      script_name: "",
      denoising_strength: 0.7,
      enable_hr: false,
      hr_scale: 1.25,
      hr_upscaler: "Latent",
    };
  }
  if (checkNullish(data.NAIImgConfig)) {
    data.NAIImgConfig = {
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
      v4_prompt: {
        caption: {
          base_caption: "",
          char_captions: [],
        },
        use_coords: false,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: {
          base_caption: "",
          char_captions: [],
        },
        legacy_uc: false,
      },
      variety_plus: false,
      decrisp: false,
      reference_mode: "",
      character_image: "",
      character_base64image: "",
      style_aware: false,
    };
  }
  //add NAI v4 (사용중인 사람용 추가 DB Init)
  if (checkNullish(data.NAIImgConfig.v4_prompt)) {
    data.NAIImgConfig.autoSmea = false;
    data.NAIImgConfig.use_coords = false;
    data.NAIImgConfig.legacy_uc = false;
    data.NAIImgConfig.v4_prompt = {
      caption: {
        base_caption: "",
        char_captions: [],
      },
      use_coords: false,
      use_order: true,
    };
    data.NAIImgConfig.v4_negative_prompt = {
      caption: {
        base_caption: "",
        char_captions: [],
      },
      legacy_uc: false,
    };
  }
  if (checkNullish(data.customTextTheme)) {
    data.customTextTheme = {
      FontColorStandard: "#f8f8f2",
      FontColorBold: "#f8f8f2",
      FontColorItalic: "#8C8D93",
      FontColorItalicBold: "#8C8D93",
      FontColorQuote1: "#8BE9FD",
      FontColorQuote2: "#FFB86C",
    };
  }
  if (checkNullish(data.hordeConfig)) {
    data.hordeConfig = {
      apiKey: "",
      model: "",
      softPrompt: "",
    };
  }
  if (checkNullish(data.novelai)) {
    data.novelai = {
      token: "",
      model: "clio-v1",
    };
  }
  if (checkNullish(data.loreBook)) {
    data.loreBookPage = 0;
    data.loreBook = [
      {
        name: "My First LoreBook",
        data: [],
      },
    ];
  }
  if (
    checkNullish(data.loreBookPage) ||
    data.loreBook.length < data.loreBookPage
  ) {
    data.loreBookPage = 0;
  }
  data.globalscript ??= [];
  data.sendWithEnter ??= true;
  data.autoSuggestPrompt ??= defaultAutoSuggestPrompt;
  data.autoSuggestPrefix ??= "";
  data.OAIPrediction ??= "";
  data.autoSuggestClean ??= true;
  data.imageCompression ??= true;
  data.enableBlockPartialEdit ??= false;
  data.enableDragPartialEdit ??= false;
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
      personaPrompt: "",
      icon: data.userIcon,
      note: data.userNote,
      largePortrait: false,
    },
  ];
  data.classicMaxWidth ??= false;
  data.ooba ??= safeStructuredClone(defaultOoba);
  data.ainconfig ??= safeStructuredClone(defaultAIN);
  data.openrouterKey ??= "";
  data.openrouterRequestModel ??= "openai/gpt-3.5-turbo";
  data.openrouterSubRequestModel ??= data.openrouterRequestModel;
  data.nanogptKey ??= "";
  data.nanogptRequestModel ??= "";
  data.nanogptRequestModelName ??= "";
  data.nanogptProvider ??= "";
  data.nanogptSubRequestModel ??= data.nanogptRequestModel;
  data.nanogptSubRequestModelName ??= data.nanogptRequestModelName;
  data.nanogptSubProvider ??= data.nanogptProvider;
  data.nanogptSubscriptionState ??= "";
  data.nanogptUseSubscriptionEndpoint ??= false;
  data.nanogptSubUseSubscriptionEndpoint ??=
    data.nanogptUseSubscriptionEndpoint;
  data.NAIsettings ??= safeStructuredClone(prebuiltNAIpresets);
  data.assetWidth ??= -1;
  data.chatLimitSize ??= -1;
  data.animationSpeed ??= 0.4;
  data.colorScheme ??= safeStructuredClone(defaultColorScheme);
  data.colorSchemeName ??= "default";
  data.customColorScheme ??= safeStructuredClone(
    data.colorSchemeName === "custom" ? data.colorScheme : defaultColorScheme,
  );
  data.NAIsettings.starter ??= "";
  data.hypaModel ??= "openai3small";
  if (!supportedHypaModels.has(data.hypaModel as string)) {
    data.hypaModel = "openai3small";
  }
  data.mancerHeader ??= "";
  data.emotionProcesser ??= "submodel";
  data.translatorType ??= "google";
  data.htmlTranslation ??= false;
  data.deeplOptions ??= {
    key: "",
    freeApi: false,
  };
  data.deeplXOptions ??= {
    url: "",
    token: "",
  };
  data.NAIadventure ??= false;
  data.NAIappendName ??= true;
  data.NAIsettings.cfg_scale ??= 1;
  data.NAIsettings.mirostat_tau ??= 0;
  data.NAIsettings.mirostat_lr ??= 1;
  data.autofillRequestUrl ??= true;
  data.customProxyRequestModel ??= "";
  data.customProxySubRequestModel ??= data.customProxyRequestModel;
  data.generationSeed ??= -1;
  data.newOAIHandle ??= true;
  data.localNetworkMode ??= false;
  if (typeof data.localNetworkMode !== "boolean") {
    data.localNetworkMode = false;
  }
  data.localNetworkTimeoutSec ??= 600;
  if (
    typeof data.localNetworkTimeoutSec !== "number" ||
    Number.isNaN(data.localNetworkTimeoutSec)
  ) {
    data.localNetworkTimeoutSec = 600;
  }
  data.gptVisionQuality ??= "low";
  data.huggingfaceKey ??= "";
  data.fishSpeechKey ??= "";
  data.presetRegex ??= [];
  data.reverseProxyOobaArgs ??= {
    mode: "instruct",
  };
  data.top_p ??= 1;
  if (typeof data.top_p !== "number") {
    //idk why type changes, but it does so this is a fix
    data.top_p = 1;
  }
  //@ts-expect-error data.google has required fields (accessToken, projectId), but we use empty object as default and populate below
  data.google ??= {};
  data.google.accessToken ??= "";
  data.google.projectId ??= "";
  data.genTime ??= 1;
  data.promptSettings ??= {
    assistantPrefill: "",
    postEndInnerFormat: "",
    sendChatAsSystem: false,
    sendName: false,
    utilOverride: false,
    customChainOfThought: false,
    maxThoughtTagDepth: -1,
  };
  data.promptSettings.assistantPrefill ??= "";
  data.promptSettings.postEndInnerFormat ??= "";
  data.promptSettings.sendChatAsSystem ??= false;
  data.promptSettings.sendName ??= false;
  data.promptSettings.utilOverride ??= false;
  data.promptSettings.customChainOfThought ??= false;
  data.keiServerURL ??= "";
  data.top_k ??= 0;
  data.promptSettings.maxThoughtTagDepth ??= -1;
  data.openrouterFallback ??= true;
  data.openrouterMiddleOut ??= false;
  data.removePunctuationHypa ??= true;
  data.memoryLimitThickness ??= 1;
  data.modules ??= [];
  data.enabledModules ??= [];
  data.moduleFolders ??= [];
  data.additionalParams ??= [];
  data.heightMode ??= "normal";
  data.antiClaudeOverload ??= false;
  data.maxSupaChunkSize ??= 1200;
  data.ollamaURL ??= "";
  data.ollamaModel ??= "";
  data.ollamaModelSource ??=
    data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud"
      ? "cloud"
      : "local";
  data.ollamaInputMode ??= "manual";
  data.ollamaRequestFormat ??= LLMFormat.Ollama;
  data.ollamaApiKey ??= "";
  data.ollamaModelName ??= "";
  data.ollamaCloudModel ??= "";
  data.ollamaCloudModelName ??= "";
  if (
    (data.aiModel === "ollama-cloud" || data.subModel === "ollama-cloud") &&
    !data.ollamaCloudModel
  ) {
    data.ollamaCloudModel = data.ollamaModel;
    data.ollamaCloudModelName = data.ollamaModelName;
  }
  data.ollamaSubModel ??= data.ollamaModel;
  data.ollamaSubModelName ??= data.ollamaModelName;
  data.ollamaCloudSubModel ??= data.ollamaCloudModel;
  data.ollamaCloudSubModelName ??= data.ollamaCloudModelName;
  data.ollamaThinkingMode ??= "auto";
  data.autoContinueChat ??= false;
  data.autoContinueMinTokens ??= 0;
  data.repetition_penalty ??= 1;
  data.min_p ??= 0;
  data.top_a ??= 0;
  data.customTokenizer ??= "tik";
  data.instructChatTemplate ??= "chatml";
  // Migration: convert old string type into new provider object
  if (typeof data.openrouterProvider === "string") {
    const oldProvider = data.openrouterProvider as unknown as string;
    data.openrouterProvider = {
      order: oldProvider ? [oldProvider] : [],
      only: [],
      ignore: [],
    };
  }
  if (portableData.botPresets) {
    for (const preset of portableData.botPresets) {
      if (Array.isArray(preset.promptTemplate)) {
        preset.promptTemplate = normalizePromptTemplate(preset.promptTemplate);
      }
      preset.localNetworkMode ??= false;
      preset.localNetworkTimeoutSec ??= 600;
      if (typeof preset.localNetworkMode !== "boolean") {
        preset.localNetworkMode = false;
      }
      if (
        typeof preset.localNetworkTimeoutSec !== "number" ||
        Number.isNaN(preset.localNetworkTimeoutSec)
      ) {
        preset.localNetworkTimeoutSec = 600;
      }
      if (typeof preset.openrouterProvider === "string") {
        const oldProvider = preset.openrouterProvider as unknown as string;
        preset.openrouterProvider = {
          order: oldProvider ? [oldProvider] : [],
          only: [],
          ignore: [],
        };
      }
    }
  }
  data.openrouterProvider ??= {
    order: [],
    only: [],
    ignore: [],
  };
  data.openrouterProvider.order ??= [];
  data.openrouterProvider.only ??= [];
  data.openrouterProvider.ignore ??= [];
  data.useInstructPrompt ??= false;
  data.hanuraiEnable ??= false;
  data.hanuraiSplit ??= false;
  data.hanuraiTokens ??= 1000;
  data.textAreaSize ??= 0;
  data.sideBarSize ??= 0;
  data.textAreaTextSize ??= 0;
  data.combineTranslation ??= false;
  data.customPromptTemplateToggle ??= "";
  data.globalChatVariables ??= {};
  data.templateDefaultVariables ??= "";
  data.hypaAllocatedTokens ??= 3000;
  data.hypaChunkSize ??= 3000;
  data.dallEQuality ??= "standard";
  data.customTextTheme.FontColorQuote1 ??= "#8BE9FD";
  data.customTextTheme.FontColorQuote2 ??= "#FFB86C";
  data.font ??= "default";
  data.customFont ??= "";
  data.lineHeight ??= 1.25;
  data.stabilityModel ??= "sd3-large";
  data.stabllityStyle ??= "";
  data.legacyTranslation ??= false;
  data.comfyUiUrl ??= "http://localhost:8188";
  data.comfyConfig ??= {
    workflow: "",
    posNodeID: "",
    posInputName: "text",
    negNodeID: "",
    negInputName: "text",
    timeout: 30,
  };
  data.hideApiKey ??= true;
  data.unformatQuotes ??= false;
  data.ttsAutoSpeech ??= false;
  data.autoColorAdapt ??= false;
  data.colorAdaptEngine ??= "oklch";
  data.translatorInputLanguage ??= "auto";
  data.falModel ??= "fal-ai/flux/dev";
  data.falLoraScale ??= 1;
  data.customCSS ??= "";
  data.strictJsonSchema ??= true;
  data.statics ??= {
    messages: 0,
    imports: 0,
  };
  data.customQuotes ??= false;
  data.customQuotesData ??= ["“", "”", "‘", "’"];
  data.groupOtherBotRole ??= "user";
  data.customGUI ??= "";
  data.customAPIFormat ??= LLMFormat.OpenAICompatible;
  data.systemContentReplacement ??= `system: {{slot}}`;
  data.systemRoleReplacement ??= "user";
  data.vertexAccessToken ??= "";
  data.vertexAccessTokenExpires ??= 0;
  data.vertexClientEmail ??= "";
  data.vertexPrivateKey ??= "";
  data.vertexRegion ??= "global";
  data.seperateParametersEnabled ??= false;
  data.seperateParameters ??= {
    memory: {},
    emotion: {},
    translate: {},
    otherAx: {},
    overrides: {},
  };
  data.seperateParameters.memory ??= {};
  data.seperateParameters.emotion ??= {};
  data.seperateParameters.translate ??= {};
  data.seperateParameters.otherAx ??= {};
  data.seperateParameters.overrides ??= {};
  data.customFlags ??= [];
  data.enableCustomFlags ??= false;
  data.assetMaxDifference ??= 4;
  data.showSavingIcon ??= false;
  data.banCharacterset ??= [];
  data.showPromptComparison ??= false;
  data.OaiCompAPIKeys ??= {};
  data.reasoningEffort ??= 0;
  data.verbosity ??= 1;
  data.hypaV3Presets ??= [
    createHypaV3Preset("Default", {
      summarizationPrompt: data.supaMemoryPrompt ? data.supaMemoryPrompt : "",
      ...data.hypaV3Settings,
    }),
  ];
  if (data.hypaV3Presets.length > 0) {
    data.hypaV3Presets = data.hypaV3Presets.map((preset, i) =>
      createHypaV3Preset(
        preset.name || `Preset ${i + 1}`,
        preset.settings || {},
      ),
    );
  }
  data.hypaV3PresetId ??= 0;
  normalizeTranslatorPresetState(data);
  data.showDeprecatedTriggerV2 ??= false;
  data.returnCSSError ??= true;
  data.realmDirectOpen ??= false;
  data.checkCorruption ??= false;
  data.toggleConfirmRecommendedPreset ??= false;
  data.useExperimentalGoogleTranslator ??= false;
  data.thinkingType ??= "budget";
  data.deepseekThinkingType ??= "off";
  data.adaptiveThinkingEffort ??= "high";
  data.deepseekReasoningEffort ??= "high";
  if (data.antiClaudeOverload) {
    //migration
    data.antiClaudeOverload = false;
    data.antiServerOverloads = true;
  }
  data.hypaCustomSettings = {
    url: data.hypaCustomSettings?.url ?? "",
    key: data.hypaCustomSettings?.key ?? "",
    model: data.hypaCustomSettings?.model ?? "",
  };
  data.doNotChangeSeperateModels ??= false;
  data.seperateModelsForAxModels ??= false;
  data.seperateModels ??= {
    memory: "",
    emotion: "",
    translate: "",
    otherAx: "",
  };
  data.seperateModels.memory ??= "";
  data.seperateModels.emotion ??= "";
  data.seperateModels.translate ??= "";
  data.seperateModels.otherAx ??= "";
  data.modelTools ??= [];
  data.enableScrollToActiveChar ??= true;

  // Merge existing hotkeys with new default hotkeys
  if (!data.hotkeys) {
    data.hotkeys = safeStructuredClone(defaultHotkeys);
  } else {
    const existingActions = new Set(data.hotkeys.map((h) => h.action));
    const newHotkeys = defaultHotkeys.filter(
      (h) => !existingActions.has(h.action),
    );
    if (newHotkeys.length > 0) {
      data.hotkeys.push(...safeStructuredClone(newHotkeys));
    }
  }

  // Remove scrollToActiveChar hotkey if feature is disabled
  if (data.enableScrollToActiveChar === false) {
    data.hotkeys = data.hotkeys.filter(
      (h) => h.action !== "scrollToActiveChar",
    );
  }

  data.fallbackModels ??= {
    memory: [],
    emotion: [],
    translate: [],
    otherAx: [],
    model: [],
  };
  data.fallbackModels.model ??= [];
  data.fallbackModels.memory ??= [];
  data.fallbackModels.emotion ??= [];
  data.fallbackModels.translate ??= [];
  data.fallbackModels.otherAx ??= [];
  data.fallbackModels = {
    model: data.fallbackModels.model.filter((v) => v !== ""),
    memory: data.fallbackModels.memory.filter((v) => v !== ""),
    emotion: data.fallbackModels.emotion.filter((v) => v !== ""),
    translate: data.fallbackModels.translate.filter((v) => v !== ""),
    otherAx: data.fallbackModels.otherAx.filter((v) => v !== ""),
  };
  data.customModels ??= [];
  data.authRefreshes ??= [];
  data.openAIFlexProcessing ??= false;
  data.rememberToolUsage ??= true;
  data.simplifiedToolUse ??= false;
  data.streamGeminiThoughts ??= false;
  data.settingsCloseButtonSize ??= 24;
  data.hideAllImages ??= false;
  data.lowSpecMode ??= false;
  data.blurHiddenCharacters ??= true;
  data.characterFavorites ??= [];
  data.characterHidden ??= [];
  data.ImagenModel ??= "imagen-4.0-generate-001";
  data.ImagenImageSize ??= "1K";
  data.ImagenAspectRatio ??= "1:1";
  data.ImagenPersonGeneration ??= "allow_all";
  data.openaiCompatImage ??= {
    url: "",
    key: "",
    model: "",
    size: "1024x1024",
    quality: "auto",
  };
  data.wavespeedImage ??= {
    key: "",
    model: "",
    loras: [],
    reference_mode: "",
    reference_image: "",
    reference_base64image: "",
  };
  data.autoScrollToNewMessage ??= true;
  data.alwaysScrollToNewMessage ??= false;
  data.newMessageButtonStyle ??= "bottom-center";
  data.chatLoadInitialPages = normalizeChatLoadPages(
    data.chatLoadInitialPages,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  );
  data.chatLoadAdditionalPages = normalizeChatLoadPages(
    data.chatLoadAdditionalPages,
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  );
  data.streamingDisplayOptimizationMode ??=
    (data as { largeChatPerformanceMode?: StreamingDisplayOptimizationMode })
      .largeChatPerformanceMode ?? "off";
  delete (data as { largeChatPerformanceMode?: unknown })
    .largeChatPerformanceMode;
  data.echoMessage ??= "Echo Message";
  data.echoDelay ??= 0;
  if (!isNodeServer && !isTauri) {
    //this is intended to forcely reduce the size of the database in web
    data.promptInfoInsideChat = false;
  }
  data.createFolderOnBranch ??= true;
  data.hamburgerButtonBottom ??= false;
  data.dynamicModelRegistry ??= true;
  data.saveSignatures ??= false;
  // If the user uses plugins, its probably better to enable RisuAI Pro Tools by default
  // Because its likely they are power users who would benefit from the features
  data.enableRisuaiProTools ??= data.plugins.length > 0;
  data.keepSessionAlive ??= "off";
  data.loadouts ??= [];
  data.longPressToPopupEditor ??= false;
  data.customSidebarItems ??= [];
  data.moveInsteadOfCopyOnCMPConvert ??= false;
  data.skipSavingAssetsOnWebSync ??= true;
  data.resizeTextarea ??= false;
  data.coldstorage ??= data?.plugins?.length === 0;
  for (const char of data.characters) {
    for (const chat of char.chats ?? []) {
      chat.isStreaming = false;
      chat.activeStreamingDisplayOptimizationMode = undefined;
    }
  }
  return data;
}
