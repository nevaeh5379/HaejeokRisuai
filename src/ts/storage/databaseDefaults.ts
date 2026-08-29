import type {
  botPreset,
  Database,
  StreamingDisplayOptimizationMode,
} from "./schema";
import {
  normalizeCoreDatabaseSettings,
  type CoreValidatedDefaults,
} from "./databaseNormalization/core";
import {
  normalizeContentDatabaseSettings,
  type ContentValidatedDefaults,
} from "./databaseNormalization/content";
import {
  normalizeProviderDatabaseSettings,
  type ProviderValidatedDefaults,
} from "./databaseNormalization/providers";
import {
  normalizeFeatureDatabaseSettings,
  type FeatureValidatedDefaults,
} from "./databaseNormalization/features";
import {
  normalizeRuntimeDatabaseSettings,
  type RuntimeValidatedDefaults,
} from "./databaseNormalization/runtime";

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

/** Sparse or legacy database data before current defaults are applied. */
export type DatabaseInput = Omit<
  DeepPartial<Database>,
  keyof LegacyDatabaseOverrides
> &
  LegacyDatabaseOverrides &
  Record<string, unknown>;

/**
 * Fields whose current runtime shape is guaranteed by the normalization
 * pipeline. This intentionally does not claim to be a complete Database.
 */
export type NormalizedDatabaseInput = DatabaseInput &
  CoreValidatedDefaults &
  ContentValidatedDefaults &
  ProviderValidatedDefaults &
  FeatureValidatedDefaults &
  RuntimeValidatedDefaults;

function isDatabaseInputObject(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === "object" && !Array.isArray(data);
}

/**
 * Applies current defaults, compatibility migrations, validation, and transient
 * runtime normalization without installing the database.
 */
export function normalizeDatabaseDefaults(data: Database): Database;
export function normalizeDatabaseDefaults<T extends DatabaseInput>(
  data: T,
): T & NormalizedDatabaseInput;
export function normalizeDatabaseDefaults(
  data: Database | DatabaseInput,
): Database | NormalizedDatabaseInput {
  const mutable = data as Database;
  normalizeCoreDatabaseSettings(mutable);
  normalizeContentDatabaseSettings(mutable);
  normalizeProviderDatabaseSettings(mutable);
  normalizeFeatureDatabaseSettings(mutable);
  normalizeRuntimeDatabaseSettings(mutable);
  return data as Database | NormalizedDatabaseInput;
}

/** Normalizes an untyped decoded root object without pretending it is complete. */
export function normalizeDatabaseInput(data: unknown): NormalizedDatabaseInput {
  if (!isDatabaseInputObject(data)) {
    throw new TypeError("Database input must be a non-array object");
  }
  return normalizeDatabaseDefaults(data as DatabaseInput);
}
