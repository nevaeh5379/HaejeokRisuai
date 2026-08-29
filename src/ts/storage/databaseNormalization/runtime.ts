import { isNodeServer, isTauri } from "../../platform";
import {
  DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  normalizeChatLoadPages,
} from "../../chatLoadPages";
import type { Database, StreamingDisplayOptimizationMode } from "../schema";

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
  const legacy = (data as {
    largeChatPerformanceMode?: StreamingDisplayOptimizationMode;
  }).largeChatPerformanceMode;
  data.streamingDisplayOptimizationMode ??= legacy ?? "off";
  delete (data as { largeChatPerformanceMode?: unknown }).largeChatPerformanceMode;
}

function applyPlatformRuntimePolicy(data: Database): void {
  if (!isNodeServer && !isTauri) {
    data.promptInfoInsideChat = false;
  }
}

function resetTransientChatState(data: Database): void {
  for (const char of data.characters) {
    for (const chat of char.chats ?? []) {
      chat.isStreaming = false;
      chat.activeStreamingDisplayOptimizationMode = undefined;
    }
  }
}

export function normalizeRuntimeDatabaseSettings(data: Database): void {
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
  normalizeChatLoadSettings(data);
  migrateStreamingDisplayMode(data);
  data.echoMessage ??= "Echo Message";
  data.echoDelay ??= 0;
  applyPlatformRuntimePolicy(data);
  data.createFolderOnBranch ??= true;
  data.hamburgerButtonBottom ??= false;
  data.dynamicModelRegistry ??= true;
  data.saveSignatures ??= false;
  data.enableRisuaiProTools ??= data.plugins.length > 0;
  data.keepSessionAlive ??= "off";
  data.loadouts ??= [];
  data.longPressToPopupEditor ??= false;
  data.customSidebarItems ??= [];
  data.moveInsteadOfCopyOnCMPConvert ??= false;
  data.skipSavingAssetsOnWebSync ??= true;
  data.resizeTextarea ??= false;
  data.coldstorage ??= data?.plugins?.length === 0;
  resetTransientChatState(data);
}
