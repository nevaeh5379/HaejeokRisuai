import type { ModelModeExtended } from "./shared";

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
