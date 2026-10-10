import type { OpenAIChat } from "./types.ts";

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
  triggerTarget?: { characterId: string; chatId: string };
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

export interface ChatGenerationRuntime<
  TCharacter,
  TResponse extends { model?: string },
> {
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
  triggerTarget?: { characterId: string; chatId: string };
  currentChar: TCharacter;
  isGroupChat: boolean;
  continueGeneration?: boolean;
  previewBody?: boolean;
  escape?: boolean;
  durableChatId?: string;
  speakerId?: string;
}
("use strict");

function hasRenderableContent(chat?: any): any {
  return chat.content !== "" || Boolean(chat.multimodals?.length);
}

function createChatGenerationPlan<
  TCharacter,
  TResponse extends { model?: string },
>(
  runtime: ChatGenerationRuntime<TCharacter, TResponse>,
  input: ChatGenerationPlanInput,
): Promise<ChatGenerationPlan>;
async function createChatGenerationPlan(
  runtime?: any,
  input?: any,
): Promise<any> {
  const formated: any = input.formated.map((chat?: any) => ({ ...chat }));
  const tokenCounts: any = await runtime.tokenizeChatsDetailed(formated);
  let inputTokens: any = tokenCounts.reduce(
    (total?: any, count?: any) => total + count,
    0,
  );

  if (inputTokens > input.maxContextTokens) {
    let pointer: any = 0;
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

  const compactedEntries: any = formated
    .map((chat?: any, index?: any) => ({ chat, index }))
    .filter(({ chat }: any) => hasRenderableContent(chat));
  const compacted: any = compactedEntries.map(({ chat }: any) => chat);
  const keptIndexes: any = compactedEntries.map(({ index }: any) => index);
  const settings: any = runtime.getGenerationSettings();
  const outputTokens: any = Math.min(
    settings.maxResponseTokens,
    Math.max(0, input.maxContextTokens - inputTokens),
  );

  return {
    ok: true,
    formated: compacted,
    keptIndexes,
    inputTokens,
    outputTokens,
    generationId: runtime.createGenerationId(),
    generationModel: runtime.getGenerationModel(),
  };
}

function executeChatModelRequest<
  TCharacter,
  TResponse extends { model?: string },
>(
  runtime: ChatGenerationRuntime<TCharacter, TResponse>,
  input: ExecuteChatModelRequestInput<TCharacter>,
  signal: AbortSignal,
): Promise<TResponse>;
async function executeChatModelRequest(
  runtime?: any,
  input?: any,
  signal?: any,
): Promise<any> {
  const { plan } = input;
  const settings: any = runtime.getGenerationSettings();
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
        triggerTarget: input.triggerTarget,
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

export { createChatGenerationPlan, executeChatModelRequest };
