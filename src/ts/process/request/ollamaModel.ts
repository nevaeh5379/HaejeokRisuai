import type { ModelModeExtended } from "./shared";
import { resolveProviderRoleModelForMode } from "./providerRoleSettings";
import type { ProviderModelOverride } from "../../storage/database/schema";

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
  modeOverride?: ProviderModelOverride,
): string {
  if (source === "cloud") {
    return resolveProviderRoleModelForMode(
      settings.ollamaCloudModel,
      settings.ollamaCloudSubModel,
      mode,
      modeOverride?.ollamaCloudModel,
    );
  }

  return resolveProviderRoleModelForMode(
    settings.ollamaModel,
    settings.ollamaSubModel,
    mode,
    modeOverride?.ollamaModel,
  );
}
