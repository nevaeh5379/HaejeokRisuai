export type ProviderModelMode =
  "model" | "submodel" | "memory" | "emotion" | "otherAx" | "translate";

export interface ProviderModelDescriptor {
  id: string;
  internalID?: string;
  format: number;
}

export interface ProviderRequestContextInput {
  mode: ProviderModelMode;
  staticModel?: string;
  maxTokens?: number;
  temperature?: number;
  forceStreaming?: boolean;
  useStreaming?: boolean;
  continue?: boolean;
  biasString?: [string, number][];
  noMultiGen?: boolean;
  extractJson?: string;
  blockPlugins?: boolean;
}

export interface ProviderExecutionSettings {
  primaryModel: string;
  subModel: string;
  separateModelsForAxModels: boolean;
  separateModels?: Partial<Record<ProviderModelMode, string>>;
  maxResponseTokens: number;
  temperaturePercent: number;
  useStreaming: boolean;
  genTime: number;
  extractJson?: string;
  reverseProxy?: {
    requestModel?: string;
    format?: number;
    url?: string;
    key?: string;
  };
  customModels?: Array<{
    id: string;
    url?: string;
    key?: string;
  }>;
}

export interface PreparedProviderExecutionContext<
  TModel extends ProviderModelDescriptor,
> {
  aiModel: string;
  modelInfo: TModel;
  maxTokens: number;
  temperature: number;
  useStreaming: boolean;
  continue: boolean;
  biasString: [string, number][];
  multiGen: boolean;
  extractJson?: string;
  customURL?: string;
  key?: string;
  pluginBlocked: boolean;
}
("use strict");

function resolveRequestModel(
  request: ProviderRequestContextInput,
  settings: ProviderExecutionSettings,
): string;
function resolveRequestModel(request?: any, settings?: any): any {
  let aiModel: any =
    request.staticModel ||
    (request.mode === "model" ? settings.primaryModel : settings.subModel);
  if (settings.separateModelsForAxModels && !request.staticModel) {
    const separateModel: any = settings.separateModels?.[request.mode];
    if (separateModel) aiModel = separateModel;
  }
  return aiModel;
}

function prepareProviderExecutionContext<
  TModel extends ProviderModelDescriptor,
>(
  request: ProviderRequestContextInput,
  settings: ProviderExecutionSettings,
  resolveModelInfo: (id: string) => TModel,
): PreparedProviderExecutionContext<TModel>;
function prepareProviderExecutionContext(
  request?: any,
  settings?: any,
  resolveModelInfo?: any,
): any {
  const aiModel: any = resolveRequestModel(request, settings);
  const modelInfo: any = { ...resolveModelInfo(aiModel) };
  let customURL: any;
  let key: any;

  if (aiModel === "reverse_proxy") {
    modelInfo.internalID = settings.reverseProxy?.requestModel || "";
    modelInfo.format = settings.reverseProxy?.format ?? modelInfo.format;
    customURL = settings.reverseProxy?.url;
    key = settings.reverseProxy?.key;
  } else if (aiModel.startsWith("xcustom:::")) {
    const customModel: any = settings.customModels?.find(
      (item?: any) => item.id === aiModel,
    );
    customURL = customModel?.url;
    key = customModel?.key;
  }

  return {
    aiModel,
    modelInfo,
    maxTokens: request.maxTokens ?? settings.maxResponseTokens,
    temperature: request.temperature ?? settings.temperaturePercent / 100,
    useStreaming: request.forceStreaming
      ? true
      : Boolean(settings.useStreaming && request.useStreaming),
    continue: request.continue ?? false,
    biasString: request.biasString ?? [],
    multiGen:
      settings.genTime > 1 &&
      aiModel.startsWith("gpt") &&
      !request.continue &&
      !request.noMultiGen,
    extractJson: request.extractJson ?? settings.extractJson,
    customURL,
    key,
    pluginBlocked: Boolean(
      request.blockPlugins && modelInfo.id?.startsWith("pluginmodel:::"),
    ),
  };
}

export { resolveRequestModel, prepareProviderExecutionContext };
