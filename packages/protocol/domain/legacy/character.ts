import type { Chat } from "./chat.ts";
import type { loreBook } from "./lorebook.ts";
import type { customscript, triggerscript } from "./script.ts";
import type { OnnxModelFiles } from "../onnxModelFiles.ts";

/** Upstream compatibility declarations, kwaroran/Risuai commit
 * 39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. Fork fields belong to internal domain types. */
export interface character {
  type?: "character";
  name: string;
  image?: string;
  firstMessage: string;
  desc: string;
  notes: string;
  chats: Chat[];
  chatFolders: ChatFolder[];
  chatPage: number;
  viewScreen: "emotion" | "none" | "imggen";
  bias: [string, number][];
  emotionImages: [string, string][];
  globalLore: loreBook[];
  chaId: string;
  sdData: [string, string][];
  newGenData?: {
    prompt: string;
    negative: string;
    instructions: string;
    emotionInstructions: string;
  };
  customscript: customscript[];
  triggerscript: triggerscript[];
  utilityBot: boolean;
  exampleMessage: string;
  removedQuotes?: boolean;
  creatorNotes: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  alternateGreetings: string[];
  tags: string[];
  creator: string;
  characterVersion: string;
  personality: string;
  scenario: string;
  firstMsgIndex: number;
  loreSettings?: loreSettings;
  loreExt?: any;
  additionalData?: {
    tag?: string[];
    creator?: string;
    character_version?: string;
  };
  ttsMode?: string;
  ttsSpeech?: string;
  voicevoxConfig?: {
    speaker?: string;
    SPEED_SCALE?: number;
    PITCH_SCALE?: number;
    INTONATION_SCALE?: number;
    VOLUME_SCALE?: number;
  };
  naittsConfig?: {
    customvoice?: boolean;
    voice?: string;
    version?: string;
  };
  gptSoVitsConfig?: {
    url?: string;
    use_auto_path?: boolean;
    ref_audio_path?: string;
    use_long_audio?: boolean;
    ref_audio_data?: {
      fileName: string;
      assetId: string;
    };
    volume?: number;
    text_lang?:
      | "auto"
      | "auto_yue"
      | "en"
      | "zh"
      | "ja"
      | "yue"
      | "ko"
      | "all_zh"
      | "all_ja"
      | "all_yue"
      | "all_ko";
    text?: string;
    use_prompt?: boolean;
    prompt?: string | null;
    prompt_lang?:
      | "auto"
      | "auto_yue"
      | "en"
      | "zh"
      | "ja"
      | "yue"
      | "ko"
      | "all_zh"
      | "all_ja"
      | "all_yue"
      | "all_ko";
    top_p?: number;
    temperature?: number;
    speed?: number;
    top_k?: number;
    text_split_method?: "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5";
  };
  fishSpeechConfig?: {
    model?: {
      _id: string;
      title: string;
      description: string;
    };
    chunk_length: number;
    normalize: boolean;
  };
  supaMemory?: boolean;
  additionalAssets?: [string, string, string][];
  ttsReadOnlyQuoted?: boolean;
  replaceGlobalNote: string;
  backgroundHTML?: string;
  reloadKeys?: number;
  backgroundCSS?: string;
  license?: string;
  private?: boolean;
  additionalText: string;
  oaiVoice?: string;
  oaiTTSConfig?: {
    /** User opted into advanced OpenAI-compatible settings. When false/absent,
     *  tts.ts ignores the other fields and uses the legacy oaiVoice + db.openAIKey path. */
    enabled?: boolean;
    /** Base URL, trailing slash trimmed at runtime. Falls back to 'https://api.openai.com/v1'. */
    baseURL?: string;
    /** Per-character API key. Falls back to db.openAIKey; the Authorization header is omitted entirely when both are empty. */
    apiKey?: string;
    /** Model ID. Falls back to 'tts-1'. */
    model?: string;
    /** Freeform voice ID for custom endpoints. Falls back to character.oaiVoice, then to 'alloy'. */
    voice?: string;
    /** Response format. Falls back to 'mp3'. */
    format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  };
  virtualscript?: string;
  scriptstate?: { [key: string]: string | number | boolean };
  depth_prompt?: { depth: number; prompt: string };
  extentions?: { [key: string]: any };
  largePortrait?: boolean;
  lorePlus?: boolean;
  inlayViewScreen?: boolean;
  hfTTS?: {
    model: string;
    language: string;
  };
  vits?: OnnxModelFiles;
  realmId?: string;
  imported?: boolean;
  trashTime?: number;
  nickname?: string;
  source?: string[];
  group_only_greetings?: string[];
  creation_date?: number;
  modification_date?: number;
  ccAssets?: Array<{
    type: string;
    uri: string;
    name: string;
    ext: string;
  }>;
  defaultVariables?: string;
  onboarding?: CharacterOnboarding;
  lowLevelAccess?: boolean;
  hideChatIcon?: boolean;
  lastInteraction?: number;
  translatorNote?: string;
  doNotChangeSeperateModels?: boolean;
  escapeOutput?: boolean;
  prebuiltAssetCommand?: boolean;
  prebuiltAssetStyle?: string;
  prebuiltAssetExclude?: string[];
  modules?: string[];
  moduleNamespace?: string;
  coldstorage?: string;
  coldStoragedChats?: string[];
  customModuleToggle?: string;
}

export interface loreSettings {
  tokenBudget: number;
  scanDepth: number;
  recursiveScanning: boolean;
  fullWordMatching?: boolean;
}

export interface groupChat {
  type: "group";
  image?: string;
  firstMessage: string;
  chats: Chat[];
  chatFolders: ChatFolder[];
  chatPage: number;
  name: string;
  viewScreen: "single" | "multiple" | "none" | "emp";
  characters: string[];
  characterTalks: number[];
  characterActive: boolean[];
  globalLore: loreBook[];
  autoMode: boolean;
  useCharacterLore: boolean;
  emotionImages: [string, string][];
  customscript: customscript[];
  chaId: string;
  alternateGreetings?: string[];
  creatorNotes?: string;
  removedQuotes?: boolean;
  firstMsgIndex?: number;
  loreSettings?: loreSettings;
  supaMemory?: boolean;
  ttsMode?: string;
  suggestMessages?: string[];
  orderByOrder?: boolean;
  backgroundHTML?: string;
  reloadKeys?: number;
  backgroundCSS?: string;
  oneAtTime?: boolean;
  virtualscript?: string;
  lorePlus?: boolean;
  trashTime?: number;
  nickname?: string;
  defaultVariables?: string;
  lowLevelAccess?: boolean;
  hideChatIcon?: boolean;
  lastInteraction?: number;

  //lazy hack for typechecking
  voicevoxConfig?: any;
  ttsSpeech?: string;
  naittsConfig?: any;
  oaiVoice?: string;
  oaiTTSConfig?: any;
  hfTTS?: any;
  vits?: OnnxModelFiles;
  gptSoVitsConfig?: any;
  fishSpeechConfig?: any;
  ttsReadOnlyQuoted?: boolean;
  exampleMessage?: string;
  systemPrompt?: string;
  replaceGlobalNote?: string;
  additionalText?: string;
  personality?: string;
  scenario?: string;
  translatorNote?: string;
  additionalData?: any;
  depth_prompt?: { depth: number; prompt: string };
  additionalAssets?: [string, string, string][];
  utilityBot?: boolean;
  license?: string;
  realmId: string;
  prebuiltAssetCommand?: boolean;
  prebuiltAssetStyle?: string;
  prebuiltAssetExclude?: string[];
  modules?: string[];
  coldstorage?: string;
  coldStoragedChats?: string[];
}

export interface OnboardingOption {
  label: string;
  value: string;
}

export interface OnboardingQuestion {
  id: string;
  title: string;
  description?: string;
  type: "single" | "multiple" | "text";
  varName: string;
  required?: boolean;
  options: OnboardingOption[];
  placeholder?: string;
}

export interface CharacterOnboarding {
  enabled: boolean;
  mode: "form" | "html";
  title?: string;
  description?: string;
  questions: OnboardingQuestion[];
  html?: string;
  /** Also shows a floating button on the chat screen that opens the onboarding. */
  floatingButton?: boolean;
}

export interface ChatFolder {
  id: string;
  name?: string;
  color?: string;
  folded: boolean;
}
