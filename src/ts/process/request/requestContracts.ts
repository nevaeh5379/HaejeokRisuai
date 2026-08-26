import type { LLMModel } from "../../model/modellist";
import type { character } from "../../storage/database.svelte";
import type {
  ChatModelResponse,
  ChatStreamChunk,
  OpenAIChat,
} from "@risuai/chat-core/types.cjs";
import type { MCPTool } from "../mcp/mcplib";
import type { ModelModeExtended } from "./shared";

export type ToolCall = {
  name: string;
  arguments: string;
};

export interface requestDataArgument {
  formated: OpenAIChat[];
  bias: { [key: number]: number };
  biasString?: [string, number][];
  currentChar?: character;
  temperature?: number;
  maxTokens?: number;
  PresensePenalty?: number;
  frequencyPenalty?: number;
  useStreaming?: boolean;
  forceStreaming?: boolean;
  isGroupChat?: boolean;
  useEmotion?: boolean;
  continue?: boolean;
  chatId?: string;
  noMultiGen?: boolean;
  schema?: string;
  extractJson?: string;
  imageResponse?: boolean;
  previewBody?: boolean;
  staticModel?: string;
  escape?: boolean;
  tools?: MCPTool[];
  rememberToolUsage?: boolean;
  blockPlugins?: boolean;
}

export interface RequestDataArgumentExtended extends requestDataArgument {
  aiModel?: string;
  multiGen?: boolean;
  abortSignal?: AbortSignal;
  modelInfo?: LLMModel;
  customURL?: string;
  mode?: ModelModeExtended;
  key?: string;
  additionalOutput?: string;
  saveSignatures?: boolean;
}

export type requestDataResponse = ChatModelResponse;
export type StreamResponseChunk = ChatStreamChunk;
