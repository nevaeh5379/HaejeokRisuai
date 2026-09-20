import type {
  CompatibilityOptions,
  ColdStorageValueMap,
} from "./compatibility";
import { makeLegacyCompatibleDatabase } from "./compatibility";
import { expandPortableDatabaseBranchGraphsForCompatibility } from "./portableBranches";
import type { LocalBackupMode } from "./api";

/** Backup modes that produce a full portable database (never "partial"). */
export type PortableBackupMode = Exclude<LocalBackupMode, "partial">;

export interface PortableBackupDatabaseOptions {
  /**
   * Compatibility wiring (clone/idFactory/coldStorageHeader). Hosts with a
   * custom safe-clone or id factory pass it here; core falls back to
   * structuredClone + crypto.randomUUID.
   */
  compatibility?: CompatibilityOptions;
}

/**
 * Prepares a loaded portable database snapshot for a local backup export.
 *
 * Performs a shallow top-level copy: nested values are shared by reference,
 * so nothing beyond the top level is copied eagerly. The source object is
 * never mutated. In "compatible" mode the database is expanded into the
 * legacy single-chat format (branch graphs flattened, cold storage
 * materialized) using the shared compatibility helpers.
 */
export function buildPortableLocalBackupDatabase(
  db: Record<string, any>,
  mode: PortableBackupMode,
  coldStorageValues?: ColdStorageValueMap,
  options: PortableBackupDatabaseOptions = {},
): Record<string, any> {
  const cleanDb: Record<string, any> = {};
  for (const [key, value] of Object.entries(db)) {
    if (
      key === "account" ||
      typeof value === "function" ||
      (mode === "compatible" && key === "moduleFolders")
    )
      continue;
    cleanDb[key] = value;
  }
  cleanDb.pluginCustomStorage ??= {};
  if (mode !== "compatible") return cleanDb;
  const expanded = expandPortableDatabaseBranchGraphsForCompatibility(cleanDb);
  return makeLegacyCompatibleDatabase(
    expanded,
    coldStorageValues,
    options.compatibility,
  );
}

/**
 * Normalizes a freshly decoded/loaded portable database snapshot in place
 * and returns the same object (mutation semantics are preserved: callers
 * own the freshly decoded snapshot, so no copy is made). Restores the
 * legacy persona mirror fields from the selected persona and applies
 * required defaults.
 */
export function normalizePortableBackupSnapshot<T extends object>(db: T): T {
  const draft = db as Record<string, any>;
  draft.pluginCustomStorage ??= {};
  if (!draft.personas || draft.personas.length === 0) {
    draft.personas = [
      {
        name: draft.username ?? "User",
        icon: draft.userIcon ?? "",
        personaPrompt: draft.personaPrompt ?? "",
        note: draft.userNote ?? "",
        largePortrait: false,
      },
    ];
  } else {
    for (const persona of draft.personas) {
      if (persona) persona.largePortrait ??= false;
    }
  }
  if (
    typeof draft.selectedPersona !== "number" ||
    !Number.isInteger(draft.selectedPersona) ||
    !draft.personas[draft.selectedPersona]
  ) {
    draft.selectedPersona = 0;
  }

  const activePersona = draft.personas[draft.selectedPersona];
  draft.username = activePersona.name;
  draft.userIcon = activePersona.icon;
  draft.userNote = activePersona.note ?? "";
  draft.personaPrompt = activePersona.personaPrompt;
  draft.botPresets ??= [];
  draft.botPresetsId ??= 0;
  return db;
}
