import type { Database } from "./schema";
import { normalizeCoreDatabaseSettings } from "./databaseNormalization/core";
import { normalizeContentDatabaseSettings } from "./databaseNormalization/content";
import { normalizeProviderDatabaseSettings } from "./databaseNormalization/providers";
import { normalizeFeatureDatabaseSettings } from "./databaseNormalization/features";
import { normalizeRuntimeDatabaseSettings } from "./databaseNormalization/runtime";

/**
 * Applies schema defaults, compatibility migrations, validation, and transient
 * runtime normalization without installing the database. The ordered stages
 * intentionally preserve dependencies between legacy migrations and derived
 * defaults.
 */
export function normalizeDatabaseDefaults(data: Database) {
  normalizeCoreDatabaseSettings(data);
  normalizeContentDatabaseSettings(data);
  normalizeProviderDatabaseSettings(data);
  normalizeFeatureDatabaseSettings(data);
  normalizeRuntimeDatabaseSettings(data);
  return data;
}
