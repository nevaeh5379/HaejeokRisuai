import { DEFAULT_SETTINGS, type LogExporterSettings } from "./types";
import { settingsStore } from "src/ts/stores/domain";

/**
 * Settings persistence for the Log Exporter.
 *
 * Uses RisuAI's plugin custom storage (settingsStore), which persists to the
 * active SQL backend and syncs with drive backups — no iframe bridge needed.
 */

const CHAR_SETTINGS_KEY = "logExporterCharacterSettings";
const GLOBAL_SETTINGS_KEY = "logExporterGlobalSettings";

type CharacterSettingsMap = Record<string, Partial<LogExporterSettings>>;

function parseRecord(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // malformed JSON
    }
  }
  return {};
}

export async function loadAllCharSettings(): Promise<CharacterSettingsMap> {
  try {
    return parseRecord(
      await settingsStore.loadPluginCustomStorageKey(CHAR_SETTINGS_KEY),
    ) as CharacterSettingsMap;
  } catch (e) {
    console.error("[logexporter] Failed to load character settings:", e);
    return {};
  }
}

export async function loadCharSettings(
  charId: string,
): Promise<Partial<LogExporterSettings>> {
  const all = await loadAllCharSettings();
  return parseRecord(all[charId]) as Partial<LogExporterSettings>;
}

export async function saveCharSettings(
  charId: string,
  settings: Partial<LogExporterSettings>,
): Promise<void> {
  try {
    const all = await loadAllCharSettings();
    all[charId] = { ...(all[charId] || {}), ...settings };
    settingsStore.setPluginCustomStorageKey(CHAR_SETTINGS_KEY, all);
  } catch (e) {
    console.error("[logexporter] Failed to save character settings:", e);
  }
}

export interface GlobalExporterSettings {
  /** Participant names excluded from rendering */
  filteredParticipants?: string[];
}

export async function loadGlobalExporterSettings(): Promise<GlobalExporterSettings> {
  try {
    return parseRecord(
      await settingsStore.loadPluginCustomStorageKey(GLOBAL_SETTINGS_KEY),
    ) as GlobalExporterSettings;
  } catch (e) {
    console.error("[logexporter] Failed to load global settings:", e);
    return {};
  }
}

export async function saveGlobalExporterSettings(
  patch: Partial<GlobalExporterSettings>,
): Promise<void> {
  try {
    const merged = { ...(await loadGlobalExporterSettings()), ...patch };
    settingsStore.setPluginCustomStorageKey(GLOBAL_SETTINGS_KEY, merged);
  } catch (e) {
    console.error("[logexporter] Failed to save global settings:", e);
  }
}

/** Merges saved character settings onto defaults. */
export function mergeWithDefaults(saved: unknown): LogExporterSettings {
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    return { ...DEFAULT_SETTINGS, ...(saved as Partial<LogExporterSettings>) };
  }
  return { ...DEFAULT_SETTINGS };
}
