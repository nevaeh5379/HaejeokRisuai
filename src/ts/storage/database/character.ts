import type { IllustrationOverrides } from "@risuai/protocol/src/illustration";
import type {
  charBookExtensions,
  CharacterOnboarding,
  customscript,
  loreBook,
  loreSettings,
  triggerscript,
} from "./schema";
import type { OnnxModelFiles } from "../../process/transformers";

export type CharacterFields = {
  [K in keyof Character as Character[K] extends (...args: never[]) => unknown
    ? never
    : K]: Character[K];
};

export type CharacterUpdate = Partial<
  Omit<CharacterFields, "chaId" | "type" | "detailsLoaded">
>;

export class Character {
      readonly #illustration?: IllustrationOverrides;
      #type?: "character";
      #name: string;
      #image?: string;
      #detailsLoaded?: boolean;
      #firstMessage: string;
      #desc: string;
      #notes: string;
    //   chats: Chat[];
    //   chatFolders: ChatFolder[];
    //   chatPage: number;
      #viewScreen: "emotion" | "none" | "imggen";
      #bias: [string, number][];
      #emotionImages: [string, string][];
      #globalLore: loreBook[];
      #chaId: string;
      #sdData: [string, string][];
      #newGenData?: {
        prompt: string;
        negative: string;
        instructions: string;
        emotionInstructions: string;
      };
      #customscript: customscript[];
      #triggerscript: triggerscript[];
      #utilityBot: boolean;
      #exampleMessage: string;
      #removedQuotes?: boolean;
      #creatorNotes: string;
      #systemPrompt: string;
      #postHistoryInstructions: string;
      #alternateGreetings: string[];
      #tags: string[];
      #creator: string;
      #characterVersion: string;
      #personality: string;
      #scenario: string;
      #firstMsgIndex: number;
      #loreSettings?: loreSettings;
      #loreExt?: charBookExtensions;
      #additionalData?: {
        tag?: string[];
        creator?: string;
        character_version?: string;
      };
      #ttsMode?: string;
      #ttsSpeech?: string;
      #voicevoxConfig?: {
        speaker?: string;
        SPEED_SCALE?: number;
        PITCH_SCALE?: number;
        INTONATION_SCALE?: number;
        VOLUME_SCALE?: number;
      };
      #naittsConfig?: {
        customvoice?: boolean;
        voice?: string;
        version?: string;
      };
      #gptSoVitsConfig?: {
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
      #fishSpeechConfig?: {
        model?: {
          _id: string;
          title: string;
          description: string;
        };
        chunk_length: number;
        normalize: boolean;
      };
      #supaMemory?: boolean;
      #additionalAssets?: [string, string, string][];
      #additionalAssetFolders?: Array<{
        id: string;
        name: string;
        parentId?: string;
      }>;
      /** Folder id keyed by the unique additional-asset display name. */
      #additionalAssetFolderAssignments?: Record<string, string>;
      #ttsReadOnlyQuoted?: boolean;
      #replaceGlobalNote: string;
      #backgroundHTML?: string;
      #reloadKeys?: number;
      #backgroundCSS?: string;
      #license?: string;
      #private?: boolean;
      #additionalText: string;
      #oaiVoice?: string;
      #oaiTTSConfig?: {
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
      #virtualscript?: string;
      #scriptstate?: { [key: string]: string | number | boolean };
      #depth_prompt?: { depth: number; prompt: string };
      #extentions?: { [key: string]: any };
      #largePortrait?: boolean;
      #lorePlus?: boolean;
      #inlayViewScreen?: boolean;
      #hfTTS?: {
        model: string;
        language: string;
      };
      #vits?: OnnxModelFiles;
      #realmId?: string;
      #imported?: boolean;
      #trashTime?: number;
      #nickname?: string;
      #source?: string[];
      #group_only_greetings?: string[];
      #creation_date?: number;
      #modification_date?: number;
      #ccAssets?: Array<{
        type: string;
        uri: string;
        name: string;
        ext: string;
      }>;
      #defaultVariables?: string;
      #onboarding?: CharacterOnboarding;
      #lowLevelAccess?: boolean;
      #hideChatIcon?: boolean;
      #lastInteraction?: number;
      #translatorNote?: string;
      #doNotChangeSeperateModels?: boolean;
      #escapeOutput?: boolean;
      #prebuiltAssetCommand?: boolean;
      #prebuiltAssetStyle?: string;
      #prebuiltAssetExclude?: string[];
      #modules?: string[];
      #moduleNamespace?: string;
      #coldstorage?: string;
      #coldStoragedChats?: string[];
      #customModuleToggle?: string;

      get illustration(): IllustrationOverrides | undefined {
        return this.#illustration;
      }

      //I don't know why type can be undefined?
      get type(): "character" | undefined {
        return this.#type;
      }
      get name(): string {
        return this.#name;
      }
      get image(): string | undefined {
        return this.#image;
      }
      get detailsLoaded(): boolean | undefined {
        return this.#detailsLoaded;
      }
      get firstMessage(): string {
        return this.#firstMessage;
      }
      get desc(): string {
        return this.#desc;
      }
      get notes(): string {
        return this.#notes;
      }
      get viewScreen(): "emotion" | "none" | "imggen" {
        return this.#viewScreen;
      }
      get bias(): [string, number][] {
        return this.#bias;
      }
      get emotionImages(): [string, string][] {
        return this.#emotionImages;
      }
      get globalLore(): loreBook[] {
        return this.#globalLore;
      }
      get chaId(): string {
        return this.#chaId;
      }
      get sdData(): [string, string][] {
        return this.#sdData;
      }
      get newGenData(): { prompt: string; negative: string; instructions: string; emotionInstructions: string; } | undefined {
        return this.#newGenData;
      }
      get customscript(): customscript[] {
        return this.#customscript;
      }
      get triggerscript(): triggerscript[] {
        return this.#triggerscript;
      }
      get utilityBot(): boolean {
        return this.#utilityBot;
      }
      get exampleMessage(): string {
        return this.#exampleMessage;
      }
      get removedQuotes(): boolean | undefined {
        return this.#removedQuotes;
      }
      get creatorNotes(): string {
        return this.#creatorNotes;
      }
      get systemPrompt(): string {
        return this.#systemPrompt;
      }
      get postHistoryInstructions(): string {
        return this.#postHistoryInstructions;
      }
      get alternateGreetings(): string[] {
        return this.#alternateGreetings;
      }
      get tags(): string[] {
        return this.#tags;
      }
      get creator(): string {
        return this.#creator;
      }
      get characterVersion(): string {
        return this.#characterVersion;
      }
      get personality(): string {
        return this.#personality;
      }
      get scenario(): string {
        return this.#scenario;
      }
      get firstMsgIndex(): number {
        return this.#firstMsgIndex;
      }
      get loreSettings(): loreSettings | undefined {
        return this.#loreSettings;
      }
      get loreExt(): charBookExtensions | undefined {
        return this.#loreExt;
      }
      get additionalData(): { tag?: string[]; creator?: string; character_version?: string; } | undefined {
        return this.#additionalData;
      }
      get ttsMode(): string | undefined {
        return this.#ttsMode;
      }
      get ttsSpeech(): string | undefined {
        return this.#ttsSpeech;
      }
      get voicevoxConfig(): { speaker?: string; SPEED_SCALE?: number; PITCH_SCALE?: number; INTONATION_SCALE?: number; VOLUME_SCALE?: number; } | undefined {
        return this.#voicevoxConfig;
      }
      get naittsConfig(): { customvoice?: boolean; voice?: string; version?: string; } | undefined {
        return this.#naittsConfig;
      }
      get gptSoVitsConfig(): { url?: string; use_auto_path?: boolean; ref_audio_path?: string; use_long_audio?: boolean; ref_audio_data?: { fileName: string; assetId: string; }; volume?: number; text_lang?: | "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"; text?: string; use_prompt?: boolean; prompt?: string | null; prompt_lang?: | "auto" | "auto_yue" | "en" | "zh" | "ja" | "yue" | "ko" | "all_zh" | "all_ja" | "all_yue" | "all_ko"; top_p?: number; temperature?: number; speed?: number; top_k?: number; text_split_method?: "cut0" | "cut1" | "cut2" | "cut3" | "cut4" | "cut5"; } | undefined {
        return this.#gptSoVitsConfig;
      }
      get fishSpeechConfig(): { model?: { _id: string; title: string; description: string; }; chunk_length: number; normalize: boolean; } | undefined {
        return this.#fishSpeechConfig;
      }
      get supaMemory(): boolean | undefined {
        return this.#supaMemory;
      }
      get additionalAssets(): [string, string, string][] | undefined {
        return this.#additionalAssets;
      }
      get additionalAssetFolders(): Array<{ id: string; name: string; parentId?: string; }> | undefined {
        return this.#additionalAssetFolders;
      }
      get additionalAssetFolderAssignments(): Record<string, string> | undefined {
        return this.#additionalAssetFolderAssignments;
      }
      get ttsReadOnlyQuoted(): boolean | undefined {
        return this.#ttsReadOnlyQuoted;
      }
      get replaceGlobalNote(): string {
        return this.#replaceGlobalNote;
      }
      get backgroundHTML(): string | undefined {
        return this.#backgroundHTML;
      }
      get reloadKeys(): number | undefined {
        return this.#reloadKeys;
      }
      get backgroundCSS(): string | undefined {
        return this.#backgroundCSS;
      }
      get license(): string | undefined {
        return this.#license;
      }
      get private(): boolean | undefined {
        return this.#private;
      }
      get additionalText(): string {
        return this.#additionalText;
      }
      get oaiVoice(): string | undefined {
        return this.#oaiVoice;
      }
      get oaiTTSConfig(): { /** User opted into advanced OpenAI-compatible settings. When false/absent, * tts.ts ignores the other fields and uses the legacy oaiVoice + db.openAIKey path. */ enabled?: boolean; /** Base URL, trailing slash trimmed at runtime. Falls back to 'https://api.openai.com/v1'. */ baseURL?: string; /** Per-character API key. Falls back to db.openAIKey; the Authorization header is omitted entirely when both are empty. */ apiKey?: string; /** Model ID. Falls back to 'tts-1'. */ model?: string; /** Freeform voice ID for custom endpoints. Falls back to character.oaiVoice, then to 'alloy'. */ voice?: string; /** Response format. Falls back to 'mp3'. */ format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm"; } | undefined {
        return this.#oaiTTSConfig;
      }
      get virtualscript(): string | undefined {
        return this.#virtualscript;
      }
      get scriptstate(): { [key: string]: string | number | boolean } | undefined {
        return this.#scriptstate;
      }
      get depth_prompt(): { depth: number; prompt: string } | undefined {
        return this.#depth_prompt;
      }
      get extentions(): { [key: string]: any } | undefined {
        return this.#extentions;
      }
      get largePortrait(): boolean | undefined {
        return this.#largePortrait;
      }
      get lorePlus(): boolean | undefined {
        return this.#lorePlus;
      }
      get inlayViewScreen(): boolean | undefined {
        return this.#inlayViewScreen;
      }
      get hfTTS(): { model: string; language: string; } | undefined {
        return this.#hfTTS;
      }
      get vits(): OnnxModelFiles | undefined {
        return this.#vits;
      }
      get realmId(): string | undefined {
        return this.#realmId;
      }
      get imported(): boolean | undefined {
        return this.#imported;
      }
      get trashTime(): number | undefined {
        return this.#trashTime;
      }
      get nickname(): string | undefined {
        return this.#nickname;
      }
      get source(): string[] | undefined {
        return this.#source;
      }
      get group_only_greetings(): string[] | undefined {
        return this.#group_only_greetings;
      }
      get creation_date(): number | undefined {
        return this.#creation_date;
      }
      get modification_date(): number | undefined {
        return this.#modification_date;
      }
      get ccAssets(): Array<{ type: string; uri: string; name: string; ext: string; }> | undefined {
        return this.#ccAssets;
      }
      get defaultVariables(): string | undefined {
        return this.#defaultVariables;
      }
      get onboarding(): CharacterOnboarding | undefined {
        return this.#onboarding;
      }
      get lowLevelAccess(): boolean | undefined {
        return this.#lowLevelAccess;
      }
      get hideChatIcon(): boolean | undefined {
        return this.#hideChatIcon;
      }
      get lastInteraction(): number | undefined {
        return this.#lastInteraction;
      }
      get translatorNote(): string | undefined {
        return this.#translatorNote;
      }
      get doNotChangeSeperateModels(): boolean | undefined {
        return this.#doNotChangeSeperateModels;
      }
      get escapeOutput(): boolean | undefined {
        return this.#escapeOutput;
      }
      get prebuiltAssetCommand(): boolean | undefined {
        return this.#prebuiltAssetCommand;
      }
      get prebuiltAssetStyle(): string | undefined {
        return this.#prebuiltAssetStyle;
      }
      get prebuiltAssetExclude(): string[] | undefined {
        return this.#prebuiltAssetExclude;
      }
      get modules(): string[] | undefined {
        return this.#modules;
      }
      get moduleNamespace(): string | undefined {
        return this.#moduleNamespace;
      }
      get coldstorage(): string | undefined {
        return this.#coldstorage;
      }
      get coldStoragedChats(): string[] | undefined {
        return this.#coldStoragedChats;
      }
      get customModuleToggle(): string | undefined {
        return this.#customModuleToggle;
      }
}
