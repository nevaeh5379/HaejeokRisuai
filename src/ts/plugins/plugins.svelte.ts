export { pluginHooks as pluginV2 } from "./apiV3/hooks";
export type {
  EditFunction,
  PluginV2ProviderArgument,
  PluginV2ProviderOptions,
} from "./apiV3/hooks";
import { writable } from "svelte/store";
import { language } from "../../lang";
import { alertConfirm, alertError } from "../alert";
import { selectSingleFile } from "../util";
import type { OpenAIChat } from "@risuai/chat-core/types.ts";
import { hotReloading } from "../stores.svelte";
import { pluginStore } from "../stores/domain/pluginStore.svelte";
import { PluginCrashGuard } from "./pluginCrashGuard";
import type { PluginMetadata } from "@risuai/protocol/domain/pluginTypes.ts";
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
    if (!plugin.updateURL) return;

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
    if (!plugin.updateURL) return false;

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
    const isUpdate = argu.isUpdate || false;
    const originalPluginName = argu.originalPluginName || "";
    let isTypescript = argu.isTypescript || false;

    if (!code) {
      const f = await selectSingleFile(["js", "ts"]);
      if (!f) return;

      if (f.name.endsWith(".ts")) isTypescript = true;

      //support utf-8 with BOM or without BOM
      jsFile = Buffer.from(f.data)
        .toString("utf-8")
        .replace(/^\uFEFF/gm, "");
    } else jsFile = code;

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
      } else alertError(msg);
    };

    let displayName: string = undefined;
    const arg: { [key: string]: "int" | "string" | string[] } = {};
    const realArg: { [key: string]: number | string } = {};
    const argMeta: { [key: string]: { [key: string]: string } } = {};
    const customLink: PluginMetadata["customLink"] = [];
    let updateURL: string = "";
    let versionOfPlugin: string = ""; //This is the version of the plugin itself, not the API version
    let apiVersion = "2.0";
    const ipcList: string[] = [];
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
          } else console.warn(`Plugin API version "${ver}" is not supported.`);
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
        if (hoverText === "")
        // OK, no hover text. It's fine.
        {
          customLink.push({
            link: link,
            hoverText: undefined,
          });
        } else {
          customLink.push({
            link: link,
            hoverText: hoverText || undefined,
          });
        }
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
          const metaStr = provied
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

          if (metaStr) meta["description"] = metaStr;

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
        } catch {
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
    } else if (apiVersion === "3.0") apiInternalVersion = "3.0";

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
      if (!c) return;
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
  const pluginV3 = enabledPlugins.filter((plugin) => plugin.version === "3.0");

  if (pluginV3.length > 0) {
    const { loadV3Plugins } = await import("./apiV3/v3.svelte");
    await loadV3Plugins(pluginV3);
  }

  if (blockedPresent.length > 0) await applyBlockedPlugins(blockedPresent);
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

/**
 * @deprecated HaejeokRisuai not supported V2 Plugin. do not use it.
 */
export async function loadV2Plugin(plugins: PluginMetadata[]) {
  void plugins;
}

export async function translatorPlugin(text: string, from: string, to: string) {
  void text;
  void from;
  void to;
  return false;
}

export async function pluginProcess(
  arg:
    | {
        prompt_chat: OpenAIChat[];
        temperature: number;
        max_tokens: number;
        presence_penalty: number;
        frequency_penalty: number;
        bias: [string, number][];
      }
    | Record<string, never>,
) {
  void arg;
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
      if (confirmation) trimmedPlugins.push(plugin);
    } else {
      console.warn(
        `Plugin "${plugin.name}" already exists, skipping installation via plugin.`,
      );
    }
  }

  return trimmedPlugins;
}
