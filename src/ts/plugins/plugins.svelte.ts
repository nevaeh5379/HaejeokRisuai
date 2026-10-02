import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { get, writable } from "svelte/store";
import { language } from "../../lang";
import { alertConfirm, alertError, alertPluginConfirm } from "../alert";
import { selectSingleFile, sleep } from "../util";
import type { OpenAIChat } from "@risuai/chat-core/types.cjs";
import {
  fetchNative,
  globalFetch,
  readImage,
  saveAsset,
} from "../globalApi.svelte";
import { hotReloading, selectedCharID } from "../stores.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { isPresetStoreSettingKey } from "../storage/sql/sqlDeferredSettings";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import { personaStore } from "../stores/domain/personaStore.svelte";
import { pluginStore } from "../stores/domain/pluginStore.svelte";
import type { ScriptMode } from "../process/scripts";
import { checkCodeSafety } from "./pluginSafety";
import {
  SafeDocument,
  SafeIdbFactory,
  SafeLocalStorage,
} from "./pluginSafeClass";
import { PluginCrashGuard } from "./pluginCrashGuard";
import type { PluginMetadata } from "./pluginTypes";
import { isSafeModeEnabled } from "../safeMode";

export const customProviderStore = writable([] as string[]);

export async function createBlankPlugin() {
  await importPlugin(
    `
//@name New Plugin
//@display-name New Plugin Display Name
//@api 3.0
//@arg example_arg string

Risuai.log("Hello from New Plugin!");
`.trim(),
  );
}

const compareVersions = (v1: string, v2: string): 0 | 1 | -1 => {
  const v1parts = v1.split(".").map(Number);
  const v2parts = v2.split(".").map(Number);
  const len = Math.max(v1parts.length, v2parts.length);
  for (let i = 0; i < len; i++) {
    const part1 = v1parts[i] || 0;
    const part2 = v2parts[i] || 0;
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  return 0;
};

const updateCache = new Map<
  string,
  { version: string; updateURL: string } | undefined
>();

export const checkPluginUpdate = async (plugin: PluginMetadata) => {
  try {
    if (!plugin.updateURL) {
      return;
    }

    if (updateCache.has(plugin.name)) {
      const cached = updateCache.get(plugin.name);
      if (
        compareVersions(cached.version, plugin.versionOfPlugin || "0.0.0") === 1
      ) {
        return cached;
      }
    }

    const response = await fetch(plugin.updateURL, {
      method: "GET",
      headers: {
        Range: "bytes=0-512",
      },
    });

    if (response.status >= 200 && response.status < 300) {
      const text = await response.text();
      const versioRegex = /\/\/@version\s+([^\s]+)/;
      const match = text.match(versioRegex);
      if (match && match[1]) {
        const latestVersion = match[1].trim();
        if (
          compareVersions(latestVersion, plugin.versionOfPlugin || "0.0.0") ===
          1
        ) {
          updateCache.set(plugin.name, {
            version: latestVersion,
            updateURL: plugin.updateURL,
          });
          return {
            version: latestVersion,
            updateURL: plugin.updateURL,
          };
        }
      }
    }
  } catch (error) {
    console.warn("Failed to check plugin update:", error);
  }
};

export async function updatePlugin(plugin: PluginMetadata) {
  try {
    if (!plugin.updateURL) {
      return false;
    }
    const response = await fetch(plugin.updateURL);
    if (response.status >= 200 && response.status < 300) {
      const jsFile = await response.text();
      await importPlugin(jsFile, {
        isUpdate: true,
        originalPluginName: plugin.name,
      });
      return true;
    }
  } catch (error) {
    console.error("Failed to update plugin:", error);
  }
  return false;
}

export async function importPlugin(
  code: string | null = null,
  argu: {
    isUpdate?: boolean;
    originalPluginName?: string;
    isHotReload?: boolean;
    isTypescript?: boolean;
  } = {},
) {
  try {
    let jsFile = "";
    let isUpdate = argu.isUpdate || false;
    let originalPluginName = argu.originalPluginName || "";
    let isTypescript = argu.isTypescript || false;

    if (!code) {
      const f = await selectSingleFile(["js", "ts"]);
      if (!f) {
        return;
      }
      if (f.name.endsWith(".ts")) {
        isTypescript = true;
      }
      //support utf-8 with BOM or without BOM
      jsFile = Buffer.from(f.data)
        .toString("utf-8")
        .replace(/^\uFEFF/gm, "");
    } else {
      jsFile = code;
    }

    const splitedJs = jsFile.split("\n");
    let name = "";
    for (const line of splitedJs) {
      if (line.startsWith("//@name")) {
        name = line.slice(7).trim();
        break;
      }
    }

    const showError = (msg: string) => {
      if (argu.isHotReload) {
        console.error(`Hot-reload plugin "${name}" error: ${msg}`);
      } else {
        alertError(msg);
      }
    };

    let displayName: string = undefined;
    let arg: { [key: string]: "int" | "string" | string[] } = {};
    let realArg: { [key: string]: number | string } = {};
    let argMeta: { [key: string]: { [key: string]: string } } = {};
    let customLink: PluginMetadata["customLink"] = [];
    let updateURL: string = "";
    let versionOfPlugin: string = ""; //This is the version of the plugin itself, not the API version
    let apiVersion = "2.0";
    let ipcList: string[] = [];
    for (const line of splitedJs) {
      if (line.startsWith("//@name")) {
        const provied = line.slice(7);
        if (provied === "") {
          showError(
            "plugin name must be longer than 0, did you put it correctly?",
          );
          return;
        }
        name = provied.trim();
      }
      if (line.startsWith("//@api")) {
        const proviedVersions = line.slice(6).trim().split(" ");
        const supportedVersions = ["2.0", "2.1", "3.0"];
        for (const ver of proviedVersions) {
          if (supportedVersions.includes(ver)) {
            apiVersion = ver;
            break;
          } else {
            console.warn(`Plugin API version "${ver}" is not supported.`);
          }
        }
      }
      if (line.startsWith("//@display-name")) {
        const provied = line.slice("//@display-name".length + 1);
        if (provied === "") {
          showError(
            "plugin display name must be longer than 0, did you put it correctly?",
          );
          return;
        }
        displayName = provied.trim();
      }

      if (line.startsWith("//@link")) {
        const link = line.split(" ")[1];
        if (!link || link === "") {
          showError("plugin link is empty, did you put it correctly?");
          return;
        }
        if (!link.startsWith("https")) {
          showError("plugin link must start with https, did you check it?");
          return;
        }
        const hoverText = line.split(" ").slice(2).join(" ").trim();
        if (hoverText === "") {
          // OK, no hover text. It's fine.
          customLink.push({
            link: link,
            hoverText: undefined,
          });
        } else
          customLink.push({
            link: link,
            hoverText: hoverText || undefined,
          });
      }
      if (line.startsWith("//@risu-arg") || line.startsWith("//@arg")) {
        const provied = line.trim().split(" ");
        if (provied.length < 3) {
          showError(
            "plugin argument is incorrect, did you put space in argument name?",
          );
          return;
        }
        const provKey = provied[1];

        if (provied[2] !== "int" && provied[2] !== "string") {
          showError(
            `plugin argument type is "${provied[2]}", which is an unknown type.`,
          );
          return;
        }
        if (provied[2] === "int") {
          arg[provKey] = "int";
          realArg[provKey] = 0;
        } else if (provied[2] === "string") {
          arg[provKey] = "string";
          realArg[provKey] = "";
        }

        if (provied.length > 3) {
          const meta: { [key: string]: string } = {};
          //Compatibility layer for unofficial meta
          let metaStr = provied
            .slice(3)
            .join(" ")
            .replace(
              /{{(.+?)(::?(.+?))?}}/g,
              (a, g1: string, g2, g3: string) => {
                console.log(g1, g3);
                meta[g1] = g3 || "1";
                return "";
              },
            )
            .trim();

          if (metaStr) {
            meta["description"] = metaStr;
          }

          argMeta[provKey] = meta;
        }
      }

      if (line.startsWith("//@update-url")) {
        updateURL = line.split(" ")[1];

        try {
          const url = new URL(updateURL);
          if (url.protocol !== "https:") {
            showError(
              "plugin update URL must start with https, did you put it correctly?",
            );
            return;
          }
        } catch (error) {
          showError(
            "plugin update URL is not a valid URL, did you put it correctly?",
          );
          return;
        }
      }

      if (line.startsWith("//@version")) {
        versionOfPlugin = line.split(" ").slice(1).join(" ").trim();

        const versionLocation = jsFile.indexOf("//@version");
        const numberOfBytesBefore = new TextEncoder().encode(
          jsFile.slice(0, versionLocation) + line,
        ).length;
        if (numberOfBytesBefore > 500) {
          showError(
            "plugin version declaration must be within the first 512 Bytes of the file for proper parsing. move //@version line to the top of the file.",
          );
          return;
        }
      }

      if (line.startsWith("//@allowed-ipc")) {
        const provied = line.trim().split(" ");
        if (provied.length < 2) {
          showError(
            "plugin allowed IPC declaration is incorrect, did you put space after //@allowed-ipc?",
          );
          return;
        }

        const allowedIPCList = provied.slice(1);

        ipcList.push(...allowedIPCList);
      }
    }

    if (name.length === 0) {
      showError("plugin name not found, did you put it correctly?");
      return;
    }

    if (updateURL && versionOfPlugin.length === 0) {
      showError(
        "plugin version not found, did you put it correctly? It is required when update URL is provided.",
      );
      return;
    }

    if (versionOfPlugin && compareVersions(versionOfPlugin, "0.0.1") === -1) {
      showError("plugin version must be at least 0.0.1");
      return;
    }

    if (isTypescript) {
      try {
        const { pluginCodeTranspiler } = await import("./apiV3/transpiler");
        jsFile = await pluginCodeTranspiler(jsFile);
      } catch (error) {
        showError("Failed to transpile TypeScript code: " + error.message);
      }
    }

    let apiInternalVersion: 2 | "2.1" | "3.0" = "2.1";

    if (apiVersion === "2.1") {
      showError(
        "Your plugin specifies API version 2.1, which is outdated and no longer supported. Please update your plugin to use at least API version 3.0.",
      );
      return;
    } else if (apiVersion === "2.0") {
      //Only block installing
      showError(
        "Your code does not include //@api or specifies API version 2.0, which is outdated. Please update your plugin to use at least API version 3.0.",
      );
      return;
    } else if (apiVersion === "3.0") {
      apiInternalVersion = "3.0";
    }

    if (apiInternalVersion !== "3.0" && argu.isHotReload) {
      showError("Only API version 3.0 plugins can be hot-reloaded.");
      return;
    }

    const pluginMetadata: Omit<PluginMetadata, "id" | "position"> = {
      name,
      realArg,
      arguments: arg,
      displayName,
      version: apiInternalVersion,
      customLink,
      argMeta,
      versionOfPlugin,
      updateURL,
      allowedIPC: ipcList,
      enabled: true,
    };

    const oldPlugin = pluginStore.getByName(pluginMetadata.name);

    if (originalPluginName && originalPluginName !== pluginMetadata.name) {
      showError(
        `When updating plugin "${originalPluginName}", the plugin name cannot be changed to "${pluginMetadata.name}". Please keep the original name to update.`,
      );
      return;
    }

    if (!isUpdate && oldPlugin) {
      const c = await alertConfirm(language.duplicatePluginFoundUpdateIt);
      if (!c) {
        return;
      }
    }

    if (oldPlugin || !isUpdate || argu.isHotReload) {
      await pluginStore.install(pluginMetadata, jsFile, oldPlugin?.id);
    }

    if (argu.isHotReload && !hotReloading.includes(pluginMetadata.name)) {
      hotReloading.push(pluginMetadata.name);
    }

    console.log(`Imported plugin: ${pluginMetadata.name} (API v${apiVersion})`);
    await loadPlugins();
  } catch (error) {
    console.error(error);
    alertError(language.errors.noData);
  }
}

let pluginTranslator = false;
let runtimePlugins: PluginMetadata[] = [];

export function getRuntimePlugin(name: string): PluginMetadata | undefined {
  return runtimePlugins.find((plugin) => plugin.name === name);
}

export async function togglePluginEnabled(index: number): Promise<void> {
  const plugin = pluginStore.plugins[index];
  if (!plugin) return;

  await pluginStore.setEnabled(plugin.id, !plugin.enabled);
  await loadPlugins();
}

export async function loadPlugins() {
  if (await isSafeModeEnabled()) return;
  console.log("Loading plugins...");
  // CrashGuard: plugins the native side blamed for a renderer death
  // mid-load are skipped until they are permanently disabled below.
  const crashGuard = PluginCrashGuard.getInstance();
  const blocked = (await crashGuard?.getBlocked()) ?? [];
  const blockedSet = new Set(blocked);
  const enabled = pluginStore.enabled;
  const enabledPlugins = safeStructuredClone(
    enabled.filter((plugin) => !blockedSet.has(plugin.name)),
  );

  // Keep the blocklist entries that matched an enabled plugin so they can
  // be persisted (enabled=false) once boot stabilizes.
  const blockedPresent = enabled.filter((plugin) =>
    blockedSet.has(plugin.name),
  );
  runtimePlugins = enabledPlugins;
  const pluginV2 = enabledPlugins.filter(
    (plugin) => plugin.version === 2 || plugin.version === "2.1",
  );
  const pluginV3 = enabledPlugins.filter((plugin) => plugin.version === "3.0");

  // HaejeokRisuai does not support V2 Plugins.
  // await loadV2Plugin(pluginV2);
  if (pluginV3.length > 0) {
    const { loadV3Plugins } = await import("./apiV3/v3.svelte");
    await loadV3Plugins(pluginV3);
  }

  if (blockedPresent.length > 0) {
    await applyBlockedPlugins(blockedPresent);
  }
}

/**
 * CrashGuard follow-up: once boot stabilized far enough to load the
 * remaining plugins, permanently disable the culprits in the DB (same
 * path as the settings toggle), tell the native side to drop its
 * blocklist entries, and surface what happened to the user.
 */
async function applyBlockedPlugins(blockedPresent: PluginMetadata[]) {
  const names = blockedPresent.map((p) => p.name);
  console.warn(
    `CrashGuard: permanently disabling plugin(s) blamed for a renderer crash: ${names.join(", ")}`,
  );
  const crashGuard = PluginCrashGuard.getInstance();
  for (const plugin of blockedPresent) {
    try {
      await pluginStore.setEnabled(plugin.id, false);
      await crashGuard?.clearBlocked(plugin.name);
    } catch (error) {
      console.error(
        `CrashGuard: failed to persist disabled state for ${plugin.name}`,
        error,
      );
    }
  }
  const { alertToast } = await import("../alert");
  alertToast(language.pluginsAutoDisabled.replace("{0}", names.join(", ")));
}

export type PluginV2ProviderArgument = {
  prompt_chat: OpenAIChat[];
  frequency_penalty: number;
  min_p: number;
  presence_penalty: number;
  repetition_penalty: number;
  top_k: number;
  top_p: number;
  temperature: number;
  mode: string;
  max_tokens: number;
};

export type PluginV2ProviderOptions = {
  tokenizer?: string;
  tokenizerFunc?: (content: string) => number[] | Promise<number[]>;
};

export type EditFunction = (
  content: string,
) => string | null | undefined | Promise<string | null | undefined>;
type ReplacerFunction = (
  content: OpenAIChat[],
  type: string,
) => OpenAIChat[] | Promise<OpenAIChat[]>;
type ChatOutputListenerArg = {
  char: any;
  chat: any;
  characterIndex: number;
  chatIndex: number;
  messageIndex: number;
};
type ChatOutputListener = (arg: ChatOutputListenerArg) => void | Promise<void>;

export const pluginV2 = {
  providers: new Map<
    string,
    (
      arg: PluginV2ProviderArgument,
      abortSignal?: AbortSignal,
    ) => Promise<{ success: boolean; content: string | ReadableStream<string> }>
  >(),
  providerOptions: new Map<string, PluginV2ProviderOptions>(),
  editdisplay: new Set<EditFunction>(),
  editoutput: new Set<EditFunction>(),
  editprocess: new Set<EditFunction>(),
  editinput: new Set<EditFunction>(),
  replacerbeforeRequest: new Set<ReplacerFunction>(),
  replacerafterRequest: new Set<
    (content: string, type: string) => string | Promise<string>
  >(),
  chatOutput: new Set<ChatOutputListener>(),
  unload: new Set<() => void | Promise<void>>(),
  loaded: false,
};

export const allowedDbKeys = [
  "characters",
  "modules",
  "enabledModules",
  "moduleIntergration",
  "pluginV2",
  "personas",
  "plugins",
  "pluginCustomStorage",
  "temperature",
  "askRemoval",
  "maxContext",
  "maxResponse",
  "frequencyPenalty",
  "PresensePenalty",
  "theme",
  "textTheme",
  "lineHeight",
  "seperateModelsForAxModels",
  "seperateModels",
  "customCSS",
  "guiHTML",
  "colorSchemeName",
  "selectedPersona",
  "characterOrder",
];

const domainDbKeys = new Set([
  "characters",
  "modules",
  "enabledModules",
  "plugins",
  "personas",
  "selectedPersona",
]);

function getDomainDbValue(key: string): any {
  switch (key) {
    case "characters":
      return characterStore.characters;
    case "modules":
      return moduleStore.modules;
    case "enabledModules":
      return moduleStore.enabledModules;
    case "plugins":
      return pluginStore.compatibilityPlugins();
    case "personas":
      return personaStore.personas;
    case "selectedPersona":
      return personaStore.activeIndex;
  }
}

function setDomainDbValue(
  key: string,
  value: any,
): true | false | Promise<void> {
  switch (key) {
    case "characters":
      return characterStore.snapshot.saveAll(value);
    case "modules":
      if (!Array.isArray(value)) {
        throw new TypeError("Plugin database modules must be an array");
      }
      moduleStore.upsertModules(value);
      return true;
    case "enabledModules":
      moduleStore.enabledModules = value;
      return true;
    case "plugins":
      if (!Array.isArray(value)) {
        throw new TypeError("Plugin database plugins must be an array");
      }
      return pluginStore.replaceCompatibilityPlugins(value);
    case "personas":
      personaStore.replace(value);
      return true;
    case "selectedPersona":
      personaStore.select(value, "plugin compatibility API");
      return true;
    default:
      return false;
  }
}

function getAllowedDbValue(key: string): any {
  if (domainDbKeys.has(key)) return getDomainDbValue(key);
  if (isPresetStoreSettingKey(key)) return presetStore.state[key];
  return settingsStore.state[key];
}

function setAllowedDbValue(key: string, value: any): void | Promise<void> {
  const domainResult = setDomainDbValue(key, value);
  if (domainResult !== false) {
    return domainResult === true ? undefined : domainResult;
  }
  if (isPresetStoreSettingKey(key)) {
    presetStore.set(key, value);
  } else {
    settingsStore.set(key as any, value);
  }
}

function hasAllowedDbValue(key: string): boolean {
  return (
    domainDbKeys.has(key) ||
    (isPresetStoreSettingKey(key)
      ? key in presetStore.state
      : key in settingsStore.state)
  );
}

export const getV2PluginAPIs = () => {
  return {
    risuFetch: globalFetch,
    nativeFetch: fetchNative,
    getArg: (arg: string) => {
      const [name, realArg] = arg.split("::");
      for (const plugin of pluginStore.plugins) {
        if (plugin.name === name) {
          return plugin.realArg[realArg];
        }
      }
    },
    getChar: async () =>
      (await characterStore.snapshot.load(get(selectedCharID))) ?? undefined,
    setChar: (char: any) => {
      const charid = get(selectedCharID);
      return characterStore.snapshot.save(charid, char);
    },
    addProvider: (
      name: string,
      func: (
        arg: PluginV2ProviderArgument,
        abortSignal?: AbortSignal,
      ) => Promise<{ success: boolean; content: string }>,
      options?: PluginV2ProviderOptions,
    ) => {
      let provs = get(customProviderStore);
      provs.push(name);
      pluginV2.providers.set(name, func);
      pluginV2.providerOptions.set(name, options ?? {});
      customProviderStore.set(provs);
    },
    addRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
      if (pluginV2["edit" + name]) {
        pluginV2["edit" + name].add(func);
      } else {
        throw `script handler named ${name} not found`;
      }
    },
    removeRisuScriptHandler: (name: ScriptMode, func: EditFunction) => {
      if (pluginV2["edit" + name]) {
        pluginV2["edit" + name].delete(func);
      } else {
        throw `script handler named ${name} not found`;
      }
    },
    addRisuReplacer: (name: string, func: ReplacerFunction) => {
      if (pluginV2["replacer" + name]) {
        pluginV2["replacer" + name].add(func);
      } else {
        throw `replacer handler named ${name} not found`;
      }
    },
    removeRisuReplacer: (name: string, func: ReplacerFunction) => {
      if (pluginV2["replacer" + name]) {
        pluginV2["replacer" + name].delete(func);
      } else {
        throw `replacer handler named ${name} not found`;
      }
    },
    addRisuChatListener: (mode: string, func: ChatOutputListener) => {
      if (mode === "output") {
        pluginV2.chatOutput.add(func);
      } else {
        throw `chat listener mode ${mode} not found`;
      }
    },
    removeRisuChatListener: (mode: string, func: ChatOutputListener) => {
      if (mode === "output") {
        pluginV2.chatOutput.delete(func);
      } else {
        throw `chat listener mode ${mode} not found`;
      }
    },
    onUnload: (func: () => void | Promise<void>) => {
      pluginV2.unload.add(func);
    },
    setArg: (arg: string, value: string | number) => {
      const [name, realArg] = arg.split("::");
      for (const plugin of pluginStore.plugins) {
        if (plugin.name === name) {
          plugin.realArg[realArg] = value;
        }
      }
    },
    safeGlobalThis: {} as any,
    getSafeGlobalThis: () => {
      if (Object.keys(globalThis.__pluginApis__.safeGlobalThis).length > 0) {
        return globalThis.__pluginApis__.safeGlobalThis;
      }
      //safeGlobalThis
      const keys = Object.keys(globalThis);
      const safeGlobal: any = {};
      const allowedKeys = [
        "console",
        "TextEncoder",
        "TextDecoder",
        "URL",
        "URLSearchParams",
      ];
      for (const key of keys) {
        if (allowedKeys.includes(key)) {
          safeGlobal[key] = (globalThis as any)[key];
        }
      }

      //compatibility layer with old unsafe APIs

      //from PBV2
      const directoryPicker = (
        window as Window & {
          showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      safeGlobal.showDirectoryPicker = directoryPicker?.bind(window);

      safeGlobal.DBState = {
        db: globalThis.__pluginApis__.getDatabase(),
      };
      safeGlobal.setInterval = (...args: any[]) => {
        //@ts-expect-error spreading any[] into setInterval params causes type mismatch with TimerHandler signature
        return globalThis.setInterval(...args);
      };
      safeGlobal.setTimeout = (...args: any[]) => {
        //@ts-expect-error spreading any[] into setTimeout params causes type mismatch with TimerHandler signature
        return globalThis.setTimeout(...args);
      };
      safeGlobal.clearInterval = (...args: any[]) => {
        //@ts-expect-error spreading any[] into clearInterval - first arg should be number | undefined
        return globalThis.clearInterval(...args);
      };
      safeGlobal.clearTimeout = (...args: any[]) => {
        //@ts-expect-error spreading any[] into clearTimeout - first arg should be number | undefined
        return globalThis.clearTimeout(...args);
      };
      safeGlobal.alert = globalThis.alert;
      safeGlobal.confirm = globalThis.confirm;
      safeGlobal.prompt = globalThis.prompt;
      safeGlobal.innerWidth = window.innerWidth;
      safeGlobal.innerHeight = window.innerHeight;
      safeGlobal.getComputedStyle = window.getComputedStyle;
      safeGlobal.navigator = window.navigator;
      safeGlobal.localStorage = globalThis.__pluginApis__.safeLocalStorage;
      safeGlobal.indexedDB = globalThis.__pluginApis__.safeIdbFactory;
      safeGlobal.__pluginApis__ = globalThis.__pluginApis__;
      safeGlobal.Object = Object;
      safeGlobal.Array = Array;
      safeGlobal.String = String;
      safeGlobal.Number = Number;
      safeGlobal.Boolean = Boolean;
      safeGlobal.Math = Math;
      safeGlobal.Date = Date;
      safeGlobal.RegExp = RegExp;
      safeGlobal.Error = Error;
      safeGlobal.Function = globalThis.__pluginApis__.SafeFunction;
      safeGlobal.document = globalThis.__pluginApis__.safeDocument;
      safeGlobal.addEventListener = (...args: any[]) => {
        //@ts-expect-error spreading any[] into addEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions)
        window.addEventListener(...args);
      };
      safeGlobal.removeEventListener = (...args: any[]) => {
        //@ts-expect-error spreading any[] into removeEventListener - expects (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions)
        window.removeEventListener(...args);
      };
      return safeGlobal;
    },
    safeLocalStorage: new SafeLocalStorage(),
    safeIdbFactory: SafeIdbFactory,
    safeDocument: SafeDocument,
    alertStore: {
      set: (msg: string) => {},
    },
    apiVersion: "2.1",
    apiVersionCompatibleWith: ["2.0", "2.1"],
    getDatabase: () => {
      return new Proxy({} as any, {
        get(target, prop) {
          if (typeof prop === "string") {
            if (allowedDbKeys.includes(prop)) {
              return getAllowedDbValue(prop);
            }
            const custom = settingsStore.state.pluginCustomStorage;
            if (custom && prop in custom) {
              return $state.snapshot(custom[prop]);
            }
          }
          return undefined;
        },
        set(target, prop, value) {
          if (typeof prop === "string") {
            if (allowedDbKeys.includes(prop)) {
              const pending = setAllowedDbValue(prop, value);
              if (pending) {
                void pending.catch((error) => {
                  console.error(
                    `Failed to persist compatibility database key '${prop}':`,
                    error,
                  );
                });
              }
              return true;
            } else {
              settingsStore.setPluginCustomStorageKey(prop, value);
              return true;
            }
          }
          return false;
        },
        ownKeys(target) {
          const keys = allowedDbKeys.filter((key) => hasAllowedDbValue(key));
          keys.push(...settingsStore.getPluginCustomStorageKeys());
          return Array.from(new Set(keys));
        },
        has(target, prop) {
          if (typeof prop === "string") {
            if (allowedDbKeys.includes(prop) && hasAllowedDbValue(prop))
              return true;
            if (settingsStore.hasPluginCustomStorageKey(prop)) return true;
          }
          return false;
        },
        getOwnPropertyDescriptor(target, prop) {
          if (typeof prop === "string") {
            if (allowedDbKeys.includes(prop) && hasAllowedDbValue(prop)) {
              return {
                value: getAllowedDbValue(prop),
                writable: true,
                enumerable: true,
                configurable: true,
              };
            }
            const custom = settingsStore.state.pluginCustomStorage;
            if (custom && prop in custom) {
              return {
                value: custom[prop],
                writable: true,
                enumerable: true,
                configurable: true,
              };
            }
            if (settingsStore.hasPluginCustomStorageKey(prop)) {
              return {
                value: undefined,
                writable: true,
                enumerable: true,
                configurable: true,
              };
            }
          }
          return undefined;
        },
        deleteProperty(target, prop) {
          if (typeof prop === "string") {
            if (allowedDbKeys.includes(prop)) {
              console.log(
                "Attempt to delete db." +
                  String(prop) +
                  " denied in safe database proxy.",
              );
              return false;
            }
            settingsStore.removePluginCustomStorageKey(prop);
            return true;
          }
          return false;
        },
        getPrototypeOf(target) {
          return Reflect.getPrototypeOf(target);
        },
      });
    },
    pluginStorage: {
      getItem: async (key: string) => {
        try {
          const loaded = await settingsStore.loadPluginCustomStorageKey(key);
          return loaded === undefined ? null : $state.snapshot(loaded);
        } catch (err) {
          console.error(
            `Failed to load plugin custom storage key '${key}':`,
            err,
          );
          return null;
        }
      },
      setItem: (key: string, value: any) => {
        settingsStore.setPluginCustomStorageKey(key, value);
      },
      removeItem: (key: string) => {
        settingsStore.removePluginCustomStorageKey(key);
      },
      clear: () => {
        settingsStore.clearPluginCustomStorage();
      },
      key: (index: number) => {
        const keys = settingsStore.getPluginCustomStorageKeys();
        return keys[index] || null;
      },
      keys: () => {
        return settingsStore.getPluginCustomStorageKeys();
      },
      length: () => {
        return settingsStore.getPluginCustomStorageKeys().length;
      },
    },
    setDatabaseLite: async (newDb: any) => {
      if (!newDb || typeof newDb !== "object") return;
      for (const key of Object.keys(newDb)) {
        if (allowedDbKeys.includes(key)) {
          await setAllowedDbValue(key, newDb[key]);
        } else {
          settingsStore.setPluginCustomStorageKey(key, newDb[key]);
        }
      }
    },
    setDatabase: async (newDb: any) => {
      if (!newDb || typeof newDb !== "object") return;
      for (const key of Object.keys(newDb)) {
        if (key === "plugins") {
          console.warn(
            "[WARN] Plugin attempted to access plugin directly. this would be blocked in future versions. Instead, use the provided APIs to manage plugins. Attempting to handle plugin installation via plugin for new plugins in the provided database object.",
          );
          newDb[key] = await handlePluginInstallViaPlugin(newDb.plugins);
        }

        if (allowedDbKeys.includes(key)) {
          await setAllowedDbValue(key, newDb[key]);
        } else {
          settingsStore.setPluginCustomStorageKey(key, newDb[key]);
        }
      }
    },
    SafeFunction: new Proxy(Function, {
      construct(target, args) {
        return function () {
          return globalThis.__pluginApis__.getSafeGlobalThis();
        };
      },

      //call too
      apply(target, thisArg, args) {
        return function () {
          return globalThis.__pluginApis__.getSafeGlobalThis();
        };
      },
    }),
    loadPlugins: loadPlugins,
    readImage: (path: string) => {
      if (path.startsWith("assets/")) {
        //trim assets/ prefix temporarily
        path = path.slice(7);
      }
      if (path.includes("/") || path.includes("\\")) {
        throw new Error(
          "readImage path cannot contain '/' or '\\' for security reasons, except assets/ prefix.",
        );
      }
      //re-add assets/ prefix
      return readImage("assets/" + path);
    },
    saveAsset: (data: Uint8Array) => {
      return saveAsset(data);
    },
  };
};

/**
 * @deprecated HaejeokRisuai not supported V2 Plugin. do not use it.
 */
export async function loadV2Plugin(plugins: PluginMetadata[]) {}

export async function translatorPlugin(text: string, from: string, to: string) {
  return false;
}

export async function pluginProcess(
  arg:
    | {
        prompt_chat: OpenAIChat;
        temperature: number;
        max_tokens: number;
        presence_penalty: number;
        frequency_penalty: number;
        bias: { [key: string]: string };
      }
    | {},
) {
  return {
    success: false,
    content: language.pluginProviderNotFound,
  };
}

export async function handlePluginInstallViaPlugin(
  plugins: Array<Omit<PluginMetadata, "id" | "position"> & { script: string }>,
) {
  const trimmedPlugins: Array<
    Omit<PluginMetadata, "id" | "position"> & { script: string }
  > = [];
  for (const plugin of plugins) {
    const storedPlugin = pluginStore.getByName(plugin.name);
    const samePlugin =
      storedPlugin &&
      (await pluginStore.loadScript(storedPlugin.id)).script === plugin.script;
    if (!samePlugin) {
      if (plugin.version !== "3.0") {
        console.warn(
          `Plugin "${plugin.name}" has version "${plugin.version}", which is not supported for installation via plugin. Only API version 3.0 plugins can be installed via plugin. Skipping installation of this plugin.`,
        );
        continue;
      }
      const confirmation = await alertConfirm(
        language.confirmInstallPluginViaPlugin.replace("{plugin}", plugin.name),
      );
      if (confirmation) {
        trimmedPlugins.push(plugin);
      }
    } else {
      console.warn(
        `Plugin "${plugin.name}" already exists, skipping installation via plugin.`,
      );
    }
  }

  return trimmedPlugins;
}
