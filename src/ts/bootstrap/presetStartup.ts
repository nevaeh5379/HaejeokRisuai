import {
  createActivePresetSnapshot,
  createPresetSettingsState,
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
 * installs the active preset as PresetStore's canonical reactive state.
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
      const liveModuleIntegration = settingsStore.getStateRecord().moduleIntergration;
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
        const activeState = createPresetSettingsState(
          settingsStore.getStateRecord(),
          activePreset,
        );
        presetStore.bindActivePresetState(activeState, () => {
          const metadata = presetStore.activePresetMetadata;
          return metadata
            ? createActivePresetSnapshot(
                {
                  ...settingsStore.getStateRecord(),
                  ...presetStore.getStateRecord(),
                },
                metadata,
              )
            : undefined;
        });
        settingsStore.releasePresetOwnedState();
        const presetOwnedDeferredKeys = PRESET_OWNED_DEFERRED_KEYS.filter(
          (key) =>
            (activePreset as unknown as Record<string, unknown>)[key] !==
            undefined,
        );
        deferredSettingsLoader.markLoaded(presetOwnedDeferredKeys);
      }
      performance.mark("active-preset-ready");
    })
    .catch(() => undefined);
}
