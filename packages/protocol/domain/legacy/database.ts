import type { character, groupChat } from "./character.ts";
import type { loreBook } from "./lorebook.ts";
import type { RisuPlugin } from "./plugin.ts";
import type { botPreset } from "./preset.ts";
import type { customscript } from "./script.ts";
import type { RisuPersona } from "./persona.ts";
import type { RisuModule } from "./module.ts";
import type { StreamingDisplayOptimizationMode } from "./chat.ts";
import type { NAISettings } from "../naiSettings.ts";
import type { ColorScheme } from "../colorScheme.ts";
import type { PromptItem, PromptSettings } from "../promptTypes.ts";
import type { OobaChatCompletionRequestParams } from "../ooba.ts";
import type { TranslatorPreset } from "../translatorPresets.ts";
import type { Hotkey } from "../hotkeys.ts";
import type { Loadout } from "../loadout.ts";
import type { LLMFlagValue as LLMFlags } from "../../modelFlags.ts";
import type { LLMFormatValue as LLMFormat } from "../../modelFormat.ts";
import type { LLMTokenizerValue as LLMTokenizer } from "../../modelTokenizer.ts";

/** Upstream compatibility declarations, kwaroran/Risuai@39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. */
export interface Database {
  characters: (character | groupChat)[];
  apiType: string;
  openAIKey: string;
  proxyKey: string;
  mainPrompt: string;
  jailbreak: string;
  globalNote: string;
  temperature: number;
  askRemoval: boolean;
  maxContext: number;
  maxResponse: number;
  frequencyPenalty: number;
  PresensePenalty: number;
  formatingOrder: FormatingOrderItem[];
  aiModel: string;
  jailbreakToggle: boolean;
  loreBookDepth: number;
  loreBookToken: number;
  cipherChat: boolean;
  loreBook: {
    name: string;
    data: loreBook[];
  }[];
  loreBookPage: number;
  supaMemoryPrompt: string;
  username: string;
  userIcon: string;
  userNote: string;
  additionalPrompt: string;
  descriptionPrefix: string;
  forceReplaceUrl: string;
  language: string;
  translator: string;
  plugins: RisuPlugin[];
  currentPluginProvider: string;
  zoomsize: number;
  customBackground: string;
  textgenWebUIStreamURL: string;
  textgenWebUIBlockingURL: string;
  autoTranslate: boolean;
  fullScreen: boolean;
  playMessage: boolean;
  iconsize: number;
  theme: string;
  subModel: string;
  emotionPrompt: string;
  formatversion: number;
  waifuWidth: number;
  waifuWidth2: number;
  botPresets: botPreset[];
  botPresetsId: number;
  sdProvider: string;
  webUiUrl: string;
  sdSteps: number;
  sdCFG: number;
  sdConfig: sdConfig;
  NAIImgUrl: string;
  NAIApiKey: string;
  NAIImgModel: string;
  NAII2I: boolean;
  NAIREF: boolean;
  NAIImgConfig: NAIImgConfig;
  ttsAutoSpeech?: boolean;
  promptPreprocess: boolean;
  bias: [string, number][];
  swipe: boolean;
  instantRemove: boolean;
  textTheme: string;
  customTextTheme: {
    FontColorStandard: string;
    FontColorBold: string;
    FontColorItalic: string;
    FontColorItalicBold: string;
    FontColorQuote1: string;
    FontColorQuote2: string;
  };
  requestRetrys: number;
  localNetworkMode: boolean;
  localNetworkTimeoutSec: number;
  emotionPrompt2: string;
  useSayNothing: boolean;
  didFirstSetup: boolean;
  showUnrecommended: boolean;
  elevenLabKey: string;
  voicevoxUrl: string;
  useExperimental: boolean;
  showMemoryLimit: boolean;
  roundIcons: boolean;
  useStreaming: boolean;
  supaMemoryKey: string;
  hypaMemoryKey: string;
  voyageApiKey: string;
  supaModelType: string;
  textScreenColor?: string;
  textBorder?: boolean;
  textScreenRounded?: boolean;
  textScreenBorder?: string;
  characterOrder: (string | folder)[];
  hordeConfig: hordeConfig;
  novelai: {
    token: string;
    model: string;
  };
  globalscript: customscript[];
  sendWithEnter: boolean;
  fixedChatTextarea: boolean;
  clickToEdit: boolean;
  enableBlockPartialEdit: boolean;
  enableDragPartialEdit: boolean;
  koboldURL: string;
  useAutoSuggestions: boolean;
  autoSuggestPrompt: string;
  autoSuggestPrefix: string;
  autoSuggestClean: boolean;
  claudeAPIKey: string;
  useChatCopy: boolean;
  novellistAPI: string;
  useAutoTranslateInput: boolean;
  imageCompression: boolean;
  account?: {
    token: string;
    id: string;
    data: {
      refresh_token?: string;
      access_token?: string;
      expires_in?: number;
    };
    useSync?: boolean;
    kei?: boolean;
  };
  classicMaxWidth: boolean;
  useChatSticker: boolean;
  useAdditionalAssetsPreview: boolean;
  usePlainFetch: boolean;
  hypaMemory: boolean;
  hypav2: boolean;
  memoryAlgorithmType: string; // To enable new memory module/algorithms
  proxyRequestModel: string;
  ooba: OobaSettings;
  ainconfig: AINsettings;
  personaPrompt: string;
  openrouterRequestModel: string;
  openrouterKey: string;
  openrouterMiddleOut: boolean;
  nanogptKey: string;
  nanogptRequestModel: string;
  nanogptRequestModelName: string;
  nanogptProvider: string;
  nanogptSubscriptionState: string;
  nanogptUseSubscriptionEndpoint: boolean;
  openrouterFallback: boolean;
  selectedPersona: number;
  personas: RisuPersona[];
  assetWidth: number;
  animationSpeed: number;
  botSettingAtStart: false;
  NAIsettings: NAISettings;
  hideRealm: boolean;
  blockedRealmCreators: BlockedRealmCreator[];
  colorScheme: ColorScheme;
  colorSchemeName: string;
  customColorScheme: ColorScheme;
  promptTemplate?: PromptItem[];
  forceProxyAsOpenAI?: boolean;
  hypaModel: HypaModel;
  saveTime?: number;
  mancerHeader: string;
  emotionProcesser: "submodel" | "embedding";
  showMenuChatList?: boolean;
  translatorType: "google" | "deepl" | "none" | "llm" | "deeplX" | "bergamot";
  translatorInputLanguage?: string;
  htmlTranslation?: boolean;
  NAIadventure?: boolean;
  NAIappendName?: boolean;
  deeplOptions: {
    key: string;
    freeApi: boolean;
  };
  deeplXOptions: {
    url: string;
    token: string;
  };
  localStopStrings?: string[];
  autofillRequestUrl: boolean;
  customProxyRequestModel: string;
  generationSeed: number;
  newOAIHandle: boolean;
  gptVisionQuality: string;
  reverseProxyOobaMode: boolean;
  reverseProxyOobaArgs: OobaChatCompletionRequestParams;
  huggingfaceKey: string;
  fishSpeechKey: string;
  allowAllExtentionFiles?: boolean;
  translatorPrompt: string;
  translatorMaxResponse: number;
  translatorPresets: TranslatorPreset[];
  translatorPresetId: number;
  top_p: number;
  google: {
    accessToken: string;
    projectId: string;
  };
  mistralKey?: string;
  chainOfThought?: boolean;
  genTime: number;
  promptSettings: PromptSettings;
  keiServerURL: string;
  top_k: number;
  repetition_penalty: number;
  min_p: number;
  top_a: number;
  claudeAws: boolean;
  lastPatchNoteCheckVersion?: string;
  removePunctuationHypa?: boolean;
  memoryLimitThickness?: number;
  modules: RisuModule[];
  enabledModules: string[];
  sideMenuRerollButton?: boolean;
  requestInfoInsideChat?: boolean;
  additionalParams: [string, string][];
  applyAdditionalParamsToAll: boolean;
  heightMode: string;
  noWaitForTranslate: boolean;
  antiClaudeOverload: boolean;
  maxSupaChunkSize: number;
  ollamaURL: string;
  ollamaModel: string;
  ollamaModelSource: "local" | "cloud";
  ollamaInputMode: "list" | "manual";
  ollamaRequestFormat: LLMFormat;
  ollamaApiKey: string;
  ollamaModelName: string;
  ollamaCloudModel: string;
  ollamaCloudModelName: string;
  ollamaThinkingMode: "auto" | "off" | "on" | "low" | "medium" | "high";
  autoContinueChat: boolean;
  autoContinueMinTokens: number;
  removeIncompleteResponse: boolean;
  customTokenizer: string;
  instructChatTemplate: string;
  JinjaTemplate: string;
  openrouterProvider: {
    order: string[];
    only: string[];
    ignore: string[];
  };
  useInstructPrompt: boolean;
  hanuraiTokens: number;
  hanuraiSplit: boolean;
  hanuraiEnable: boolean;
  textAreaSize: number;
  sideBarSize: number;
  textAreaTextSize: number;
  combineTranslation: boolean;
  dynamicAssets: boolean;
  dynamicAssetsEditDisplay: boolean;
  customPromptTemplateToggle: string;
  globalChatVariables: { [key: string]: string };
  templateDefaultVariables: string;
  hypaAllocatedTokens: number;
  hypaChunkSize: number;
  cohereAPIKey: string;
  goCharacterOnImport: boolean;
  dallEQuality: string;
  font: string;
  customFont: string;
  lineHeight: number;
  stabilityModel: string;
  stabilityKey: string;
  stabllityStyle: string;
  legacyTranslation: boolean;
  comfyConfig: ComfyConfig;
  comfyUiUrl: string;
  useLegacyGUI: boolean;
  claudeCachingExperimental: boolean;
  hideApiKey: boolean;
  unformatQuotes: boolean;
  enableDevTools: boolean;
  falToken: string;
  falModel: string;
  falLora: string;
  falLoraName: string;
  falLoraScale: number;
  moduleIntergration: string;
  customCSS: string;
  betaMobileGUI: boolean;
  jsonSchemaEnabled: boolean;
  jsonSchema: string;
  strictJsonSchema: boolean;
  extractJson: string;
  statics: {
    messages: number;
    imports: number;
  };
  customQuotes: boolean;
  customQuotesData?: [string, string, string, string];
  groupTemplate?: string;
  groupOtherBotRole?: string;
  customGUI: string;
  guiHTML: string;
  OAIPrediction: string;
  customAPIFormat: LLMFormat;
  systemContentReplacement: string;
  systemRoleReplacement: "user" | "assistant";
  vertexPrivateKey: string;
  vertexClientEmail: string;
  vertexAccessToken: string;
  vertexAccessTokenExpires: number;
  vertexRegion: string;
  seperateParametersEnabled: boolean;
  seperateParameters: {
    memory: SeparateParameters;
    emotion: SeparateParameters;
    translate: SeparateParameters;
    otherAx: SeparateParameters;
    overrides: Record<string, SeparateParameters>;
  };
  translateBeforeHTMLFormatting: boolean;
  autoTranslateCachedOnly: boolean;
  lightningRealmImport: boolean;
  notification: boolean;
  customFlags: LLMFlags[];
  enableCustomFlags: boolean;
  googleClaudeTokenizing: boolean;
  presetChain: string;
  legacyMediaFindings?: boolean;
  geminiStream?: boolean;
  assetMaxDifference: number;
  auxModelUnderModelSettings: boolean;
  menuSideBar: boolean;
  pluginV2: RisuPlugin[];
  showSavingIcon: boolean;
  presetRegex: customscript[];
  banCharacterset: string[];
  showPromptComparison: boolean;
  hypaV3: boolean;
  hypaV3Settings: HypaV3Settings; // legacy
  hypaV3Presets: HypaV3Preset[];
  hypaV3PresetId: number;
  realmDirectOpen: boolean;
  OaiCompAPIKeys: { [key: string]: string };
  inlayErrorResponse: boolean;
  reasoningEffort: number;
  bulkEnabling: boolean;
  showTranslationLoading: boolean;
  showDeprecatedTriggerV1: boolean;
  showDeprecatedTriggerV2: boolean;
  returnCSSError: boolean;
  checkCorruption?: boolean;
  toggleConfirmRecommendedPreset?: boolean;
  useExperimentalGoogleTranslator: boolean;
  thinkingTokens: number;
  thinkingType: "off" | "budget" | "adaptive";
  deepseekThinkingType: "off" | "enabled";
  adaptiveThinkingEffort: "low" | "medium" | "high" | "xhigh" | "max";
  deepseekReasoningEffort: "high" | "max";
  antiServerOverloads: boolean;
  hypaCustomSettings: {
    url: string;
    key: string;
    model: string;
  };
  localActivationInGlobalLorebook: boolean;
  showFolderName: boolean;
  automaticCachePoint: boolean;
  coldstorage: boolean;
  claudeRetrivalCaching: boolean;
  outputImageModal: boolean;
  playMessageOnTranslateEnd: boolean;
  seperateModelsForAxModels: boolean;
  seperateModels: {
    memory: string;
    emotion: string;
    translate: string;
    otherAx: string;
  };
  doNotChangeSeperateModels: boolean;
  modelTools: string[];
  hotkeys: Hotkey[];
  fallbackModels: {
    memory: string[];
    emotion: string[];
    translate: string[];
    otherAx: string[];
    model: string[];
  };
  doNotChangeFallbackModels: boolean;
  fallbackWhenBlankResponse: boolean;
  customModels: {
    id: string;
    internalId: string;
    url: string;
    format: LLMFormat;
    tokenizer: LLMTokenizer;
    key: string;
    name: string;
    params: string;
    flags: LLMFlags[];
  }[];
  igpPrompt: string;
  useTokenizerCaching: boolean;
  showMenuHypaMemoryModal: boolean;
  authRefreshes: {
    url: string;
    tokenUrl: string;
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  }[];
  promptInfoInsideChat: boolean;
  promptTextInfoInsideChat: boolean;
  openAIFlexProcessing: boolean;
  claudeBatching: boolean;
  claude1HourCaching: boolean;
  rememberToolUsage: boolean;
  simplifiedToolUse: boolean;
  requestLocation: string;
  newImageHandlingBeta?: boolean;
  showFirstMessagePages: boolean;
  streamGeminiThoughts: boolean;
  verbosity: number;
  dynamicOutput?: DynamicOutput;
  hubServerType?: string;
  pluginCustomStorage: { [key: string]: any };
  ImagenModel: string;
  ImagenImageSize: string;
  ImagenAspectRatio: string;
  ImagenPersonGeneration: string;
  enableScrollToActiveChar: boolean;
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
  settingsCloseButtonSize: number;
  promptDiffPrefs: PromptDiffPrefs;
  enableBookmark?: boolean;
  hideAllImages?: boolean;
  autoScrollToNewMessage?: boolean;
  alwaysScrollToNewMessage?: boolean;
  newMessageButtonStyle?: string;
  chatLoadInitialPages?: number;
  chatLoadAdditionalPages?: number;
  streamingDisplayOptimizationMode?: StreamingDisplayOptimizationMode;
  pluginDevelopMode?: boolean;
  echoMessage?: string;
  echoDelay?: number;
  createFolderOnBranch?: boolean;
  hamburgerButtonBottom?: boolean;
  enableRemoteSaving?: boolean;
  blockquoteStyling?: boolean;
  dynamicModelRegistry?: boolean;
  enableRisuaiProTools?: boolean;
  epEnabled?: boolean;
  seperateParametersByModel?: boolean;
  disableSeperateParameterChangeOnPresetChange?: boolean;
  saveSignatures?: boolean;
  keepSessionAlive: "off" | "pip" | "sound";
  longPressToPopupEditor?: boolean;
  loadouts: Loadout[];
  loadoutApplyOptions: {
    modules: boolean;
    globalVariables: boolean;
    preset: boolean;
    persona: boolean;
  };
  disableAprilFools?: boolean;
  customSidebarItems: CustomSideBarItem[];
  lastLoadedLoadoutName: string;
  moveInsteadOfCopyOnCMPConvert?: boolean;
  skipSavingAssetsOnWebSync?: boolean;
}

export type FormatingOrderItem =
  | "main"
  | "jailbreak"
  | "chats"
  | "lorebook"
  | "globalNote"
  | "authorNote"
  | "lastChat"
  | "description"
  | "postEverything"
  | "personaPrompt";

export interface sdConfig {
  width: number;
  height: number;
  sampler_name: string;
  script_name: string;
  denoising_strength: number;
  enable_hr: boolean;
  hr_scale: number;
  hr_upscaler: string;
}

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

export interface NAIImgConfigV4Prompt {
  caption: NAIImgConfigV4Caption;
  use_coords: boolean;
  use_order: boolean;
}

export interface NAIImgConfigV4Caption {
  base_caption: string;
  char_captions: NAIImgConfigV4CharCaption[];
}

export interface NAIImgConfigV4CharCaption {
  char_caption: string;
  centers: {
    x: number;
    y: number;
  }[];
}

export interface NAIImgConfigV4NegativePrompt {
  caption: NAIImgConfigV4Caption;
  legacy_uc: boolean;
}

export interface NAIVibeData {
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

export interface NAIVibeEncoding {
  encoding: string;
  params: {
    information_extracted: number;
  };
}

export interface folder {
  name: string;
  data: string[];
  color: string;
  id: string;
  imgFile?: string;
  img?: string;
}

export interface hordeConfig {
  apiKey: string;
  model: string;
  softPrompt: string;
}

export interface OobaSettings {
  max_new_tokens: number;
  do_sample: boolean;
  temperature: number;
  top_p: number;
  typical_p: number;
  repetition_penalty: number;
  encoder_repetition_penalty: number;
  top_k: number;
  min_length: number;
  no_repeat_ngram_size: number;
  num_beams: number;
  penalty_alpha: number;
  length_penalty: number;
  early_stopping: boolean;
  seed: number;
  add_bos_token: boolean;
  truncation_length: number;
  ban_eos_token: boolean;
  skip_special_tokens: boolean;
  top_a: number;
  tfs: number;
  epsilon_cutoff: number;
  eta_cutoff: number;
  formating: {
    header: string;
    systemPrefix: string;
    userPrefix: string;
    assistantPrefix: string;
    seperator: string;
    useName: boolean;
  };
}

export interface AINsettings {
  top_p: number;
  rep_pen: number;
  top_a: number;
  rep_pen_slope: number;
  rep_pen_range: number;
  typical_p: number;
  badwords: string;
  stoptokens: string;
  top_k: number;
}

export type BlockedRealmCreator = {
  id: string;
  name: string;
};

export interface ComfyConfig {
  workflow: string;
  posNodeID: string;
  posInputName: string;
  negNodeID: string;
  negInputName: string;
  timeout: number;
}

export interface SeparateParameters {
  temperature?: number;
  top_k?: number;
  repetition_penalty?: number;
  min_p?: number;
  top_a?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  reasoning_effort?: number;
  thinking_tokens?: number;
  thinking_type?: "off" | "budget" | "adaptive";
  deepseek_thinking_type?: "off" | "enabled";
  adaptive_thinking_effort?: "low" | "medium" | "high" | "xhigh" | "max";
  deepseek_reasoning_effort?: "high" | "max";
  outputImageModal?: boolean;
  verbosity?: number;
}

export interface DynamicOutput {
  autoAdjustSchema: boolean;
  dynamicMessages: boolean;
  dynamicMemory: boolean;
  dynamicResponseTiming: boolean;
  dynamicOutputPrompt: boolean;
  showTypingEffect: boolean;
  dynamicRequest: boolean;
}

export interface PromptDiffPrefs {
  diffStyle: "line" | "intraline";
  formatStyle: "raw" | "card";
  viewStyle: "unified" | "split";
  isGrouped: boolean;
  showOnlyChanges: boolean;
  contextRadius: number;
}

export interface CustomSideBarItem {
  id: string;
  type: "model" | "databaseKey" | "loadout" | "persona" | "preset" | "setting";
  subType: string;
  label: string;
}

export type HypaModel =
  | "custom"
  | "ada"
  | "openai3small"
  | "openai3large"
  | "MiniLM"
  | "MiniLMGPU"
  | "nomic"
  | "nomicGPU"
  | "bgeSmallEn"
  | "bgeSmallEnGPU"
  | "bgem3"
  | "bgem3GPU"
  | "multiMiniLM"
  | "multiMiniLMGPU"
  | "bgeM3Ko"
  | "bgeM3KoGPU"
  | "voyageContext3";

export interface HypaV3Settings {
  summarizationModel: string;
  summarizationPrompt: string;
  reSummarizationPrompt: string;
  memoryTokensRatio: number;
  extraSummarizationRatio: number;
  maxChatsPerSummary: number;
  recentMemoryRatio: number;
  similarMemoryRatio: number;
  enableSimilarityCorrection: boolean;
  preserveOrphanedMemory: boolean;
  processRegexScript: boolean;
  doNotSummarizeUserMessage: boolean;
  summaryChunkSeparator: string;
  // Experimental
  useExperimentalImpl: boolean;
  summarizationRequestsPerMinute: number;
  summarizationMaxConcurrent: number;
  embeddingRequestsPerMinute: number;
  embeddingMaxConcurrent: number;
  alwaysToggleOn: boolean;
  queryChatCount: number;
}

export interface HypaV3Preset {
  name: string;
  settings: HypaV3Settings;
}
