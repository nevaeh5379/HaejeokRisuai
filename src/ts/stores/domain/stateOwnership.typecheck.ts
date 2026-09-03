import type { settingsStore } from "./settingsStore.svelte";
import type { presetStore } from "./presetStore.svelte";
import type { PresetSettingKey, PresetState, SettingsState } from "./stateOwnership";
import type { SettingContext, SettingItem, SettingPath } from "../../setting/types";

type Assert<T extends true> = T;
/** Every protocol preset key must be absent from SettingsStore and present in PresetStore. */
export type OwnershipContract = [
  Assert<Extract<keyof SettingsState, PresetSettingKey> extends never ? true : false>,
  Assert<Exclude<PresetSettingKey, keyof PresetState> extends never ? true : false>,
  Assert<Extract<keyof SettingsState, keyof PresetState> extends never ? true : false>,
];

/** Compile-only regression checks, included by pnpm check; never executed. */
export function checkOwnership(
  settings: typeof settingsStore,
  presets: typeof presetStore,
  ctx: SettingContext,
): void {
  settings.set("askRemoval", true);
  presets.set("localNetworkMode", true);
  // @ts-expect-error Preset fields are not settings, including through aliases.
  settings.state.localNetworkMode;
  // @ts-expect-error Read API must reject preset keys.
  settings.get("localNetworkMode");
  // @ts-expect-error Write API must reject preset keys.
  settings.set("localNetworkMode", true);
  // @ts-expect-error Delete API must reject preset keys.
  settings.delete("localNetworkMode");
  // @ts-expect-error Mutation callbacks must expose only settings.
  settings.update((state) => { state.mainPrompt = "wrong store"; });
  // @ts-expect-error Hydration callbacks must expose only settings.
  settings.hydrate((state) => { state.localNetworkMode = true; });
  // @ts-expect-error Ordinary snapshots must not expose startup-only preset data.
  settings.getStateRecord().localNetworkMode;
  // @ts-expect-error Settings do not belong to the preset state.
  presets.state.askRemoval;
  // @ts-expect-error Preset writes must reject settings keys.
  presets.set("askRemoval", true);
  // @ts-expect-error A preset flag must retain its boolean value type.
  presets.set("localNetworkMode", "true");
  // @ts-expect-error Other domain stores remain excluded.
  settings.state.modules;
  // @ts-expect-error UI contexts must not pretend settings contain presets.
  ctx.db.localNetworkMode;
  // @ts-expect-error UI contexts must not pretend presets contain settings.
  ctx.preset.theme;
  // @ts-expect-error Bindings cannot route another domain through SettingsStore.
  const item: SettingItem = { id: "invalid", type: "text", bindKey: "modules" };
  // @ts-expect-error Nested paths must name an existing field.
  const path: SettingPath = "deeplOptions.nonexistent";
  void item;
  void path;
}
