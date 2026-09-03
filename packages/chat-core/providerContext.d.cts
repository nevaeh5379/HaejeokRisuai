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

export function resolveRequestModel(
  request: ProviderRequestContextInput,
  settings: ProviderExecutionSettings,
): string;

export function prepareProviderExecutionContext<
  TModel extends ProviderModelDescriptor,
>(
  request: ProviderRequestContextInput,
  settings: ProviderExecutionSettings,
  resolveModelInfo: (id: string) => TModel,
): PreparedProviderExecutionContext<TModel>;
