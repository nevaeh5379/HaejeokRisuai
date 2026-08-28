import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import { prepareProviderExecutionContext } from "@risuai/chat-core/providerContext.cjs";
import { getModelInfo } from "../../model/modellist";

import type { requestDataArgument } from "./requestContracts";
import { resolveProviderRoleModel } from "./providerRoleSettings";
import type { ModelModeExtended } from "./shared";

export function prepareBrowserProviderContext(
  arg: requestDataArgument,
  model: ModelModeExtended,
) {
  const db = settingsStore.state;
  return {
    prepared: prepareProviderExecutionContext(
      { ...arg, mode: model },
      {
        primaryModel: db.aiModel,
        subModel: db.subModel,
        separateModelsForAxModels: db.seperateModelsForAxModels,
        separateModels: db.seperateModels,
        maxResponseTokens: db.maxResponse,
        temperaturePercent: db.temperature,
        useStreaming: db.useStreaming,
        genTime: db.genTime,
        extractJson: db.extractJson,
        reverseProxy: {
          requestModel: resolveProviderRoleModel(
            db.customProxyRequestModel,
            db.customProxySubRequestModel,
            model,
          ),
          format: db.customAPIFormat,
          url: db.forceReplaceUrl,
          key: db.proxyKey,
        },
        customModels: db.customModels,
      },
      getModelInfo,
    ),
    messageFormatting: {
      systemContentReplacement: db.systemContentReplacement,
      systemRoleReplacement: db.systemRoleReplacement,
    },
  };
}
