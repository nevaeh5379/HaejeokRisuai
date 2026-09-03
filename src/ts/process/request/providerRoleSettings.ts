import type { ModelModeExtended } from "./shared";

export type ProviderFeatureMode = Exclude<
  ModelModeExtended,
  "model" | "submodel"
>;

export function isProviderFeatureMode(
  mode?: ModelModeExtended,
): mode is ProviderFeatureMode {
  return (
    mode === "memory" ||
    mode === "emotion" ||
    mode === "otherAx" ||
    mode === "translate"
  );
}

export function getProviderModeOverride<T>(
  enabled: boolean,
  overrides: Partial<Record<ProviderFeatureMode, T>> | null | undefined,
  mode?: ModelModeExtended,
): T | undefined {
  if (!enabled || !isProviderFeatureMode(mode)) {
    return undefined;
  }
  return overrides?.[mode];
}

export function isAuxiliaryProviderMode(mode?: ModelModeExtended): boolean {
  return mode !== undefined && mode !== "model";
}

export function resolveProviderRoleSetting<T>(
  mainValue: T,
  auxiliaryValue: T | null | undefined,
  mode?: ModelModeExtended,
): T {
  return isAuxiliaryProviderMode(mode)
    ? (auxiliaryValue ?? mainValue)
    : mainValue;
}

export function resolveProviderRoleModel(
  mainModel: string,
  auxiliaryModel: string | null | undefined,
  mode?: ModelModeExtended,
): string {
  const selected = resolveProviderRoleSetting(mainModel, auxiliaryModel, mode);
  return selected || mainModel;
}

export function resolveProviderRoleModelForMode(
  mainModel: string,
  subModel: string | null | undefined,
  mode?: ModelModeExtended,
  modeOverride?: string | null | undefined,
): string {
  if (isAuxiliaryProviderMode(mode) && modeOverride) {
    return modeOverride;
  }
  return resolveProviderRoleModel(mainModel, subModel, mode);
}

export function resolveProviderRoleSettingForMode<T>(
  mainValue: T,
  auxiliaryValue: T | null | undefined,
  mode?: ModelModeExtended,
  modeOverride?: T | null | undefined,
): T {
  if (
    isAuxiliaryProviderMode(mode) &&
    modeOverride !== null &&
    modeOverride !== undefined
  ) {
    return modeOverride;
  }
  return resolveProviderRoleSetting(mainValue, auxiliaryValue, mode);
}
