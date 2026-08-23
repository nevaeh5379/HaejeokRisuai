import { writable } from "svelte/store";
import { settingsStore } from "./stores/domain/settingsStore.svelte";
import { characterStore } from "./stores/domain/characterStore.svelte";

type AlertData = {
  type:
    | "error"
    | "normal"
    | "none"
    | "ask"
    | "wait"
    | "selectChar"
    | "input"
    | "toast"
    | "wait2"
    | "markdown"
    | "select"
    | "tos"
    | "risu-tos"
    | "cardexport"
    | "requestdata"
    | "addchar"
    | "hypaV2"
    | "selectModule"
    | "chatOptions"
    | "pukmakkurit"
    | "branches"
    | "progress"
    | "pluginconfirm"
    | "requestlogs";
  msg: string;
  submsg?: string;
  datalist?: [string, string][];
  stackTrace?: string;
  defaultValue?: string;
};

type PluginSafetyError = {
  message: string;
  userAlertKey:
    | "eval"
    | "globalAccess"
    | "thisOutsideClass"
    | "errorInVerification"
    | "storageAccess";
};
type Character = import("./storage/database.svelte").character;
type GroupChat = import("./storage/database.svelte").groupChat;
type Database = import("./storage/database.svelte").Database;
type SimpleCharacter = import("./parser/parser.svelte").simpleCharacterArgument;
type HubType = import("./hubCatalog").hubType;

function updateSize() {
  SizeStore.set({
    w: window.innerWidth,
    h: window.innerHeight,
  });
  DynamicGUI.set(window.innerWidth <= 1024);
}

export const SizeStore = writable({
  w: 0,
  h: 0,
});

export const loadedStore = writable(false);
export const startupPhase = writable<
  "core-loading" | "shell-ready" | "chat-ready"
>("core-loading");
export const saving = $state({ state: false });
export const AccountWarning = writable("");
export const DynamicGUI = writable(false);
export const sideBarClosing = writable(false);
export const sideBarStore = writable(window.innerWidth > 1024);
export const selectedCharID = writable(-1);
export const pendingCharID = writable(-1);
export const CurrentTriggerIdStore = writable<string | null>(null);
export const CharEmotion = writable(
  {} as { [key: string]: [string, string, number][] },
);
export const ViewBoxsize = writable({ width: 12 * 16, height: 12 * 16 }); // Default width and height in pixels
export const settingsOpen = writable(false);
export const botMakerMode = writable(false);
export const moduleBackgroundEmbedding = writable("");
export const openPresetList = writable(false);
export const openPersonaList = writable(false);
export const bookmarkListOpen = writable(false);
export const MobileGUI = writable(false);
export const MobileGUIStack = writable(0);
export const MobileSideBar = writable(0);
export const SettingsMenuIndex = writable(-1);
export const ReloadGUIPointer = writable(0);
export const ReloadChatPointer = writable({} as Record<number, number>);
export const ScrollToMessageStore = $state({ value: -1 });
export const OpenRealmStore = writable(false);
export const RealmInitialOpenChar = writable<null | HubType>(null);
export const ShowRealmFrameStore = writable("");
export const PlaygroundStore = writable(0);
export const HideIconStore = writable(false);
export const CustomCSSStore = writable("");
export const SafeModeStore = writable(false);
export const MobileSearch = writable("");
export const messageSearchOpen = writable(false);
export const CharConfigSubMenu = writable(0);
export const CustomGUISettingMenuStore = writable(false);
export const alertStore = writable({
  type: "none",
  msg: "n",
} as AlertData);
export const hypaV3ModalOpen = writable(false);
export const hypaV3ProgressStore = writable({
  open: false,
  miniMsg: "",
  msg: "",
  subMsg: "",
});
export const selIdState = $state({
  selId: -1,
});

CustomCSSStore.subscribe((css) => {
  console.log(css);
  const q = document.querySelector("#customcss");
  if (q) {
    q.innerHTML = css;
  } else {
    const s = document.createElement("style");
    s.id = "customcss";
    s.innerHTML = css;
    document.body.appendChild(s);
  }
});

export function createSimpleCharacter(
  char: Character | GroupChat,
): SimpleCharacter | null {
  if (!char || char.type === "group") {
    return null;
  }

  const simpleChar: SimpleCharacter = {
    type: "simple",
    customscript: char.customscript,
    chaId: char.chaId,
    additionalAssets: char.additionalAssets,
    virtualscript: char.virtualscript,
    emotionImages: char.emotionImages,
    triggerscript: char.triggerscript,
  };

  return simpleChar;
}

updateSize();
window.addEventListener("resize", updateSize);
export const LoadingStatusState = $state({
  text: "",
});

export const QuickSettings = $state({
  open: false,
  index: 0,
});

export const pluginAlertModalStore = $state({
  open: false,
  errors: [] as PluginSafetyError[],
});

export const disableHighlight = writable(true);

export type MenuDef = {
  name: string;
  icon: string;
  iconType: "html" | "img" | "none";
  callback: any;
  id: string;
};

export type ChatPanelDef = {
  id: string;
  pluginName: string;
  html: string;
  className?: string;
};

export const additionalSettingsMenu = $state([] as MenuDef[]);
export const additionalFloatingActionButtons = $state([] as MenuDef[]);
export const additionalHamburgerMenu = $state([] as MenuDef[]);
export const additionalChatMenu = $state([] as MenuDef[]);
export const chatPanelStore = $state([] as ChatPanelDef[]);
export const bodyIntercepterStore = $state(
  [] as {
    id: string;
    callback: (body: any, type: string) => Promise<any>;
  }[],
);
export const easyPanelStore = $state({
  open: false,
});
export const popupStore = $state({
  children: null as null | import("svelte").Snippet,
  mouseX: 0,
  mouseY: 0,
  openId: 0,
});
export const popUpEditorStore = $state({
  open: false,
  value: "",
  mode: "default" as "default",
  language: "markdown" as string,
});

export const loadoutModalStore = $state({
  open: false,
});

export const irisStore = $state({
  open: false,
});

export const customSideBarConfigDialogStore = $state({
  open: false,
});

export const assetManagerModalStore = $state({
  open: false,
  selectedAssetIndex: -1,
  filterType: "all" as "all" | "image" | "audio" | "video" | "font" | "other",
});

//Set might be more ideal, however since Svelte doesn't support reactive Sets, using array for now
export const hotReloading = $state<string[]>([]);

// SQL 데이터베이스 설정 상태 (Node 서버 환경에서 사용)
// - configured: DB vendor가 설정되어 활성화됨
export const sqlConfiguredStore = writable<boolean | null>(null);

export let scriptCacheRevision = 0;
let reloadSubscriptionReady = false;
ReloadGUIPointer.subscribe(() => {
  ReloadChatPointer.set({});
  if (reloadSubscriptionReady) {
    scriptCacheRevision += 1;
    void import("./process/scripts").then(({ resetScriptCache }) =>
      resetScriptCache(),
    );
  }
  reloadSubscriptionReady = true;
});

$effect.root(() => {
  selectedCharID.subscribe((v) => {
    selIdState.selId = v;
    characterStore.select(v);

    if (characterStore.characters?.[selIdState.selId]) {
      if (
        settingsStore.state.hypaV3 &&
        settingsStore.state.hypaV3Presets?.[settingsStore.state.hypaV3PresetId]
          ?.settings?.alwaysToggleOn
      ) {
        characterStore.characters[selIdState.selId].supaMemory = true;
      }
    }
  });
  $effect(() => {
    const enabledModuleCount = settingsStore.state.enabledModules?.length ?? 0;
    const chatModuleCount =
      characterStore.characters?.[selIdState.selId]?.chats?.[
        characterStore.characters?.[selIdState.selId]?.chatPage
      ]?.modules?.length ?? 0;
    characterStore.characters?.[selIdState.selId]?.hideChatIcon;
    characterStore.characters?.[selIdState.selId]?.backgroundHTML;
    settingsStore.state.moduleIntergration;
    if (enabledModuleCount > 0 || chatModuleCount > 0) {
      void import("./process/modules").then(({ moduleUpdate }) =>
        moduleUpdate(),
      );
    }
  });
});
