import { prebuiltNAIpresets } from "../../process/templates/templates";
import { defaultColorScheme } from "../../gui/colorscheme";
import { safeStructuredClone } from "../../polyfill";
import { LLMFormat } from "../../model/types";
import type { botPreset, Database, PortableDatabase } from "../schema";
import { defaultAIN, defaultOoba } from "../presetDefaults";
import { normalizePromptTemplate } from "../presetService";

const supportedHypaModels = new Set([
  "custom",
  "ada",
  "openai3small",
  "openai3large",
  "voyageContext3",
]);

type LocalNetworkSettings = Pick<
  botPreset,
  "localNetworkMode" | "localNetworkTimeoutSec"
>;

function normalizeLocalNetworkSettings(settings: LocalNetworkSettings): void {
  settings.localNetworkMode ??= false;
  if (typeof settings.localNetworkMode !== "boolean") {
    settings.localNetworkMode = false;
  }

  settings.localNetworkTimeoutSec ??= 600;
  if (
    typeof settings.localNetworkTimeoutSec !== "number" ||
    Number.isNaN(settings.localNetworkTimeoutSec)
  ) {
    settings.localNetworkTimeoutSec = 600;
  }
}

function migrateOpenRouterProvider(
  value: unknown,
): Database["openrouterProvider"] | undefined {
  if (typeof value === "string") {
    return {
      order: value ? [value] : [],
      only: [],
      ignore: [],
    };
  }
  return value as Database["openrouterProvider"] | undefined;
}

function normalizePortablePreset(preset: botPreset): void {
  if (Array.isArray(preset.promptTemplate)) {
    preset.promptTemplate = normalizePromptTemplate(preset.promptTemplate);
  }
  normalizeLocalNetworkSettings(preset);
  preset.openrouterProvider = migrateOpenRouterProvider(preset.openrouterProvider);
}

function normalizeOllamaSettings(data: Database): void {
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
}

export function normalizeProviderDatabaseSettings(data: Database): void {
  const portableData = data as Database & Partial<PortableDatabase>;
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
  normalizeLocalNetworkSettings(data);
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
  data.google ??= {
    accessToken: "",
    projectId: "",
  };
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
  normalizeOllamaSettings(data);
  data.autoContinueChat ??= false;
  data.autoContinueMinTokens ??= 0;
  data.repetition_penalty ??= 1;
  data.min_p ??= 0;
  data.top_a ??= 0;
  data.customTokenizer ??= "tik";
  data.instructChatTemplate ??= "chatml";
  const migratedProvider = migrateOpenRouterProvider(data.openrouterProvider);
  if (migratedProvider) {
    data.openrouterProvider = migratedProvider;
  }
  for (const preset of portableData.botPresets ?? []) {
    normalizePortablePreset(preset);
  }
  data.openrouterProvider ??= {
    order: [],
    only: [],
    ignore: [],
  };
  data.openrouterProvider.order ??= [];
  data.openrouterProvider.only ??= [];
  data.openrouterProvider.ignore ??= [];
}
