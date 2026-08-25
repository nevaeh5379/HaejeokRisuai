import type { OpenAIChat } from "./types.cjs";

export interface ChatGenerationPlanInput {
  formated: OpenAIChat[];
  maxContextTokens: number;
}

export interface ChatGenerationSettings {
  maxResponseTokens: number;
  imageResponse?: boolean;
  rememberToolUsage?: boolean;
}

export interface ChatGenerationContext {
  realChatId: string;
  generationId: string;
  model?: string;
  speakerId?: string;
}

export interface ChatModelRequest<TCharacter> {
  formated: OpenAIChat[];
  biasString?: [string, number][];
  currentChar?: TCharacter;
  useStreaming?: boolean;
  isGroupChat?: boolean;
  bias: Record<number, number>;
  continue?: boolean;
  chatId?: string;
  imageResponse?: boolean;
  previewBody?: boolean;
  escape?: boolean;
  rememberToolUsage?: boolean;
}

export interface ChatGenerationRuntime<TCharacter, TResponse extends { model?: string }> {
  tokenizeChatsDetailed(chats: OpenAIChat[]): Promise<number[]>;
  getGenerationSettings(): ChatGenerationSettings;
  createGenerationId(): string;
  getGenerationModel(model?: string): string;
  requestModel(request: ChatModelRequest<TCharacter>, signal: AbortSignal): Promise<TResponse>;
  registerGenerationContext?(context: ChatGenerationContext): void;
  unregisterGenerationContext?(generationId: string): void;
}

export type ChatGenerationPlan =
  | {
      ok: true;
      formated: OpenAIChat[];
      keptIndexes: number[];
      inputTokens: number;
      outputTokens: number;
      generationId: string;
      generationModel: string;
    }
  | {
      ok: false;
      requiredTokens: number;
    };

export interface ExecuteChatModelRequestInput<TCharacter> {
  plan: Extract<ChatGenerationPlan, { ok: true }>;
  biases: [string, number][];
  currentChar: TCharacter;
  isGroupChat: boolean;
  continueGeneration?: boolean;
  previewBody?: boolean;
  escape?: boolean;
  durableChatId?: string;
  speakerId?: string;
}

export function createChatGenerationPlan<TCharacter, TResponse extends { model?: string }>(
  runtime: ChatGenerationRuntime<TCharacter, TResponse>,
  input: ChatGenerationPlanInput,
): Promise<ChatGenerationPlan>;

export function executeChatModelRequest<TCharacter, TResponse extends { model?: string }>(
  runtime: ChatGenerationRuntime<TCharacter, TResponse>,
  input: ExecuteChatModelRequestInput<TCharacter>,
  signal: AbortSignal,
): Promise<TResponse>;
