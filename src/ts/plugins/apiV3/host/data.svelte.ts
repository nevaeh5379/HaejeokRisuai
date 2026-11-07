import {
  allowedDbKeys,
  isPluginDatabaseKey,
  type PluginDatabase,
  type PluginDatabaseFields,
  type PluginDatabaseKey,
} from "./databaseTypes";
import { get } from "svelte/store";
import { v4 } from "uuid";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { pluginStore } from "src/ts/stores/domain/pluginStore.svelte";
import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";
import { personaStore } from "src/ts/stores/domain/personaStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { selectedCharID } from "src/ts/stores.svelte";
import type { RisuPlugin } from "@risuai/protocol/domain/legacy/plugin.ts";
import type { Chat } from "@risuai/protocol/domain/legacy/chat.ts";
import type {
  PluginMetadata,
  PluginScript,
  PluginStorageValue,
} from "@risuai/protocol/domain/pluginTypes.ts";
import {
  toLegacyCharacterSnapshot,
  toLegacyChatSnapshot,
  toLegacyModule,
  toLegacyPersona,
  toLegacyPlugin,
  fromLegacyCharacter,
  fromLegacyChat,
  fromLegacyModule,
  fromLegacyPersona,
  type LegacyCharacter,
  type CharacterSnapshot,
} from "../../legacyObjects";
import {
  prepareDatabaseSnapshot,
  type DatabaseSnapshotTransfer,
} from "../databaseSnapshot.svelte";
import {
  handlePluginInstallViaPlugin,
  getRuntimePlugin,
} from "../../plugins.svelte";

type SnapshotTarget = number | string;

export async function loadPluginCharacter(
  target: SnapshotTarget,
): Promise<LegacyCharacter | null> {
  const value = await characterStore.snapshot.load(target);
  return value ? toLegacyCharacterSnapshot(value) : null;
}
export async function savePluginCharacter(
  target: SnapshotTarget,
  value: LegacyCharacter,
): Promise<void> {
  const current = await characterStore.snapshot.load(target);
  if (!current) return;
  await characterStore.snapshot.save(
    current.chaId,
    fromLegacyCharacter(value, current),
  );
}
export async function loadPluginChat(
  character: SnapshotTarget,
  chat: SnapshotTarget,
): Promise<Chat | null> {
  const value = await characterStore.snapshot.chat.load(character, chat);
  return value ? toLegacyChatSnapshot(value) : null;
}
export async function savePluginChat(
  character: SnapshotTarget,
  chat: SnapshotTarget,
  value: Chat,
): Promise<void> {
  const characterId =
    typeof character === "string"
      ? character
      : characterStore.characters[character]?.chaId;
  if (!characterId) return;
  const current = await characterStore.snapshot.chat.load(characterId, chat);
  if (!current) return;
  await characterStore.snapshot.chat.save(
    characterId,
    current.id!,
    fromLegacyChat(value, current),
  );
}
export async function loadPluginCharacters(): Promise<LegacyCharacter[]> {
  const ids = characterStore.characters.map((character) => character.chaId);
  const result: LegacyCharacter[] = [];
  for (const id of ids) {
    const value = await loadPluginCharacter(id);
    if (value) result.push(value);
  }
  return result;
}
export async function savePluginCharacters(
  values: LegacyCharacter[],
): Promise<void> {
  const result: CharacterSnapshot[] = [];
  for (const value of values) {
    const current = await characterStore.snapshot.load(value.chaId);
    result.push(fromLegacyCharacter(value, current ?? undefined));
  }
  await characterStore.snapshot.saveAll(result);
}
export async function loadPluginRecords(): Promise<RisuPlugin[]> {
  const result: RisuPlugin[] = [];
  for (const plugin of pluginStore.plugins) {
    const { script } = await pluginStore.loadScript(plugin.id);
    result.push(toLegacyPlugin($state.snapshot(plugin), script));
  }
  return result;
}
export async function replacePluginRecords(
  values: RisuPlugin[],
): Promise<void> {
  const metadata: PluginMetadata[] = [];
  const scripts: PluginScript[] = [];
  for (const [position, value] of values.entries()) {
    const current = pluginStore.getByName(value.name);
    const id = current?.id ?? v4();
    metadata.push({
      id,
      position,
      name: value.name,
      displayName: value.displayName,
      arguments: structuredClone(value.arguments),
      realArg: structuredClone(value.realArg),
      version: value.version,
      customLink: structuredClone(value.customLink),
      argMeta: structuredClone(value.argMeta),
      versionOfPlugin: value.versionOfPlugin,
      updateURL: value.updateURL,
      enabled: current?.enabled ?? value.enabled,
      allowedIPC: $state.snapshot(current?.allowedIPC ?? value.allowedIPC),
    });
    scripts.push({ pluginId: id, script: value.script });
  }
  await pluginStore.replaceAll(metadata, scripts);
}

export function getCurrentCharacterIndex(): number {
  return get(selectedCharID);
}
export function getCurrentChatIndex(): number {
  return characterStore.characters[getCurrentCharacterIndex()]?.chatPage ?? 0;
}
export async function getPluginCharacter(): Promise<
  LegacyCharacter | undefined
> {
  return (await loadPluginCharacter(getCurrentCharacterIndex())) ?? undefined;
}
export function setPluginCharacter(value: LegacyCharacter): Promise<void> {
  return savePluginCharacter(getCurrentCharacterIndex(), value);
}
export function loadPluginScript(id: string): Promise<PluginScript> {
  return pluginStore.loadScript(id);
}
export function getPluginArgument(
  name: string,
  key: string,
): string | number | undefined {
  return (
    getRuntimePlugin(name)?.realArg[key] ??
    pluginStore.getByName(name)?.realArg[key]
  );
}
export function setPluginArgument(
  name: string,
  key: string,
  value: string | number,
): void {
  const stored = pluginStore.getByName(name);
  if (stored) stored.realArg[key] = value;
  const runtime = getRuntimePlugin(name);
  if (runtime) runtime.realArg[key] = value;
}

function readDatabaseKey(
  key: PluginDatabaseKey,
): PluginDatabaseFields[PluginDatabaseKey] | undefined {
  switch (key) {
    case "modules":
      return moduleStore.modules.map((module) =>
        toLegacyModule($state.snapshot(module)),
      );
    case "enabledModules":
      return $state.snapshot(moduleStore.enabledModules);
    case "personas":
      return personaStore.personas.map((persona) =>
        toLegacyPersona($state.snapshot(persona)),
      );
    case "selectedPersona":
      return personaStore.activeIndex;
    case "moduleIntergration":
      return $state.snapshot(presetStore.state.moduleIntergration);
    case "temperature":
      return $state.snapshot(presetStore.state.temperature);
    case "maxContext":
      return $state.snapshot(presetStore.state.maxContext);
    case "maxResponse":
      return $state.snapshot(presetStore.state.maxResponse);
    case "frequencyPenalty":
      return $state.snapshot(presetStore.state.frequencyPenalty);
    case "PresensePenalty":
      return $state.snapshot(presetStore.state.PresensePenalty);
    case "seperateModelsForAxModels":
      return $state.snapshot(presetStore.state.seperateModelsForAxModels);
    case "seperateModels":
      return $state.snapshot(presetStore.state.seperateModels);
    case "pluginV2":
      return $state.snapshot(settingsStore.state.pluginV2);
    case "pluginCustomStorage":
      return $state.snapshot(settingsStore.state.pluginCustomStorage);
    case "askRemoval":
      return $state.snapshot(settingsStore.state.askRemoval);
    case "theme":
      return $state.snapshot(settingsStore.state.theme);
    case "textTheme":
      return $state.snapshot(settingsStore.state.textTheme);
    case "lineHeight":
      return $state.snapshot(settingsStore.state.lineHeight);
    case "customCSS":
      return $state.snapshot(settingsStore.state.customCSS);
    case "guiHTML":
      return $state.snapshot(settingsStore.state.guiHTML);
    case "colorSchemeName":
      return $state.snapshot(settingsStore.state.colorSchemeName);
    case "characterOrder":
      return $state.snapshot(settingsStore.state.characterOrder);
    case "characters":
    case "plugins":
      throw new Error(`Database key requires asynchronous loading: ${key}`);
  }
}

function requireArray(
  value: unknown,
  key: PluginDatabaseKey,
): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Plugin database ${key} must be an array`);
  }
}

export function getPluginDatabase(
  includeOnly: string[] | "all" = "all",
): DatabaseSnapshotTransfer {
  const reader = new Proxy<PluginDatabase>(
    {},
    {
      get: (_target, key) =>
        typeof key === "string" && isPluginDatabaseKey(key)
          ? readDatabaseKey(key)
          : undefined,
    },
  );
  return prepareDatabaseSnapshot(
    reader,
    allowedDbKeys,
    loadPluginRecords,
    includeOnly,
    loadPluginCharacters,
  );
}

export async function setPluginDatabase(
  value: PluginDatabase,
  lite = false,
): Promise<void> {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    switch (key) {
      case "characters": {
        const characters = value.characters;
        requireArray(characters, key);
        await savePluginCharacters(characters);
        break;
      }
      case "modules": {
        const modules = value.modules;
        requireArray(modules, key);
        moduleStore.upsertModules(
          modules.map((module) =>
            fromLegacyModule(
              module,
              $state.snapshot(
                moduleStore.modules.find((current) => current.id === module.id),
              ),
            ),
          ),
        );
        break;
      }
      case "enabledModules": {
        const modules = value.enabledModules;
        requireArray(modules, key);
        if (!modules.every((id) => typeof id === "string")) {
          throw new TypeError("Module IDs must be strings");
        }
        moduleStore.enabledModules = [...modules];
        break;
      }
      case "plugins": {
        if (lite) break;
        requireArray(value.plugins, key);
        await replacePluginRecords(
          await handlePluginInstallViaPlugin(value.plugins),
        );
        break;
      }
      case "personas": {
        const personas = value.personas;
        requireArray(personas, key);
        personaStore.replace(
          personas.map((persona) =>
            fromLegacyPersona(
              persona,
              $state.snapshot(
                personaStore.personas.find(
                  (current) => current.id === persona.id,
                ),
              ),
            ),
          ),
        );
        break;
      }
      case "selectedPersona":
        if (typeof value.selectedPersona !== "number") {
          throw new TypeError("Persona index must be a number");
        }
        personaStore.select(value.selectedPersona, "plugin API");
        break;
      case "moduleIntergration":
        presetStore.set("moduleIntergration", value.moduleIntergration);
        break;
      case "temperature":
        presetStore.set("temperature", value.temperature);
        break;
      case "maxContext":
        presetStore.set("maxContext", value.maxContext);
        break;
      case "maxResponse":
        presetStore.set("maxResponse", value.maxResponse);
        break;
      case "frequencyPenalty":
        presetStore.set("frequencyPenalty", value.frequencyPenalty);
        break;
      case "PresensePenalty":
        presetStore.set("PresensePenalty", value.PresensePenalty);
        break;
      case "seperateModelsForAxModels":
        presetStore.set(
          "seperateModelsForAxModels",
          value.seperateModelsForAxModels,
        );
        break;
      case "seperateModels":
        presetStore.set("seperateModels", value.seperateModels);
        break;
      case "pluginV2":
        settingsStore.set("pluginV2", value.pluginV2);
        break;
      case "pluginCustomStorage":
        settingsStore.set("pluginCustomStorage", value.pluginCustomStorage);
        break;
      case "askRemoval":
        settingsStore.set("askRemoval", value.askRemoval);
        break;
      case "theme":
        settingsStore.set("theme", value.theme);
        break;
      case "textTheme":
        settingsStore.set("textTheme", value.textTheme);
        break;
      case "lineHeight":
        settingsStore.set("lineHeight", value.lineHeight);
        break;
      case "customCSS":
        settingsStore.set("customCSS", value.customCSS);
        break;
      case "guiHTML":
        settingsStore.set("guiHTML", value.guiHTML);
        break;
      case "colorSchemeName":
        settingsStore.set("colorSchemeName", value.colorSchemeName);
        break;
      case "characterOrder":
        settingsStore.set("characterOrder", value.characterOrder);
        break;
      default:
        settingsStore.setPluginCustomStorageKey(key, value[key]);
    }
  }
}
export const pluginStorage = {
  getItem: async (key: string): Promise<PluginStorageValue> => {
    const value = await settingsStore.loadPluginCustomStorageKey(key);
    return value === undefined ? null : $state.snapshot(value);
  },
  setItem: (key: string, value: PluginStorageValue) =>
    settingsStore.setPluginCustomStorageKey(key, value),
  removeItem: (key: string) => settingsStore.removePluginCustomStorageKey(key),
  clear: () => settingsStore.clearPluginCustomStorage(),
  key: (index: number) =>
    settingsStore.getPluginCustomStorageKeys()[index] ?? null,
  keys: () => settingsStore.getPluginCustomStorageKeys(),
  length: () => settingsStore.getPluginCustomStorageKeys().length,
};

export function getPluginDatabaseView(): PluginDatabase {
  const read = (key: string): PluginStorageValue =>
    isPluginDatabaseKey(key)
      ? readDatabaseKey(key)
      : $state.snapshot(settingsStore.state.pluginCustomStorage?.[key]);
  const has = (key: string): boolean =>
    isPluginDatabaseKey(key) || settingsStore.hasPluginCustomStorageKey(key);
  return new Proxy<PluginDatabase>(
    {},
    {
      get: (_target, key) => (typeof key === "string" ? read(key) : undefined),
      set: (_target, key, value: unknown) => {
        if (typeof key !== "string") return false;
        void setPluginDatabase({ [key]: value }).catch((error: unknown) =>
          console.error(`Failed to save plugin database key '${key}'`, error),
        );
        return true;
      },
      ownKeys: () => [
        ...new Set([
          ...allowedDbKeys,
          ...settingsStore.getPluginCustomStorageKeys(),
        ]),
      ],
      has: (_target, key) => typeof key === "string" && has(key),
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === "string" && has(key)
          ? {
              value: read(key),
              writable: true,
              enumerable: true,
              configurable: true,
            }
          : undefined,
      deleteProperty: (_target, key) => {
        if (typeof key !== "string" || isPluginDatabaseKey(key)) {
          return false;
        }
        settingsStore.removePluginCustomStorageKey(key);
        return true;
      },
    },
  );
}
