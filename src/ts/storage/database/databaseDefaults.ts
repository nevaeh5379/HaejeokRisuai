import type {
  botPreset,
  Database,
  DatabaseSettings,
  PortableDatabase,
  StreamingDisplayOptimizationMode,
} from "./schema";
import { safeStructuredClone } from "../../polyfill";
import { presetTemplate } from "../presets/presetDefaults";
import { SETTINGS_STORE_EXCLUDED_KEYS } from "../sql/sqlDeferredSettings";
import {
  normalizeCoreDatabaseSettings,
  type CoreValidatedDefaults,
} from "./normalization/core";
import {
  normalizeContentDatabaseSettings,
  type ContentValidatedDefaults,
} from "./normalization/content";
import {
  normalizeProviderDatabaseSettings,
  normalizePortablePreset,
  type ProviderValidatedDefaults,
} from "./normalization/providers";
import {
  normalizeFeatureDatabaseSettings,
  type FeatureValidatedDefaults,
} from "./normalization/features";
import {
  normalizeRuntimeDatabaseSettings,
  type RuntimeValidatedDefaults,
} from "./normalization/runtime";

export type SettingsInput = {
  [K in keyof DatabaseSettings]?: unknown;
} & Record<string, unknown>;

export type NormalizedSettingsInput = SettingsInput &
  CoreValidatedDefaults &
  ContentValidatedDefaults &
  ProviderValidatedDefaults &
  FeatureValidatedDefaults &
  RuntimeValidatedDefaults;

const NON_SETTINGS_KEYS = new Set(SETTINGS_STORE_EXCLUDED_KEYS);

function requireObject(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(`${label} must be a non-array object`);
  }
  return input as Record<string, unknown>;
}

function assertSettingsOwnership(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (NON_SETTINGS_KEYS.has(key)) {
      throw new Error(`${key} is owned by another domain store`);
    }
  }
}

export function normalizeSettingsDefaults<T extends SettingsInput>(
  input: T,
): T & NormalizedSettingsInput {
  assertSettingsOwnership(input);
  const data = input as unknown as Database;
  normalizeCoreDatabaseSettings(data);
  normalizeContentDatabaseSettings(data);
  normalizeProviderDatabaseSettings(data);
  normalizeFeatureDatabaseSettings(data);
  normalizeRuntimeDatabaseSettings(data);
  return input as T & NormalizedSettingsInput;
}

export function normalizeSettingsInput(input: unknown): NormalizedSettingsInput {
  const data = requireObject(input, "Settings input") as SettingsInput;
  return normalizeSettingsDefaults(data);
}
type DeepPartial<T> = T extends readonly (infer TItem)[]
  ? DeepPartial<TItem>[]
  : T extends object
    ? { [TKey in keyof T]?: DeepPartial<T[TKey]> }
    : T;

type LegacyBotPresetInput = Omit<
  DeepPartial<botPreset>,
  "openrouterProvider"
> & {
  openrouterProvider?: botPreset["openrouterProvider"] | string;
};

type LegacyDatabaseOverrides = {
  openrouterProvider?: Database["openrouterProvider"] | string;
  largeChatPerformanceMode?: StreamingDisplayOptimizationMode;
  botPresets?: LegacyBotPresetInput[];
  botPresetsId?: number;
};

export type DatabaseInput = Omit<
  DeepPartial<Database>,
  keyof LegacyDatabaseOverrides
> &
  LegacyDatabaseOverrides &
  Record<string, unknown>;
export type NormalizedDatabaseInput = DatabaseInput &
  NormalizedSettingsInput &
  Required<
    Pick<
      Database,
      | "characters"
      | "personas"
      | "selectedPersona"
      | "modules"
      | "enabledModules"
      | "moduleFolders"
    >
  >;

function normalizeLegacyPersonaMirrors(data: Database): void {
  if (typeof data.username !== "string") data.username = "User";
  if (typeof data.userIcon !== "string") data.userIcon = "";
  if (typeof data.userNote !== "string") data.userNote = "";
  if (typeof data.personaPrompt !== "string") data.personaPrompt = "";
}

function normalizeAggregateDomains(data: Database): void {
  normalizeLegacyPersonaMirrors(data);
  data.characters ??= [];
  data.modules ??= [];
  data.enabledModules ??= [];
  data.moduleFolders ??= [];

  if (!Array.isArray(data.personas) || data.personas.length === 0) {
    data.personas = [
      {
        name: data.username,
        icon: data.userIcon,
        personaPrompt: data.personaPrompt,
        note: data.userNote,
        largePortrait: false,
      },
    ];
  } else {
    for (const persona of data.personas) persona.largePortrait ??= false;
  }
  if (
    typeof data.selectedPersona !== "number" ||
    !Number.isInteger(data.selectedPersona) ||
    !data.personas[data.selectedPersona]
  ) {
    data.selectedPersona = 0;
  }

  const portable = data as Database & Partial<PortableDatabase>;
  if (!Array.isArray(portable.botPresets) || portable.botPresets.length === 0) {
    portable.botPresets = [
      {
        ...safeStructuredClone(presetTemplate),
        name: "Default",
      },
    ];
  }
  for (const preset of portable.botPresets) normalizePortablePreset(preset);
  portable.botPresetsId ??= 0;

  for (const character of data.characters) {
    for (const chat of character.chats ?? []) {
      chat.isStreaming = false;
      chat.activeStreamingDisplayOptimizationMode = undefined;
    }
  }
}

export function normalizeDatabaseDefaults(data: Database): Database;
export function normalizeDatabaseDefaults<T extends DatabaseInput>(
  data: T,
): T & NormalizedDatabaseInput;
export function normalizeDatabaseDefaults(
  input: Database | DatabaseInput,
): Database | NormalizedDatabaseInput {
  const data = input as Database;
  normalizeCoreDatabaseSettings(data);
  normalizeContentDatabaseSettings(data);
  normalizeProviderDatabaseSettings(data);
  normalizeFeatureDatabaseSettings(data);
  normalizeRuntimeDatabaseSettings(data);
  normalizeAggregateDomains(data);
  return input as Database | NormalizedDatabaseInput;
}

export function normalizeDatabaseInput(input: unknown): NormalizedDatabaseInput {
  const data = requireObject(input, "Database input") as DatabaseInput;
  return normalizeDatabaseDefaults(data);
}
