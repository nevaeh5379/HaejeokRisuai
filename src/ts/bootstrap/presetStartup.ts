import {
  createActivePresetSnapshot,
  createPresetSettingsState,
} from "../storage/presets/presetService";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

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
      const liveModuleIntegration =
        settingsStore.getBootstrapState().moduleIntergration;
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
          settingsStore.getBootstrapState(),
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
      }
      performance.mark("active-preset-ready");
    })
    .catch(() => undefined);
}
