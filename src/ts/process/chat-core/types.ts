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

export type ChatModelResponse =
  | {
      type: "success" | "fail";
      result: string;
      noRetry?: boolean;
      special?: { emotion?: string };
      failByServerError?: boolean;
      model?: string;
    }
  | {
      type: "streaming";
      result: ReadableStream<ChatStreamChunk>;
      special?: { emotion?: string };
      model?: string;
    }
  | {
      type: "multiline";
      result: ["user" | "char", string][];
      special?: { emotion?: string };
      model?: string;
    };

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

