import type { IllustrationOverrides } from "../src/illustration.ts";
import type {
  charBookExtensions,
  CharacterOnboarding,
  customscript,
  loreBook,
  loreSettings,
  triggerscript,
} from "./database.ts";
import type { OnnxModelFiles } from "./onnxModelFiles.ts";

export interface CharacterFields {
  illustration?: IllustrationOverrides;
  type: "character";
  name: string;
  image?: string;
  firstMessage: string;
  desc: string;
  notes: string;

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

export type CharacterUpdate = Partial<CharacterFields>;

// Exhaustive at compile time; the runtime list also rejects inherited object keys.
const FIELD_NAMES = {
  illustration: true,
  type: true,
  name: true,
  image: true,
  firstMessage: true,
  desc: true,
  notes: true,
  viewScreen: true,
  bias: true,
  emotionImages: true,
  globalLore: true,
  chaId: true,
  sdData: true,
  newGenData: true,
  customscript: true,
  triggerscript: true,
  utilityBot: true,
  exampleMessage: true,
  removedQuotes: true,
  creatorNotes: true,
  systemPrompt: true,
  postHistoryInstructions: true,
  alternateGreetings: true,
  tags: true,
  creator: true,
  characterVersion: true,
  personality: true,
  scenario: true,
  firstMsgIndex: true,
  loreSettings: true,
  loreExt: true,
  additionalData: true,
  ttsMode: true,
  ttsSpeech: true,
  voicevoxConfig: true,
  naittsConfig: true,
  gptSoVitsConfig: true,
  fishSpeechConfig: true,
  supaMemory: true,
  additionalAssets: true,
  additionalAssetFolders: true,
  additionalAssetFolderAssignments: true,
  ttsReadOnlyQuoted: true,
  replaceGlobalNote: true,
  backgroundHTML: true,
  reloadKeys: true,
  backgroundCSS: true,
  license: true,
  private: true,
  additionalText: true,
  oaiVoice: true,
  oaiTTSConfig: true,
  virtualscript: true,
  scriptstate: true,
  depth_prompt: true,
  extentions: true,
  largePortrait: true,
  lorePlus: true,
  inlayViewScreen: true,
  hfTTS: true,
  vits: true,
  realmId: true,
  imported: true,
  trashTime: true,
  nickname: true,
  source: true,
  group_only_greetings: true,
  creation_date: true,
  modification_date: true,
  ccAssets: true,
  defaultVariables: true,
  onboarding: true,
  lowLevelAccess: true,
  hideChatIcon: true,
  lastInteraction: true,
  translatorNote: true,
  doNotChangeSeperateModels: true,
  escapeOutput: true,
  prebuiltAssetCommand: true,
  prebuiltAssetStyle: true,
  prebuiltAssetExclude: true,
  modules: true,
  moduleNamespace: true,
  coldstorage: true,
  coldStoragedChats: true,
  customModuleToggle: true,
} satisfies Record<keyof CharacterFields, true>;

export const CHARACTER_KEYS = Object.freeze(
  Object.keys(FIELD_NAMES) as (keyof CharacterFields)[],
);
const KEY_SET = new Set<string>(CHARACTER_KEYS);

const CHARACTER_DEFAULTS: Partial<CharacterFields> = {
  type: "character",
  name: "",
  firstMessage: "",
  desc: "",
  notes: "",
  exampleMessage: "",
  creatorNotes: "",
  systemPrompt: "",
  postHistoryInstructions: "",
  creator: "",
  characterVersion: "",
  personality: "",
  scenario: "",
  replaceGlobalNote: "",
  additionalText: "",
  viewScreen: "none",
  firstMsgIndex: -1,
  utilityBot: false,
  bias: [],
  emotionImages: [],
  globalLore: [],
  sdData: [],
  customscript: [],
  alternateGreetings: [],
  tags: [],
  triggerscript: [
    {
      comment: "",
      type: "manual",
      conditions: [],
      effect: [{ type: "v2Header", code: "", indent: 0 }],
    },
    { comment: "New Event", type: "manual", conditions: [], effect: [] },
  ],
};

/** Return only the requested default, with fresh mutable values. */
export function characterDefault<K extends keyof CharacterFields>(
  key: K,
): CharacterFields[K] | undefined {
  return structuredClone(CHARACTER_DEFAULTS[key]) as
    CharacterFields[K] | undefined;
}

export function validateCharacterKeys(
  keys: readonly string[],
): (keyof CharacterFields)[] {
  if (keys.length === 0)
    throw new TypeError("At least one character field is required");
  for (const key of keys) {
    if (!KEY_SET.has(key))
      throw new TypeError(`Unknown character field: ${key}`);
  }
  return [...new Set(keys)] as (keyof CharacterFields)[];
}

export function validateCharacterUpdate(
  id: string,
  patch: CharacterUpdate,
): void {
  for (const key of Object.keys(patch)) {
    if (!KEY_SET.has(key))
      throw new TypeError(`Unknown character field: ${key}`);
    const field = key as keyof CharacterFields;
    const value = patch[field];
    if (
      value === undefined &&
      (field === "chaId" || Object.hasOwn(CHARACTER_DEFAULTS, field))
    ) {
      throw new TypeError(`Character field cannot be undefined: ${field}`);
    }
    if (
      (field === "type" && value !== "character") ||
      (field === "chaId" && value !== id)
    ) {
      throw new TypeError(`Character field is immutable: ${field}`);
    }
  }
}

type CharacterRead = <K extends keyof CharacterFields>(
  ...keys: [K, ...K[]]
) => Promise<Pick<CharacterFields, K>>;
type CharacterWrite = (patch: CharacterUpdate) => Promise<void>;

/** A stateless handle: values are owned exclusively by the storage layer. */
export class Character {
  readonly id: string;
  readonly #read: CharacterRead;
  readonly #write: CharacterWrite;

  constructor(id: string, read: CharacterRead, write: CharacterWrite) {
    this.id = id;
    this.#read = read;
    this.#write = write;
  }

  get<K extends keyof CharacterFields>(
    ...keys: [K, ...K[]]
  ): Promise<Pick<CharacterFields, K>> {
    const unique = validateCharacterKeys(keys) as [K, ...K[]];
    return this.#read(...unique);
  }

  update(patch: CharacterUpdate): Promise<void> {
    validateCharacterUpdate(this.id, patch);
    if (Object.keys(patch).length === 0) return Promise.resolve();
    return this.#write(patch);
  }

  setIllustration(value: CharacterFields["illustration"]): Promise<void> {
    return this.update({ illustration: value });
  }

  setType(value: CharacterFields["type"]): Promise<void> {
    return this.update({ type: value });
  }

  setName(value: CharacterFields["name"]): Promise<void> {
    return this.update({ name: value });
  }

  setImage(value: CharacterFields["image"]): Promise<void> {
    return this.update({ image: value });
  }

  setFirstMessage(value: CharacterFields["firstMessage"]): Promise<void> {
    return this.update({ firstMessage: value });
  }

  setDesc(value: CharacterFields["desc"]): Promise<void> {
    return this.update({ desc: value });
  }

  setNotes(value: CharacterFields["notes"]): Promise<void> {
    return this.update({ notes: value });
  }

  setViewScreen(value: CharacterFields["viewScreen"]): Promise<void> {
    return this.update({ viewScreen: value });
  }

  setBias(value: CharacterFields["bias"]): Promise<void> {
    return this.update({ bias: value });
  }

  setEmotionImages(value: CharacterFields["emotionImages"]): Promise<void> {
    return this.update({ emotionImages: value });
  }

  setGlobalLore(value: CharacterFields["globalLore"]): Promise<void> {
    return this.update({ globalLore: value });
  }

  setChaId(value: CharacterFields["chaId"]): Promise<void> {
    return this.update({ chaId: value });
  }

  setSdData(value: CharacterFields["sdData"]): Promise<void> {
    return this.update({ sdData: value });
  }

  setNewGenData(value: CharacterFields["newGenData"]): Promise<void> {
    return this.update({ newGenData: value });
  }

  setCustomscript(value: CharacterFields["customscript"]): Promise<void> {
    return this.update({ customscript: value });
  }

  setTriggerscript(value: CharacterFields["triggerscript"]): Promise<void> {
    return this.update({ triggerscript: value });
  }

  setUtilityBot(value: CharacterFields["utilityBot"]): Promise<void> {
    return this.update({ utilityBot: value });
  }

  setExampleMessage(value: CharacterFields["exampleMessage"]): Promise<void> {
    return this.update({ exampleMessage: value });
  }

  setRemovedQuotes(value: CharacterFields["removedQuotes"]): Promise<void> {
    return this.update({ removedQuotes: value });
  }

  setCreatorNotes(value: CharacterFields["creatorNotes"]): Promise<void> {
    return this.update({ creatorNotes: value });
  }

  setSystemPrompt(value: CharacterFields["systemPrompt"]): Promise<void> {
    return this.update({ systemPrompt: value });
  }

  setPostHistoryInstructions(
    value: CharacterFields["postHistoryInstructions"],
  ): Promise<void> {
    return this.update({ postHistoryInstructions: value });
  }

  setAlternateGreetings(
    value: CharacterFields["alternateGreetings"],
  ): Promise<void> {
    return this.update({ alternateGreetings: value });
  }

  setTags(value: CharacterFields["tags"]): Promise<void> {
    return this.update({ tags: value });
  }

  setCreator(value: CharacterFields["creator"]): Promise<void> {
    return this.update({ creator: value });
  }

  setCharacterVersion(
    value: CharacterFields["characterVersion"],
  ): Promise<void> {
    return this.update({ characterVersion: value });
  }

  setPersonality(value: CharacterFields["personality"]): Promise<void> {
    return this.update({ personality: value });
  }

  setScenario(value: CharacterFields["scenario"]): Promise<void> {
    return this.update({ scenario: value });
  }

  setFirstMsgIndex(value: CharacterFields["firstMsgIndex"]): Promise<void> {
    return this.update({ firstMsgIndex: value });
  }

  setLoreSettings(value: CharacterFields["loreSettings"]): Promise<void> {
    return this.update({ loreSettings: value });
  }

  setLoreExt(value: CharacterFields["loreExt"]): Promise<void> {
    return this.update({ loreExt: value });
  }

  setAdditionalData(value: CharacterFields["additionalData"]): Promise<void> {
    return this.update({ additionalData: value });
  }

  setTtsMode(value: CharacterFields["ttsMode"]): Promise<void> {
    return this.update({ ttsMode: value });
  }

  setTtsSpeech(value: CharacterFields["ttsSpeech"]): Promise<void> {
    return this.update({ ttsSpeech: value });
  }

  setVoicevoxConfig(value: CharacterFields["voicevoxConfig"]): Promise<void> {
    return this.update({ voicevoxConfig: value });
  }

  setNaittsConfig(value: CharacterFields["naittsConfig"]): Promise<void> {
    return this.update({ naittsConfig: value });
  }

  setGptSoVitsConfig(value: CharacterFields["gptSoVitsConfig"]): Promise<void> {
    return this.update({ gptSoVitsConfig: value });
  }

  setFishSpeechConfig(
    value: CharacterFields["fishSpeechConfig"],
  ): Promise<void> {
    return this.update({ fishSpeechConfig: value });
  }

  setSupaMemory(value: CharacterFields["supaMemory"]): Promise<void> {
    return this.update({ supaMemory: value });
  }

  setAdditionalAssets(
    value: CharacterFields["additionalAssets"],
  ): Promise<void> {
    return this.update({ additionalAssets: value });
  }

  setAdditionalAssetFolders(
    value: CharacterFields["additionalAssetFolders"],
  ): Promise<void> {
    return this.update({ additionalAssetFolders: value });
  }

  setAdditionalAssetFolderAssignments(
    value: CharacterFields["additionalAssetFolderAssignments"],
  ): Promise<void> {
    return this.update({ additionalAssetFolderAssignments: value });
  }

  setTtsReadOnlyQuoted(
    value: CharacterFields["ttsReadOnlyQuoted"],
  ): Promise<void> {
    return this.update({ ttsReadOnlyQuoted: value });
  }

  setReplaceGlobalNote(
    value: CharacterFields["replaceGlobalNote"],
  ): Promise<void> {
    return this.update({ replaceGlobalNote: value });
  }

  setBackgroundHTML(value: CharacterFields["backgroundHTML"]): Promise<void> {
    return this.update({ backgroundHTML: value });
  }

  setReloadKeys(value: CharacterFields["reloadKeys"]): Promise<void> {
    return this.update({ reloadKeys: value });
  }

  setBackgroundCSS(value: CharacterFields["backgroundCSS"]): Promise<void> {
    return this.update({ backgroundCSS: value });
  }

  setLicense(value: CharacterFields["license"]): Promise<void> {
    return this.update({ license: value });
  }

  setPrivate(value: CharacterFields["private"]): Promise<void> {
    return this.update({ private: value });
  }

  setAdditionalText(value: CharacterFields["additionalText"]): Promise<void> {
    return this.update({ additionalText: value });
  }

  setOaiVoice(value: CharacterFields["oaiVoice"]): Promise<void> {
    return this.update({ oaiVoice: value });
  }

  setOaiTTSConfig(value: CharacterFields["oaiTTSConfig"]): Promise<void> {
    return this.update({ oaiTTSConfig: value });
  }

  setVirtualscript(value: CharacterFields["virtualscript"]): Promise<void> {
    return this.update({ virtualscript: value });
  }

  setScriptstate(value: CharacterFields["scriptstate"]): Promise<void> {
    return this.update({ scriptstate: value });
  }

  setDepthPrompt(value: CharacterFields["depth_prompt"]): Promise<void> {
    return this.update({ depth_prompt: value });
  }

  setExtentions(value: CharacterFields["extentions"]): Promise<void> {
    return this.update({ extentions: value });
  }

  setLargePortrait(value: CharacterFields["largePortrait"]): Promise<void> {
    return this.update({ largePortrait: value });
  }

  setLorePlus(value: CharacterFields["lorePlus"]): Promise<void> {
    return this.update({ lorePlus: value });
  }

  setInlayViewScreen(value: CharacterFields["inlayViewScreen"]): Promise<void> {
    return this.update({ inlayViewScreen: value });
  }

  setHfTTS(value: CharacterFields["hfTTS"]): Promise<void> {
    return this.update({ hfTTS: value });
  }

  setVits(value: CharacterFields["vits"]): Promise<void> {
    return this.update({ vits: value });
  }

  setRealmId(value: CharacterFields["realmId"]): Promise<void> {
    return this.update({ realmId: value });
  }

  setImported(value: CharacterFields["imported"]): Promise<void> {
    return this.update({ imported: value });
  }

  setTrashTime(value: CharacterFields["trashTime"]): Promise<void> {
    return this.update({ trashTime: value });
  }

  setNickname(value: CharacterFields["nickname"]): Promise<void> {
    return this.update({ nickname: value });
  }

  setSource(value: CharacterFields["source"]): Promise<void> {
    return this.update({ source: value });
  }

  setGroupOnlyGreetings(
    value: CharacterFields["group_only_greetings"],
  ): Promise<void> {
    return this.update({ group_only_greetings: value });
  }

  setCreationDate(value: CharacterFields["creation_date"]): Promise<void> {
    return this.update({ creation_date: value });
  }

  setModificationDate(
    value: CharacterFields["modification_date"],
  ): Promise<void> {
    return this.update({ modification_date: value });
  }

  setCcAssets(value: CharacterFields["ccAssets"]): Promise<void> {
    return this.update({ ccAssets: value });
  }

  setDefaultVariables(
    value: CharacterFields["defaultVariables"],
  ): Promise<void> {
    return this.update({ defaultVariables: value });
  }

  setOnboarding(value: CharacterFields["onboarding"]): Promise<void> {
    return this.update({ onboarding: value });
  }

  setLowLevelAccess(value: CharacterFields["lowLevelAccess"]): Promise<void> {
    return this.update({ lowLevelAccess: value });
  }

  setHideChatIcon(value: CharacterFields["hideChatIcon"]): Promise<void> {
    return this.update({ hideChatIcon: value });
  }

  setLastInteraction(value: CharacterFields["lastInteraction"]): Promise<void> {
    return this.update({ lastInteraction: value });
  }

  setTranslatorNote(value: CharacterFields["translatorNote"]): Promise<void> {
    return this.update({ translatorNote: value });
  }

  setDoNotChangeSeperateModels(
    value: CharacterFields["doNotChangeSeperateModels"],
  ): Promise<void> {
    return this.update({ doNotChangeSeperateModels: value });
  }

  setEscapeOutput(value: CharacterFields["escapeOutput"]): Promise<void> {
    return this.update({ escapeOutput: value });
  }

  setPrebuiltAssetCommand(
    value: CharacterFields["prebuiltAssetCommand"],
  ): Promise<void> {
    return this.update({ prebuiltAssetCommand: value });
  }

  setPrebuiltAssetStyle(
    value: CharacterFields["prebuiltAssetStyle"],
  ): Promise<void> {
    return this.update({ prebuiltAssetStyle: value });
  }

  setPrebuiltAssetExclude(
    value: CharacterFields["prebuiltAssetExclude"],
  ): Promise<void> {
    return this.update({ prebuiltAssetExclude: value });
  }

  setModules(value: CharacterFields["modules"]): Promise<void> {
    return this.update({ modules: value });
  }

  setModuleNamespace(value: CharacterFields["moduleNamespace"]): Promise<void> {
    return this.update({ moduleNamespace: value });
  }

  setColdstorage(value: CharacterFields["coldstorage"]): Promise<void> {
    return this.update({ coldstorage: value });
  }

  setColdStoragedChats(
    value: CharacterFields["coldStoragedChats"],
  ): Promise<void> {
    return this.update({ coldStoragedChats: value });
  }

  setCustomModuleToggle(
    value: CharacterFields["customModuleToggle"],
  ): Promise<void> {
    return this.update({ customModuleToggle: value });
  }
}
