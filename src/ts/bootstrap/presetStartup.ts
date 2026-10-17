import { getPresetApplyPolicy } from "../storage/presets/presetService";
import { repairLegacyModuleIntegration } from "../storage/presets/legacyPresetMigration";
import type { ISqlStorage } from "../storage/sql/ISqlStorage";
import { presetStore } from "../stores/domain/presetStore.svelte";
import { settingsStore } from "../stores/domain/settingsStore.svelte";

/** Load the independent preset domain, then release legacy root mirrors. */
export async function initPresetDomain(storage: ISqlStorage): Promise<void> {
  try {
    presetStore.setPolicyProvider(getPresetApplyPolicy);
    await presetStore.init(storage);
    if (
      await repairLegacyModuleIntegration(
        storage,
        presetStore.activeId,
        presetStore.activeIndex,
        settingsStore.getBootstrapState().moduleIntergration,
      )
    ) {
      await presetStore.retryActive();
    }
    settingsStore.releasePresetOwnedState();
    performance.mark("active-preset-ready");
  } catch (error) {
    console.error("[PRESET DOMAIN INIT ERROR]:", error);
  }
}
