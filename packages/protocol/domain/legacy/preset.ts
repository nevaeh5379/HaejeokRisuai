import type { NAISettings } from "../naiSettings.ts";
import type { PromptItem, PromptSettings } from "../promptTypes.ts";
import type { OobaChatCompletionRequestParams } from "../ooba.ts";
import type { LLMFlagValue as LLMFlags } from "../../modelFlags.ts";
import type { LLMFormatValue as LLMFormat } from "../../modelFormat.ts";
import type {
  FormatingOrderItem,
  OobaSettings,
  AINsettings,
  SeparateParameters,
  DynamicOutput,
} from "./database.ts";
import type { customscript } from "./script.ts";
/** Upstream compatibility declarations, kwaroran/Risuai@39f1ac1472d0ef6907ee933c4cf25182ee2aec9f. */
export interface botPreset {
  name?: string;
  apiType?: string;
  openAIKey?: string;
  localNetworkMode?: boolean;
  localNetworkTimeoutSec?: number;
  mainPrompt: string;
  jailbreak: string;
  globalNote: string;
  temperature: number;
  maxContext: number;
  maxResponse: number;
  frequencyPenalty: number;
  PresensePenalty: number;
  formatingOrder: FormatingOrderItem[];
  aiModel?: string;
  subModel?: string;
  currentPluginProvider?: string;
  textgenWebUIStreamURL?: string;
  textgenWebUIBlockingURL?: string;
  forceReplaceUrl?: string;
  forceReplaceUrl2?: string;
  promptPreprocess: boolean;
  bias: [string, number][];
  proxyRequestModel?: string;
  openrouterRequestModel?: string;
  proxyKey?: string;
  ooba: OobaSettings;
  ainconfig: AINsettings;
  koboldURL?: string;
  NAISettings?: NAISettings;
  autoSuggestPrompt?: string;
  autoSuggestPrefix?: string;
  autoSuggestClean?: boolean;
  promptTemplate?: PromptItem[];
  NAIadventure?: boolean;
  NAIappendName?: boolean;
  localStopStrings?: string[];
  customProxyRequestModel?: string;
  reverseProxyOobaArgs?: OobaChatCompletionRequestParams;
  top_p?: number;
  promptSettings?: PromptSettings;
  repetition_penalty?: number;
  min_p?: number;
  top_a?: number;
  openrouterProvider?: {
    order: string[];
    only: string[];
    ignore: string[];
  };
  useInstructPrompt?: boolean;
  customPromptTemplateToggle?: string;
  templateDefaultVariables?: string;
  moduleIntergration?: string;
  top_k?: number;
  instructChatTemplate?: string;
  JinjaTemplate?: string;
  jsonSchemaEnabled?: boolean;
  jsonSchema?: string;
  strictJsonSchema?: boolean;
  extractJson?: string;
  groupTemplate?: string;
  groupOtherBotRole?: string;
  seperateParametersEnabled?: boolean;
  seperateParameters?: {
    memory: SeparateParameters;
    emotion: SeparateParameters;
    translate: SeparateParameters;
    otherAx: SeparateParameters;
    overrides: Record<string, SeparateParameters>;
  };
  customAPIFormat?: LLMFormat;
  systemContentReplacement?: string;
  systemRoleReplacement?: "user" | "assistant";
  enableCustomFlags?: boolean;
  customFlags?: LLMFlags[];
  image?: string;
  regex?: customscript[];
  reasonEffort?: number;
  thinkingTokens?: number;
  thinkingType?: "off" | "budget" | "adaptive";
  deepseekThinkingType?: "off" | "enabled";
  adaptiveThinkingEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  deepseekReasoningEffort?: "high" | "max";
  outputImageModal?: boolean;
  seperateModelsForAxModels?: boolean;
  seperateModels?: {
    memory: string;
    emotion: string;
    translate: string;
    otherAx: string;
  };
  modelTools?: string[];
  fallbackModels?: {
    memory: string[];
    emotion: string[];
    translate: string[];
    otherAx: string[];
    model: string[];
  };
  fallbackWhenBlankResponse?: boolean;
  verbosity?: number;
  dynamicOutput?: DynamicOutput;
}
