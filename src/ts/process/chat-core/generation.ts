import type { OpenAIChat } from "./types";

export interface ChatGenerationPlanInput {
  formated: OpenAIChat[];
  maxContextTokens: number;
}

export interface ChatGenerationSettings {
  maxResponseTokens: number;
  imageResponse?: boolean;
  rememberToolUsage?: boolean;
}

export interface ChatGenerationRuntime<TCharacter, TResponse extends { model?: string }> {
  tokenizeChatsDetailed(chats: OpenAIChat[]): Promise<number[]>;
  getGenerationSettings(): ChatGenerationSettings;
  createGenerationId(): string;
  getGenerationModel(model?: string): string;
  requestModel(
    request: ChatModelRequest<TCharacter>,
    signal: AbortSignal,
  ): Promise<TResponse>;
  registerGenerationContext?(context: ChatGenerationContext): void;
  unregisterGenerationContext?(generationId: string): void;
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

export type ChatGenerationPlan =
  | {
      ok: true;
      formated: OpenAIChat[];
      inputTokens: number;
      outputTokens: number;
      generationId: string;
      generationModel: string;
    }
  | {
      ok: false;
      requiredTokens: number;
    };

function hasRenderableContent(chat: OpenAIChat): boolean {
  return chat.content !== "" || Boolean(chat.multimodals?.length);
}

export async function createChatGenerationPlan<
  TCharacter,
  TResponse extends { model?: string },
>(
  runtime: ChatGenerationRuntime<TCharacter, TResponse>,
  input: ChatGenerationPlanInput,
): Promise<ChatGenerationPlan> {
  const formated = input.formated.map((chat) => ({ ...chat }));
  const tokenCounts = await runtime.tokenizeChatsDetailed(formated);
  let inputTokens = tokenCounts.reduce((total, count) => total + count, 0);

  if (inputTokens > input.maxContextTokens) {
    let pointer = 0;
    while (inputTokens > input.maxContextTokens && pointer < formated.length) {
      if (formated[pointer].removable) {
        inputTokens -= tokenCounts[pointer];
        formated[pointer].content = "";
      }
      pointer++;
    }
    if (inputTokens > input.maxContextTokens) {
      return { ok: false, requiredTokens: inputTokens };
    }
  }

  const compacted = formated.filter(hasRenderableContent);
  const settings = runtime.getGenerationSettings();
  const outputTokens = Math.min(
    settings.maxResponseTokens,
    Math.max(0, input.maxContextTokens - inputTokens),
  );

  return {
    ok: true,
    formated: compacted,
    inputTokens,
    outputTokens,
    generationId: runtime.createGenerationId(),
    generationModel: runtime.getGenerationModel(),
  };
}

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

export async function executeChatModelRequest<
  TCharacter,
  TResponse extends { model?: string },
>(
  runtime: ChatGenerationRuntime<TCharacter, TResponse>,
  input: ExecuteChatModelRequestInput<TCharacter>,
  signal: AbortSignal,
): Promise<TResponse> {
  const { plan } = input;
  const settings = runtime.getGenerationSettings();
  if (input.durableChatId) {
    runtime.registerGenerationContext?.({
      realChatId: input.durableChatId,
      generationId: plan.generationId,
      model: plan.generationModel,
      speakerId: input.speakerId,
    });
  }

  try {
    return await runtime.requestModel(
      {
        formated: plan.formated,
        biasString: input.biases,
        currentChar: input.currentChar,
        useStreaming: true,
        isGroupChat: input.isGroupChat,
        bias: {},
        continue: input.continueGeneration,
        chatId: plan.generationId,
        imageResponse: settings.imageResponse,
        previewBody: input.previewBody,
        escape: input.escape,
        rememberToolUsage: settings.rememberToolUsage,
      },
      signal,
    );
  } finally {
    runtime.unregisterGenerationContext?.(plan.generationId);
  }
}
