import { createPluginServices } from "./host/services";
import {
  getPluginDatabase,
  loadPluginScript,
  getPluginArgument,
  setPluginArgument,
  loadPluginCharacter,
  savePluginCharacter,
  loadPluginChat,
  savePluginChat,
  getCurrentCharacterIndex,
  getCurrentChatIndex,
} from "./host/data.svelte";
import { appearanceApi } from "./host/appearance.svelte";
import { pluginChat } from "./host/chat.svelte";
import { createPluginUi } from "./host/ui.svelte";
import { createProviderApi } from "./host/providers";
import {
  SafeDocument,
  SafeMutationObserver,
  clearPluginEventListeners,
  type SafeMutationCallback,
} from "./safeDom";
import type { ChatOutputListener, ReplacerRegistration } from "./hooks";
import {
  getRuntimePlugin,
  handlePluginInstallViaPlugin,
} from "../plugins.svelte";
import type { PluginMetadata } from "@risuai/protocol/domain/pluginTypes.ts";
import { SandboxHost } from "./factory";
import {
  createPluginScriptHashGetter,
  getPluginPermissionKey,
  PluginPermissionSessionCache,
  type PluginPermission,
} from "./pluginPermissionCache";
import { SafeLocalPluginStorage } from "../pluginSafeClass";
import { sleep } from "src/ts/util";
import { alertConfirm, alertError, alertNormal } from "src/ts/alert";
import { language } from "src/lang";
import {
  checkCharOrder,
  forageStorage,
  getFetchLogs,
} from "src/ts/globalApi.svelte";
import { isNodeServer, isTauri } from "src/ts/platform";
import {
  registerMCPModule,
  unregisterMCPModule,
} from "src/ts/process/mcp/pluginmcp";
import { getInlayAsset } from "src/ts/process/files/inlays";
import { getLLMCache, searchLLMCache } from "src/ts/translator/translator";
import { hasher } from "src/ts/hash";
import localforage from "localforage";
import type { ModelModeExtended } from "src/ts/process/request/shared";
import { requestChatDataMain } from "src/ts/process/request/request";
import {
  registerTTSPreprocessor,
  unregisterTTSPreprocessor,
  registerTTSPostprocessor,
  unregisterTTSPostprocessor,
  type BeforeTTSContext,
  type BeforeTTSResult,
  type AfterTTSContext,
  type AfterTTSResult,
  type TTSHookFn,
} from "src/ts/process/ttsHooks";

export { customV3ProviderMetaStore } from "./providerStore";

/*
    V3 API for RisuAI Plugins

    Before adding new APIs here, please check the limitations

    - APIs must be a functions
        - If you want nested objects, first add as a plain function, `_getPluginStorage` for example
            And add it too _getAliases function ({'pluginStorage':{'getItem': '_getPluginStorage', ... }})
            This will make pluginStorage.getItem() work in plugins
        - If you need constants, use _getPropertiesForInitialization to set them up
            For example apiVersion and apiVersionCompatibleWith are set this way,
            Accessable in plugins as risuai.apiVersion
    - APIs must return, or accept as parameters, only the following types:
        - Serializable data (string, number, boolean, null, array, object)
        - Class instances marked with __classType = 'REMOTE_REQUIRED'
        - Callback functions (only as parameters)
        - Note that Class or Callbacks inside arrays or objects are not supported
*/

type PluginChannelCallback = (
  message: unknown,
  context: { sender: string; channel: string },
) => void | Promise<void>;
const pluginChannel = new Map<string, PluginChannelCallback>();
const pluginUnloadCallbacks: Map<string, (() => void | Promise<void>)[]> =
  new Map();

const addPluginUnloadCallback = (
  pluginName: string,
  callback: () => void | Promise<void>,
) => {
  if (!pluginUnloadCallbacks.has(pluginName)) {
    pluginUnloadCallbacks.set(pluginName, []);
  }

  pluginUnloadCallbacks.get(pluginName)?.push(callback);
};

const unloadV3Plugin = async (pluginName: string) => {
  const callbacks = pluginUnloadCallbacks.get(pluginName);
  const instance = v3PluginInstances.find((p) => p.name === pluginName);
  if (instance) {
    const index = v3PluginInstances.findIndex((p) => p.name === pluginName);
    if (index !== -1) v3PluginInstances.splice(index, 1);
  }
  if (callbacks) {
    pluginUnloadCallbacks.delete(pluginName);
    const promises: Promise<void>[] = [];
    for (const callback of callbacks) {
      const result = callback();
      if (result instanceof Promise) promises.push(result);
    }

    await Promise.any([
      Promise.all(promises),
      sleep(1000), //timeout after 1 second
    ]);
  }
  try {
    instance?.host?.terminate();
  } catch (error) {
    console.error(`Error terminating plugin ${pluginName}:`, error);
  }
};

const permissionSessionCache = new PluginPermissionSessionCache();
const permissionForage = localforage.createInstance({
  name: "plugin_permissions",
  storeName: "plugin_permissions",
});

const getPluginPermission = async (
  pluginName: string,
  scriptHash: string,
  permissionDesc: PluginPermission,
  reconfirm: boolean | "periodically" = false,
) => {
  const cachedPermission = permissionSessionCache.get(
    scriptHash,
    permissionDesc,
  );
  if (cachedPermission !== undefined) return cachedPermission;

  const permissionKey = getPluginPermissionKey(scriptHash, permissionDesc);

  let requiresReconfirm = false;

  if (reconfirm === "periodically") {
    const lastGrantTime: number = await permissionForage.getItem(
      pluginName + "_" + permissionDesc + "_lastGrantTime",
    );
    const now = Date.now();
    if (!lastGrantTime || now - lastGrantTime > 3 * 24 * 60 * 60 * 1000)
    //3 days
    {
      requiresReconfirm = true;
    }
  } else if (reconfirm === true) requiresReconfirm = true;

  if (!requiresReconfirm && (await permissionForage.getItem(permissionKey))) {
    permissionSessionCache.set(scriptHash, permissionDesc, true);
    return true;
  }

  const alertTitle =
    permissionDesc === "fetchLogs"
      ? language.fetchLogConsent.replace("{}", pluginName)
      : permissionDesc === "db"
        ? language.getFullDatabaseConsent.replace("{}", pluginName)
        : permissionDesc === "mainDom"
          ? language.mainDomAccessConsent.replace("{}", pluginName)
          : permissionDesc === "replacer"
            ? language.replacerPermissionConsent.replace("{}", pluginName)
            : permissionDesc === "provider"
              ? language.providerPermissionConsent.replace("{}", pluginName)
              : permissionDesc === "sendChat"
                ? language.sendChatConsent.replace("{}", pluginName)
                : permissionDesc === "inlay"
                  ? language.inlayPermissionConsent.replace("{}", pluginName)
                  : `Error`;
  if (alertTitle === "Error") return false;

  const conf = await alertConfirm(alertTitle);
  if (conf && permissionKey) {
    permissionSessionCache.set(scriptHash, permissionDesc, true);
    await permissionForage.setItem(permissionKey, true);
    if (reconfirm === "periodically") {
      await permissionForage.setItem(
        pluginName + "_" + permissionDesc + "_lastGrantTime",
        Date.now(),
      );
    }

    return true;
  }
  permissionSessionCache.set(scriptHash, permissionDesc, false);
  return false;
};

const urlBlacklist = ["risuai.xyz", "risuai.net", "sionyw.com"];

const authorizationHeaders = [
  "x-api-key",
  "authorization",
  "proxy-authorization",
];

const makeRisuaiAPIV3 = (iframe: HTMLIFrameElement, plugin: PluginMetadata) => {
  const services = createPluginServices();
  let scriptHash: Promise<string> | undefined;
  const getPluginScriptHash = () =>
    (scriptHash ??= loadPluginScript(plugin.id).then(({ script }) =>
      createPluginScriptHashGetter(script, hasher)(),
    ));
  const getPermission = async (
    permissionDesc: PluginPermission,
    reconfirm: boolean | "periodically" = false,
  ) => {
    return getPluginPermission(
      plugin.name,
      await getPluginScriptHash(),
      permissionDesc,
      reconfirm,
    );
  };
  return {
    //Old APIs from v2.1
    risuFetch: (url, options) => {
      console.error(
        `[DEPRECATION WARNING] risuFetch is deprecated and will be removed in future versions. Please use nativeFetch instead.`,
      );
      for (const blocked of urlBlacklist) {
        if (url.toLowerCase().includes(blocked)) {
          throw new Error(
            `Requests to ${blocked} are blocked for security reasons.`,
          );
        }
      }

      //scan headers
      const headers = options?.headers || {};
      for (const headerName in headers) {
        if (authorizationHeaders.includes(headerName.toLowerCase())) {
          console.warn(
            `Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to only work with nativeFetch.`,
          );
        }
      }

      return services.risuFetch(url, options);
    },
    nativeFetch: (url, options) => {
      for (const blocked of urlBlacklist) {
        if (url.toLowerCase().includes(blocked)) {
          throw new Error(
            `Requests to ${blocked} are blocked for security reasons.`,
          );
        }
      }

      //scan headers
      const headers = options?.headers || {};
      for (const headerName in headers) {
        if (authorizationHeaders.includes(headerName.toLowerCase())) {
          console.warn(
            `Request contains potentially sensitive header '${headerName}'. handling of such headers may be changed to use server-side approch with write-only api access in the future for better security.`,
          );
        }
      }

      return services.nativeFetch(url, options);
    },
    getChar: services.getChar,
    setChar: services.setChar,
    ...createProviderApi(getPermission),
    addTTSPreprocessor: async (
      func: TTSHookFn<BeforeTTSContext, BeforeTTSResult>,
    ) => {
      registerTTSPreprocessor(func);
      addPluginUnloadCallback(plugin.name, () =>
        unregisterTTSPreprocessor(func),
      );
    },
    addTTSPostprocessor: async (
      func: TTSHookFn<AfterTTSContext, AfterTTSResult>,
    ) => {
      registerTTSPostprocessor(func);
      addPluginUnloadCallback(plugin.name, () =>
        unregisterTTSPostprocessor(func),
      );
    },
    addRisuScriptHandler: services.addRisuScriptHandler,
    removeRisuScriptHandler: services.removeRisuScriptHandler,
    addRisuReplacer: async (...registration: ReplacerRegistration) => {
      //permission check for replacer
      const conf = await getPermission("replacer", "periodically");
      if (!conf) return;

      services.addRisuReplacer(...registration);
    },
    removeRisuReplacer: services.removeRisuReplacer,
    addRisuChatListener: async (mode: "output", func: ChatOutputListener) => {
      //permission check, lets use same as replacer
      const conf = await getPermission("replacer", "periodically");
      if (!conf) return;

      services.addRisuChatListener(mode, func);
      addPluginUnloadCallback(plugin.name, () =>
        services.removeRisuChatListener(mode, func),
      );
    },
    removeRisuChatListener: services.removeRisuChatListener,
    setDatabaseLite: services.setDatabaseLite,
    setDatabase: services.setDatabase,
    loadPlugins: services.loadPlugins,
    readImage: services.readImage,
    readInlay: async (id: string) => {
      const conf = await getPermission("inlay", "periodically");
      if (!conf) return null;

      return await getInlayAsset(id);
    },
    saveAsset: services.saveAsset,
    //Same functionality, but new implementation
    getDatabase: async (includeOnly: string[] | "all" = "all") => {
      const conf = await getPermission("db", "periodically");
      if (!conf) return null;

      return getPluginDatabase(includeOnly);
    },

    installPlugin: handlePluginInstallViaPlugin,
    ...appearanceApi,

    //Deprecated APIs from v2.1
    //Use getArgument / setArgument instead if possible
    getArg: services.getArg,
    setArg: services.setArg,

    //New APIs for v3
    getArgument: async (key: string) => {
      return getPluginArgument(plugin.name, key);
    },
    setArgument: async (key: string, value: string) => {
      setPluginArgument(plugin.name, key, value);
    },
    parseRisuChat: pluginChat.parseRisuChat,
    getCurrentLorebookEntries: pluginChat.getCurrentLorebookEntries,
    sendChat: async (message: string) => {
      if (!(await getPermission("sendChat"))) return false;
      return pluginChat.sendChat(message);
    },
    getCharacterFromIndex: loadPluginCharacter,
    setCharacterToIndex: savePluginCharacter,
    getChatFromIndex: loadPluginChat,
    setChatToIndex: savePluginChat,
    getCurrentCharacterIndex,
    getCurrentChatIndex,
    //New names for character APIs, to match API naming conventions
    getCharacter: services.getChar,
    setCharacter: services.setChar,

    showContainer: (
      //more types may be added in future
      type: "fullscreen" = "fullscreen",
    ) => {
      iframe.style.display = "block";

      switch (type) {
        case "fullscreen": {
          //move iframe to body if not already there
          if (iframe.parentElement !== document.body) {
            document.body.appendChild(iframe);
          }

          //Make iframe cover whole screen
          iframe.style.position = "fixed";
          iframe.style.top = "0";
          iframe.style.left = "0";
          iframe.style.width = "100%";
          iframe.style.height = "100%";
          iframe.style.border = "none";
          iframe.style.zIndex = "1000";
          break;
        }
        default: {
          return;
        }
      }
    },
    hideContainer: () => {
      iframe.style.display = "none";
    },
    getRootDocument: async () => {
      const conf = await getPermission("mainDom");
      if (!conf) return null;

      return new SafeDocument(document);
    },
    ...createPluginUi(
      plugin.name,
      (callback) => addPluginUnloadCallback(plugin.name, callback),
      getPermission,
    ),
    registerMCP: registerMCPModule,
    unregisterMCP: unregisterMCPModule,
    log: (message: string) => {
      console.log(`[RisuAI Plugin: ${plugin.name}] ${message}`);
    },
    createMutationObserver(
      callback: SafeMutationCallback,
    ): SafeMutationObserver {
      const observer = new SafeMutationObserver(callback);
      addPluginUnloadCallback(plugin.name, () => {
        observer.disconnect();
      });
      return observer;
    },
    onUnload: (callback: () => void) => {
      addPluginUnloadCallback(plugin.name, callback);
    },
    getFetchLogs: async () => {
      const unsafeFetchLog = getFetchLogs();
      const conf = await getPermission("fetchLogs");
      if (!conf) return null;

      return unsafeFetchLog.map((log) => {
        const url = new URL(log.url);
        return {
          url: url.origin + url.pathname,
          body: log.body,
          status: log.status,
          response: log.response,
        };
      });
    },

    alert: (msg: string) => {
      return alertNormal(msg);
    },
    alertConfirm: (msg: string) => {
      return alertConfirm(msg);
    },
    alertError: (msg: string) => {
      return alertError(msg);
    },
    getRuntimeInfo: () => {
      return {
        apiVersion: "3.0",
        platform: isNodeServer ? "node" : isTauri ? "tauri" : "web",
        saveMethod: isTauri
          ? "tauri"
          : forageStorage.isAccount
            ? "account"
            : "local",
      };
    },
    getLocalPluginStorage: () => {
      return new SafeLocalPluginStorage();
    },
    checkCharOrder: checkCharOrder,
    requestPluginPermission: (permission: string) => {
      if (
        permission !== "fetchLogs" &&
        permission !== "db" &&
        permission !== "mainDom" &&
        permission !== "replacer" &&
        permission !== "provider" &&
        permission !== "sendChat" &&
        permission !== "inlay"
      ) {
        return Promise.resolve(false);
      }
      return getPermission(permission);
    },
    //Internal use APIs
    _getOldKeys: () => {
      return Object.keys(services);
    },
    _getPropertiesForInitialization: () => {
      const v = {
        apiVersion: "3.0",
        apiVersionCompatibleWith: ["3.0"],
      };
      return { ...v, list: Object.keys(v) };
    },
    _getPluginStorage: services.pluginStorage.getItem,
    _setPluginStorage: services.pluginStorage.setItem,
    _removePluginStorage: services.pluginStorage.removeItem,
    _clearPluginStorage: services.pluginStorage.clear,
    _keyPluginStorage: services.pluginStorage.key,
    _keysPluginStorage: services.pluginStorage.keys,
    _lengthPluginStorage: services.pluginStorage.length,
    _getSafeLocalStorage: services.safeLocalStorage.getItem,
    _setSafeLocalStorage: services.safeLocalStorage.setItem,
    _removeSafeLocalStorage: services.safeLocalStorage.removeItem,
    //bound calls: SafeLocalStorage.key/clear use `this`
    _clearSafeLocalStorage: () => services.safeLocalStorage.clear(),
    _keySafeLocalStorage: (index: number) =>
      services.safeLocalStorage.key(index),
    _keysSafeLocalStorage: services.safeLocalStorage.keys,
    _lengthSafeLocalStorage: () => {
      return services.safeLocalStorage.length;
    },
    searchTranslationCache: async (partialKey: string) => {
      return searchLLMCache(partialKey);
    },
    getTranslationCache: async (key: string) => {
      return getLLMCache(key);
    },
    _getAliases: () => {
      return {
        pluginStorage: {
          getItem: "_getPluginStorage",
          setItem: "_setPluginStorage",
          removeItem: "_removePluginStorage",
          clear: "_clearPluginStorage",
          key: "_keyPluginStorage",
          keys: "_keysPluginStorage",
          length: "_lengthPluginStorage",
        },
        safeLocalStorage: {
          getItem: "_getSafeLocalStorage",
          setItem: "_setSafeLocalStorage",
          removeItem: "_removeSafeLocalStorage",
          clear: "_clearSafeLocalStorage",
          key: "_keySafeLocalStorage",
          keys: "_keysSafeLocalStorage",
          length: "_lengthSafeLocalStorage",
        },
      };
    },
    runLLMModel: async (options: {
      mode: ModelModeExtended;
      messages: OpenAIChat[];
      staticModel?: string;
      allowPlugins?: boolean;
    }) => {
      return requestChatDataMain(
        {
          formated: options.messages,
          bias: {},
          staticModel: options.staticModel,

          // Calls into plugin-provided models are blocked by default to
          // guard against accidental IPC loops between provider plugins.
          // Plugin authors who need to reach the user's plugin-supplied
          // main or auxiliary model (e.g. a TTS preprocessor that
          // rewrites text with the configured otherAx model) can opt in
          // explicitly with `allowPlugins: true`, accepting responsibility
          // for avoiding provider-to-provider call loops.
          blockPlugins: !options.allowPlugins,
        },
        options.mode,
      );
    },
    addPluginChannelListener: (
      channelName: string,
      callback: PluginChannelCallback,
    ) => {
      pluginChannel.set(plugin.name + channelName, callback);
      addPluginUnloadCallback(plugin.name, () => {
        pluginChannel.delete(plugin.name + channelName);
      });
    },
    postPluginChannelMessage: (
      pluginName: string,
      channelName: string,
      message: unknown,
    ) => {
      const currentPluginName = plugin.name;
      const receiverPlugin = getRuntimePlugin(pluginName);

      if (!receiverPlugin) {
        console.warn(
          `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to non-existent plugin '${pluginName}' on channel '${channelName}'.`,
        );
        return;
      }

      if (!receiverPlugin.allowedIPC?.includes(currentPluginName)) {
        console.warn(
          `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but receiver plugin does not allow IPC communication from this plugin. declare //@allowed-ipc ${currentPluginName} in the reciver plugin script to allow IPC communication.`,
        );
        return;
      }

      if (!plugin.allowedIPC?.includes(receiverPlugin.name)) {
        console.warn(
          `[RisuAI Plugin: ${currentPluginName}] Attempted to send message to plugin '${pluginName}' but the sender plugin does not allow IPC communication to this plugin. declare //@allowed-ipc ${receiverPlugin.name} in the sender plugin script to allow IPC communication.`,
        );
        return;
      }

      const callback = pluginChannel.get(pluginName + channelName);
      if (callback) {
        callback(message, {
          sender: currentPluginName,
          channel: channelName,
        });
      }
    },
    saveSecretHeader: async (key: string, value: string | string[]) => {
      void key;
      void value;
      //TODO: Implement server-side secret storage with write-only access for plugins, to enhance security when handling sensitive information like API keys.
      //This will have rate-limit, to prevent saving it publicly and writing as secret every time before using it.
      console.warn(
        `[RisuAI Plugin: ${plugin.name}] saveServerSecret is not implemented yet. This API is intended for securely storing sensitive information like API keys with write-only access for plugins. Please avoid using this API until it is implemented.`,
      );
    },
  };
};

type V3PluginInstance = {
  name: string;
  host: SandboxHost;
};

const v3PluginInstances: V3PluginInstance[] = [];

/**
 * CrashGuard: how long the "loading plugin X" ledger entry survives after
 * the last sandbox finished loading. A renderer death inside this window
 * blames the last-loaded plugin; after it, idle crashes restart without
 * blaming anyone.
 */
const CRASH_GUARD_LEDGER_GRACE_MS = 10_000;

/**
 * CrashGuard: pending grace-clear timer for the most recent loadPlugins()
 * run. Kept so a newer run can cancel the previous one's timer before it
 * clears a ledger it no longer owns.
 */
let crashGuardLedgerClearTimer: ReturnType<typeof setTimeout> | null = null;

export async function loadV3Plugins(plugins: PluginMetadata[]) {
  await Promise.all(
    v3PluginInstances.map(async (instance) => {
      await unloadV3Plugin(instance.name);
    }),
  );

  clearPluginEventListeners();

  // Each sandbox creates an independent JavaScript realm. Starting every
  // iframe in the same task causes a large transient memory/CPU spike on
  // older mobile browsers, so let one document finish loading before the
  // next sandbox is created.
  const { PluginCrashGuard } = await import("../pluginCrashGuard");
  const crashGuard = PluginCrashGuard.getInstance();
  for (const plugin of plugins) {
    // CrashGuard: record which plugin is about to load so a renderer
    // death mid-load can blame it (Android only; no-op elsewhere).
    await crashGuard?.setLoading(plugin.name);
    await executePluginV3(plugin);
  }
  // Boot finished loading plugin sandboxes. Keep the last ledger entry
  // for a grace window so an init-path runaway is still attributable,
  // then clear it — later idle crashes restart without blaming anyone.
  // Cancel any timer from a previous loadPlugins() run (settings toggle,
  // plugin import, realtime sync): it would clear the ledger written by
  // this newer load and leave a later crash without a culprit to blame.
  if (crashGuardLedgerClearTimer !== null) {
    clearTimeout(crashGuardLedgerClearTimer);
  }

  crashGuardLedgerClearTimer = setTimeout(() => {
    crashGuardLedgerClearTimer = null;
    void crashGuard?.clearLoading();
  }, CRASH_GUARD_LEDGER_GRACE_MS);
}

export async function executePluginV3(plugin: PluginMetadata) {
  const alreadyRunning = v3PluginInstances.find((p) => p.name === plugin.name);
  if (alreadyRunning) {
    console.log(
      `[RisuAI Plugin: ${plugin.name}] Plugin is already running. Skipping load.`,
    );
    return;
  }

  const script = (await loadPluginScript(plugin.id)).script;
  const iframe = document.createElement("iframe");
  iframe.style.display = "none";
  const loaded = new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 3000);
    iframe.addEventListener(
      "load",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
  const host = new SandboxHost(makeRisuaiAPIV3(iframe, plugin));
  v3PluginInstances.push({
    name: plugin.name,
    host,
  });
  host.run(iframe, script);
  document.body.appendChild(iframe);
  await loaded;
  console.log(`[RisuAI Plugin: ${plugin.name}] Loaded API V3 plugin.`);
}

export function getV3PluginInstance(name: string) {
  return v3PluginInstances.find((p) => p.name === name);
}

globalThis.__debugV3Plugin = (
  code: string | ((...args: unknown[]) => unknown),
  pluginName: string = "",
) => {
  if (code instanceof Function) code = `(${code.toString()})()`;

  if (pluginName === "") return v3PluginInstances[0].host.executeInIframe(code);

  const instance = v3PluginInstances.find((p) => p.name === pluginName);
  if (!instance) throw new Error(`Plugin ${pluginName} not found.`);

  return instance.host.executeInIframe(code);
};
