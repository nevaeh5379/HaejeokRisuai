import {
  globalFetch,
  fetchNative,
  readImage,
  saveAsset,
} from "src/ts/globalApi.svelte";
import { SafeLocalStorage } from "../../pluginSafeClass";
import { loadPlugins } from "../../plugins.svelte";
import {
  addScriptHandler,
  removeScriptHandler,
  addPluginReplacer,
  removePluginReplacer,
  addChatListener,
  removeChatListener,
} from "../hooks";
import {
  getPluginCharacter,
  setPluginCharacter,
  getPluginArgument,
  setPluginArgument,
  setPluginDatabase,
  pluginStorage,
  getPluginDatabaseView,
} from "./data.svelte";

export function createPluginServices() {
  return {
    risuFetch: globalFetch,
    nativeFetch: fetchNative,
    getDatabase: getPluginDatabaseView,
    getChar: getPluginCharacter,
    setChar: setPluginCharacter,
    getArg: (argument: string) => {
      const [name, key] = argument.split("::");
      return getPluginArgument(name, key);
    },
    setArg: (argument: string, value: string | number) => {
      const [name, key] = argument.split("::");
      setPluginArgument(name, key, value);
    },
    addRisuScriptHandler: addScriptHandler,
    removeRisuScriptHandler: removeScriptHandler,
    addRisuReplacer: addPluginReplacer,
    removeRisuReplacer: removePluginReplacer,
    addRisuChatListener: addChatListener,
    removeRisuChatListener: removeChatListener,
    setDatabase: setPluginDatabase,
    setDatabaseLite: (value: Record<string, unknown>) =>
      setPluginDatabase(value, true),
    loadPlugins,
    readImage: (path: string) => {
      if (path.startsWith("assets/")) path = path.slice(7);
      if (path.includes("/") || path.includes("\\")) {
        throw new Error(
          "readImage path cannot contain path separators, except assets/ prefix.",
        );
      }
      return readImage("assets/" + path);
    },
    saveAsset: (data: Uint8Array) => saveAsset(data),
    pluginStorage,
    safeLocalStorage: new SafeLocalStorage(),
  };
}
