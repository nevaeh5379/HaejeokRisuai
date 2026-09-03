import { isNodeServer, isTauri } from "../../../platform";
import {
  DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  normalizeChatLoadPages,
} from "../../../chatLoadPages";
import { number, object, string } from "valibot";
import type { Database, StreamingDisplayOptimizationMode } from "../schema";
import {
  defaultArray,
  defaultBoolean,
  defaultNumber,
  defaultPicklist,
  defaultString,
  defaultStringArray,
  mergeDefaults,
  parseDefaults,
} from "./valibotDefaults";

const runtimeScalarDefaults = {
  openAIFlexProcessing: defaultBoolean(false),
  enableModuleSubModel: defaultBoolean(false),
  rememberToolUsage: defaultBoolean(true),
  simplifiedToolUse: defaultBoolean(false),
  streamGeminiThoughts: defaultBoolean(false),
  settingsCloseButtonSize: defaultNumber(24),
  hideAllImages: defaultBoolean(false),
  lowSpecMode: defaultBoolean(false),
  blurHiddenCharacters: defaultBoolean(true),
  ImagenModel: defaultString("imagen-4.0-generate-001"),
  ImagenImageSize: defaultString("1K"),
  ImagenAspectRatio: defaultString("1:1"),
  ImagenPersonGeneration: defaultString("allow_all"),
  autoScrollToNewMessage: defaultBoolean(true),
  alwaysScrollToNewMessage: defaultBoolean(false),
  newMessageButtonStyle: defaultString("bottom-center"),
  echoMessage: defaultString("Echo Message"),
  echoDelay: defaultNumber(0),
  createFolderOnBranch: defaultBoolean(true),
  hamburgerButtonBottom: defaultBoolean(false),
  dynamicModelRegistry: defaultBoolean(true),
  saveSignatures: defaultBoolean(false),
  keepSessionAlive: defaultPicklist(["off", "pip", "sound"], "off"),
  longPressToPopupEditor: defaultBoolean(false),
  moveInsteadOfCopyOnCMPConvert: defaultBoolean(false),
  skipSavingAssetsOnWebSync: defaultBoolean(true),
  resizeTextarea: defaultBoolean(false),
  characterFavorites: defaultStringArray(),
  characterHidden: defaultStringArray(),
};

const openAiCompatImageDefaults = {
  url: defaultString(),
  key: defaultString(),
  model: defaultString(),
  size: defaultString("1024x1024"),
  quality: defaultString("auto"),
};

const wavespeedImageDefaults = {
  key: defaultString(),
  model: defaultString(),
  loras: defaultArray(
    object({
      path: string(),
      scale: number(),
    }),
  ),
  reference_mode: defaultString(),
  reference_image: defaultString(),
  reference_base64image: defaultString(),
};

export type RuntimeValidatedDefaults = Required<
  Pick<
    Database,
    | keyof typeof runtimeScalarDefaults
    | "openaiCompatImage"
    | "wavespeedImage"
    | "chatLoadInitialPages"
    | "chatLoadAdditionalPages"
  >
>;

function normalizeChatLoadSettings(data: Database): void {
  data.chatLoadInitialPages = normalizeChatLoadPages(
    data.chatLoadInitialPages,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  );
  data.chatLoadAdditionalPages = normalizeChatLoadPages(
    data.chatLoadAdditionalPages,
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  );
}

function migrateStreamingDisplayMode(data: Database): void {
  const legacy = (
    data as {
      largeChatPerformanceMode?: StreamingDisplayOptimizationMode;
    }
  ).largeChatPerformanceMode;
  data.streamingDisplayOptimizationMode ??= legacy ?? "off";
  delete (data as { largeChatPerformanceMode?: unknown })
    .largeChatPerformanceMode;
}

function applyPlatformRuntimePolicy(data: Database): void {
  if (!isNodeServer && !isTauri) {
    data.promptInfoInsideChat = false;
  }
}

export function normalizeRuntimeDatabaseSettings(data: Database): void {
  Object.assign(data, parseDefaults(runtimeScalarDefaults, data));
  data.customModels ??= [];
  data.authRefreshes ??= [];
  data.openaiCompatImage = mergeDefaults(
    openAiCompatImageDefaults,
    data.openaiCompatImage,
  );
  data.wavespeedImage = mergeDefaults(
    wavespeedImageDefaults,
    data.wavespeedImage,
  );
  normalizeChatLoadSettings(data);
  migrateStreamingDisplayMode(data);
  applyPlatformRuntimePolicy(data);
  data.enableRisuaiProTools ??= data.plugins.length > 0;
  data.loadouts ??= [];
  data.customSidebarItems ??= [];
  data.coldstorage ??= data?.plugins?.length === 0;
}
