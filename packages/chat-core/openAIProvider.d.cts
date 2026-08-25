export const DEFAULT_OPENAI_CHAT_COMPLETIONS_URL: "https://api.openai.com/v1/chat/completions";
export const DEFAULT_OPENAI_RESPONSES_URL: "https://api.openai.com/v1/responses";
export const DEFAULT_OPENAI_COMPLETIONS_URL: "https://api.openai.com/v1/completions";

export interface OpenAIToolCallLike {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  [key: string]: unknown;
}

export function collectOpenAIToolCalls(data: unknown): OpenAIToolCallLike[];

export function appendOpenAIStreamingFragment(
  current: string,
  incoming?: string,
): string;

export interface OpenAIStreamingToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export function mergeOpenAIStreamingToolCallDeltas(
  current: Record<number, OpenAIToolCallLike>,
  deltas?: OpenAIStreamingToolCallDelta[],
): Record<number, OpenAIToolCallLike>;

export function formatOpenAIReasoningText(
  data: unknown,
  options?: { deepSeekThinkingOutput?: boolean },
): string;

export const OPENAI_MODEL_ALIASES: Readonly<Record<string, string>>;

export function normalizeOpenAIProviderMessages<T extends Record<string, any>>(
  messages: T[],
  options?: {
    newOAIHandle?: boolean;
    deepSeekPrefix?: boolean;
    deepSeekThinkingInput?: boolean;
    reverseProxyOobaMode?: boolean;
    developerRole?: boolean;
  },
): T[];

export function resolveOpenAIRequestModel(options?: {
  aiModel?: string;
  requestModel?: string;
  openRouterRequestModel?: string;
  nanoGPTRequestModel?: string;
  internalID?: string;
}): string | undefined;

export function shouldUseOpenAIFlexProcessing(options?: {
  aiModel?: string;
  url?: string;
  isOpenAIProvider?: boolean;
}): boolean;

export function resolveOpenAIRequestEndpoint(options?: {
  aiModel?: string;
  customURL?: string;
  modelEndpoint?: string;
  nanoGPTUseSubscriptionEndpoint?: boolean;
  autofillRequestUrl?: boolean;
}): { url: string; risuIdentify: boolean };

export function buildOpenAIRequestHeaders(options?: {
  aiModel?: string;
  key?: string;
  openAIKey?: string;
  nanoGPTKey?: string;
  proxyKey?: string;
  openRouterKey?: string;
  keyIdentifier?: string;
  keyByIdentifier?: Record<string, string>;
  nanoGPTProvider?: string;
  risuIdentify?: boolean;
}): Record<string, string>;

export function applyOpenAIPreParameterBodyPolicies<T extends Record<string, any>>(
  body: T,
  options?: {
    useCompletionTokens?: boolean;
    generationSeed?: number;
    responseJsonSchema?: unknown;
    prediction?: string;
    aiModel?: string;
    openRouterFallback?: boolean;
    openRouterMiddleOut?: boolean;
    openRouterProvider?: {
      order?: string[];
      only?: string[];
      ignore?: string[];
    };
    instructPrompt?: string;
  },
): T;

export function applyOpenAIPostParameterBodyPolicies<T extends Record<string, any>>(
  body: T,
  options?: {
    deepSeekThinkingToggle?: boolean;
    deepSeekThinkingType?: string;
    deepSeekReasoningEffort?: string;
    toolDefinitions?: unknown[];
    reverseProxyOobaMode?: boolean;
    reverseProxyOobaArgs?: object;
    removeLogitBiasForInlay?: boolean;
    multiGen?: boolean;
    hasTools?: boolean;
    genTime?: number;
  },
): { body: T; error: string | null };
