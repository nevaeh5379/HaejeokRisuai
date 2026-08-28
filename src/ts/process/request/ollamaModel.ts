import type { ModelModeExtended } from "./shared";
import { resolveProviderRoleModel } from "./providerRoleSettings";

export type OllamaRequestModelSettings = {
  ollamaModel: string;
  ollamaSubModel?: string;
  ollamaCloudModel: string;
  ollamaCloudSubModel?: string;
};

export function resolveOllamaRequestModel(
  settings: OllamaRequestModelSettings,
  source: "local" | "cloud",
  mode?: ModelModeExtended,
): string {
  if (source === "cloud") {
    return resolveProviderRoleModel(
      settings.ollamaCloudModel,
      settings.ollamaCloudSubModel,
      mode,
    );
  }

  return resolveProviderRoleModel(
    settings.ollamaModel,
    settings.ollamaSubModel,
    mode,
  );
}
