import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { prepareProviderExecutionContext } from "@risuai/chat-core/providerContext.cjs";
import { getModelInfo } from "../../model/modellist";

import type { requestDataArgument } from "./requestContracts";
import {
  getProviderModeOverride,
  resolveProviderRoleModel,
  resolveProviderRoleModelForMode,
} from "./providerRoleSettings";
import type { ModelModeExtended } from "./shared";

export function prepareBrowserProviderContext(
  arg: requestDataArgument,
  model: ModelModeExtended,
) {
  const db = settingsStore.state;
  const modeOverride = getProviderModeOverride(
    presetStore.state.seperateModelsForAxModels,
    presetStore.state.providerModelOverrides,
    model,
  );

  return {
    prepared: prepareProviderExecutionContext(
      { ...arg, mode: model },
      {
        primaryModel: presetStore.state.aiModel,
        subModel: presetStore.state.subModel,
        separateModelsForAxModels: presetStore.state.seperateModelsForAxModels,
        separateModels: presetStore.state.seperateModels,
        maxResponseTokens: presetStore.state.maxResponse,
        temperaturePercent: presetStore.state.temperature,
        useStreaming: db.useStreaming,
        genTime: db.genTime,
        extractJson: presetStore.state.extractJson,
        reverseProxy: {
          requestModel: resolveProviderRoleModelForMode(
            presetStore.state.customProxyRequestModel,
            presetStore.state.customProxySubRequestModel,
            model,
            modeOverride?.customProxyRequestModel,
          ),
          format: presetStore.state.customAPIFormat,
          url: presetStore.state.forceReplaceUrl,
          key: presetStore.state.proxyKey,
        },
        customModels: db.customModels,
      },
      getModelInfo,
    ),
    messageFormatting: {
      systemContentReplacement: presetStore.state.systemContentReplacement,
      systemRoleReplacement: presetStore.state.systemRoleReplacement,
    },
  };
}
