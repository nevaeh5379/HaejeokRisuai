export interface MultiModal {
  type: "image" | "video" | "audio" | "signature";
  base64: string;
  height?: number;
  width?: number;
}

export interface OpenAIChat {
  role: "system" | "user" | "assistant" | "function";
  content: string;
  memo?: string;
  name?: string;
  removable?: boolean;
  attr?: string[];
  multimodals?: MultiModal[];
  thoughts?: string[];
  cachePoint?: boolean;
}

export interface ChatStreamChunk {
  [key: string]: string;
}

export interface ChatSuccessResponse {
  type: "success";
  result: string;
  noRetry?: boolean;
  special?: { emotion?: string };
  model?: string;
}

export interface ChatFailureResponse {
  type: "fail";
  result: string;
  noRetry?: boolean;
  special?: { emotion?: string };
  failByServerError?: boolean;
  model?: string;
}

export interface ChatStreamingResponse {
  type: "streaming";
  result: ReadableStream<ChatStreamChunk>;
  special?: { emotion?: string };
  model?: string;
}

export interface ChatMultilineResponse {
  type: "multiline";
  result: ["user" | "char", string][];
  special?: { emotion?: string };
  model?: string;
}

export type ChatModelResponse =
  | ChatSuccessResponse
  | ChatFailureResponse
  | ChatStreamingResponse
  | ChatMultilineResponse;

export interface ChatStageTimings {
  stage1Start: number;
  stage2Start: number;
  stage3Start: number;
  stage4Start: number;
  stage1Duration: number;
  stage2Duration: number;
  stage3Duration: number;
  stage4Duration: number;
}

export interface PromptSections {
  main: OpenAIChat[];
  jailbreak: OpenAIChat[];
  chats: OpenAIChat[];
  lorebook: OpenAIChat[];
  globalNote: OpenAIChat[];
  authorNote: OpenAIChat[];
  lastChat: OpenAIChat[];
  description: OpenAIChat[];
  postEverything: OpenAIChat[];
  personaPrompt: OpenAIChat[];
}
