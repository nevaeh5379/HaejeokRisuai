import type { IllustrationOverrides } from "../../src/illustration.ts";
import type { OnnxModelFiles } from "../onnxModelFiles.ts";
import type {
  Chat,
  ChatFolder,
  loreBook,
  customscript,
  triggerscript,
  loreSettings,
  charBookExtensions,
  charExtensions,
  CharacterOnboarding,
} from "../database.ts";

/**
 * @deprecated
 */
export interface character {
  illustration?: IllustrationOverrides;
  type?: "character";
  name: string;
  image?: string;
  detailsLoaded?: boolean;
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
  loreExt?: charBookExtensions;
  extentions?: charExtensions;
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
  additionalAssetFolders?: Array<{
    id: string;
    name: string;
    parentId?: string;
  }>;
  /** Folder id keyed by the unique additional-asset display name. */
  additionalAssetFolderAssignments?: Record<string, string>;
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
