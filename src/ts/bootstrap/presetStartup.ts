import {
  createActivePresetSnapshot,
  setPreset,
} from "../storage/presets/presetService";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";
import { deferredSettingsLoader } from "../stores/domain/deferredSettingsLoader";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

/**
 * Deferred settings keys that belong to the active preset: when the preset
 * is hydrated at startup these keys arrive with it, so the per-key lazy
 * loader must not hydrate them a second time.
 *
 * Kept as an explicit subset of PROMPT_SETTING_KEYS — presets only own the
 * prompt fields persisted on the preset itself, not every deferred prompt key.
 */
const PRESET_OWNED_DEFERRED_KEYS = [
  "promptTemplate",
  "promptSettings",
  "customPromptTemplateToggle",
  "mainPrompt",
  "jailbreak",
  "globalNote",
  "autoSuggestPrompt",
  "instructChatTemplate",
  "JinjaTemplate",
] as const;

/**
 * Initialises the preset domain: loads the presets, repairs the stale
 * `moduleIntergration` reference carried over by older SQL migrations and
 * binds the active-preset provider consumed by SettingsStore.
 *
 * Never rejects (matches the historical best-effort behavior).
 */
export function initPresetDomain(storage: ISqlStorage): Promise<void> {
  return presetStore
    .init(storage)
    .then(async () => {
      let activePreset = presetStore.activePreset;
      // Older SQL migrations copied the stale botPresets entry without
      // folding in the live root value for the active preset. Repair that
      // representation before setPreset can blank the visible setting.
      const liveModuleIntegration = settingsStore.state.moduleIntergration;
      if (
        activePreset &&
        activePreset.moduleIntergration === undefined &&
        typeof liveModuleIntegration === "string" &&
        liveModuleIntegration.length > 0
      ) {
        await presetStore.savePreset({
          ...activePreset,
          moduleIntergration: liveModuleIntegration,
        });
        activePreset = presetStore.activePreset;
      }
      if (activePreset) {
        settingsStore.hydrate((state) => setPreset(state, activePreset));
        const presetOwnedDeferredKeys = PRESET_OWNED_DEFERRED_KEYS.filter(
          (key) =>
            (activePreset as unknown as Record<string, unknown>)[key] !==
            undefined,
        );
        deferredSettingsLoader.markLoaded(presetOwnedDeferredKeys);
        presetStore.bindActivePresetProvider(() => {
          const metadata = presetStore.activePresetMetadata;
          return metadata
            ? createActivePresetSnapshot(settingsStore.state, metadata)
            : undefined;
        });
      }
      performance.mark("active-preset-ready");
    })
    .catch(() => undefined);
}
