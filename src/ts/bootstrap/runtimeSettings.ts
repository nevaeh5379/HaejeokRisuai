import { loadPlugins } from "../plugins/plugins.svelte";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";
import { deferredSettingsLoader } from "../stores/domain/deferredSettingsLoader";
import { moduleStore } from "../stores/domain/moduleStore.svelte";
import { personaStore } from "../stores/domain/personaStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

/**
 * Hydrates the relational settings that are not part of the shallow startup
 * snapshot. Hydration is deliberately sequential: the Android (Capacitor)
 * bridge serializes every returned row to JSON, so loading domains one by
 * one limits temporary peak memory on low-RAM devices.
 */
export async function initRuntimeSettings(storage: ISqlStorage): Promise<void> {
  await deferredSettingsLoader.ensureKey("customModels");

  // Domain stores load their own state; SettingsStore never receives it.
  // Persona hydration is correctness-critical because prompts depend on it.
  await personaStore.init(storage);

  // The remaining runtime extras retain their historical best-effort
  // behavior. Persona hydration above deliberately stays outside this catch.
  try {
    await moduleStore.init(storage);

    settingsStore.hydratePluginCustomStorageKeys(
      await storage.listPluginCustomStorageKeys(),
    );
    await loadPlugins();
  } catch {}
}
