import { get } from "svelte/store";
import { v4 } from "uuid";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { pluginStore } from "src/ts/stores/domain/pluginStore.svelte";
import { moduleStore } from "src/ts/stores/domain/moduleStore.svelte";
import { personaStore } from "src/ts/stores/domain/personaStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { selectedCharID } from "src/ts/stores.svelte";
import { isPresetStoreSettingKey } from "src/ts/storage/sql/sqlDeferredSettings";
import type { RisuModule } from "@risuai/protocol/domain/legacy/module.ts";
import type { RisuPersona } from "@risuai/protocol/domain/legacy/persona.ts";
import type { RisuPlugin } from "@risuai/protocol/domain/legacy/plugin.ts";
import type { Chat } from "@risuai/protocol/domain/legacy/chat.ts";
import type {
  PluginMetadata,
  PluginScript,
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
} from "../../legacyObjects";
import { prepareDatabaseSnapshot } from "../databaseSnapshot.svelte";
import {
  handlePluginInstallViaPlugin,
  getRuntimePlugin,
} from "../../plugins.svelte";

type SnapshotTarget = number | string;

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
  const result = [];
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

function readDatabaseKey(key: string): unknown {
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
    case "characters":
    case "plugins":
      throw new Error(`Database key requires asynchronous loading: ${key}`);
    default:
      return isPresetStoreSettingKey(key)
        ? $state.snapshot(presetStore.state[key])
        : $state.snapshot(settingsStore.state[key]);
  }
}

function requireArray(value: unknown, key: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`Plugin database ${key} must be an array`);
  }
}
async function writeDatabaseKey(key: string, value: unknown): Promise<void> {
  switch (key) {
    case "characters":
      requireArray(value, key);
      return savePluginCharacters(value as LegacyCharacter[]);
    case "modules": {
      requireArray(value, key);
      moduleStore.upsertModules(
        (value as RisuModule[]).map((module) =>
          fromLegacyModule(
            module,
            $state.snapshot(
              moduleStore.modules.find((current) => current.id === module.id),
            ),
          ),
        ),
      );
      return;
    }
    case "enabledModules":
      requireArray(value, key);
      if (!value.every((id) => typeof id === "string")) {
        throw new TypeError("Module IDs must be strings");
      }
      moduleStore.enabledModules = [...value];
      return;
    case "plugins":
      requireArray(value, key);
      return replacePluginRecords(value as RisuPlugin[]);
    case "personas":
      requireArray(value, key);
      personaStore.replace(
        (value as RisuPersona[]).map((persona) =>
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
      return;
    case "selectedPersona":
      if (typeof value !== "number") {
        throw new TypeError("Persona index must be a number");
      }
      personaStore.select(value, "plugin API");
      return;
    default: {
      if (isPresetStoreSettingKey(key)) {
        presetStore.set(key, value as (typeof presetStore.state)[typeof key]);
      } else {
        const settingKey = key as Parameters<typeof settingsStore.set>[0];
        settingsStore.set(
          settingKey,
          value as (typeof settingsStore.state)[typeof settingKey],
        );
      }
    }
  }
}
export function getPluginDatabase(includeOnly: string[] | "all" = "all") {
  const reader = new Proxy<Record<string, unknown>>(
    {},
    {
      get: (_target, key) =>
        typeof key === "string" ? readDatabaseKey(key) : undefined,
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
  value: Record<string, unknown>,
  lite = false,
): Promise<void> {
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "plugins" && lite) continue;
    const next =
      key === "plugins"
        ? await handlePluginInstallViaPlugin(item as RisuPlugin[])
        : item;
    if (allowedDbKeys.includes(key)) await writeDatabaseKey(key, next);
    else settingsStore.setPluginCustomStorageKey(key, next);
  }
}
export const pluginStorage = {
  getItem: async (key: string): Promise<unknown> => {
    const value = await settingsStore.loadPluginCustomStorageKey(key);
    return value === undefined ? null : $state.snapshot(value);
  },
  setItem: (key: string, value: unknown) =>
    settingsStore.setPluginCustomStorageKey(key, value),
  removeItem: (key: string) => settingsStore.removePluginCustomStorageKey(key),
  clear: () => settingsStore.clearPluginCustomStorage(),
  key: (index: number) =>
    settingsStore.getPluginCustomStorageKeys()[index] ?? null,
  keys: () => settingsStore.getPluginCustomStorageKeys(),
  length: () => settingsStore.getPluginCustomStorageKeys().length,
};

export function getPluginDatabaseView(): Record<string, unknown> {
  const read = (key: string): unknown =>
    allowedDbKeys.includes(key)
      ? readDatabaseKey(key)
      : $state.snapshot(settingsStore.state.pluginCustomStorage?.[key]);
  const has = (key: string): boolean =>
    allowedDbKeys.includes(key) || settingsStore.hasPluginCustomStorageKey(key);
  return new Proxy<Record<string, unknown>>(
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
        if (typeof key !== "string" || allowedDbKeys.includes(key)) {
          return false;
        }
        settingsStore.removePluginCustomStorageKey(key);
        return true;
      },
    },
  );
}
