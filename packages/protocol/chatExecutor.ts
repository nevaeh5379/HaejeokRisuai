import type { OpenAIChat } from "../chat-core/types.ts";

import type { TokenizerEncoding } from "./compute.ts";

export interface NodeChatPlanRequest {
  formated: OpenAIChat[];
  maxContextTokens: number;
  maxResponseTokens: number;
  chatAdditionalTokens: number;
  encoding: TokenizerEncoding;
  useName?: boolean;
  countThoughts?: boolean;
  supportsInlayImage?: boolean;
  visionQuality?: string;
  model?: string;
}

export type NodeChatGenerationPlan =
  | {
      ok: true;
      keptIndexes: number[];
      inputTokens: number;
      outputTokens: number;
      generationId: string;
      generationModel: string;
    }
  | { ok: false; requiredTokens: number };

export interface NodeChatContinuationRequest {
  result: string;
  encoding: TokenizerEncoding;
  usedContinueTokens: number;
  minimumTokens: number;
  continueIncomplete: boolean;
}

export interface NodeChatContinuationDecision {
  shouldContinue: boolean;
  resultTokens: number;
  reason: "minimum-tokens" | "incomplete" | null;
}
("use strict");

import { TOKENIZER_ENCODINGS } from "./compute.ts";
const VALID_ENCODINGS: any = new Set(TOKENIZER_ENCODINGS);
const VALID_ROLES: any = new Set(["system", "user", "assistant", "function"]);

function finiteInteger(
  value?: any,
  name?: any,
  { min = 0, max = Number.MAX_SAFE_INTEGER }: any = {},
): any {
  if (!Number.isInteger(value) || value < min || value > max) {
    return { error: `${name} must be an integer from ${min} to ${max}` };
  }
  return { value };
}

function normalizeChatMessage(message?: any, index?: any): any {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { error: `formated[${index}] must be an object` };
  }
  if (!VALID_ROLES.has(message.role) || typeof message.content !== "string") {
    return { error: `formated[${index}] has an invalid role or content` };
  }
  if (message.name != null && typeof message.name !== "string") {
    return { error: `formated[${index}].name must be a string` };
  }
  if (
    message.thoughts != null &&
    (!Array.isArray(message.thoughts) ||
      message.thoughts.some((v?: any) => typeof v !== "string"))
  ) {
    return { error: `formated[${index}].thoughts must be an array of strings` };
  }
  if (message.multimodals != null && !Array.isArray(message.multimodals)) {
    return { error: `formated[${index}].multimodals must be an array` };
  }
  return { value: message };
}

function normalizeChatPlanRequest(
  input: unknown,
): { value: NodeChatPlanRequest } | { error: string };
function normalizeChatPlanRequest(input?: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { error: "Request body must be an object" };
  if (!Array.isArray(input.formated))
    return { error: "formated must be an array" };
  if (input.formated.length > 4096)
    return { error: "formated may contain at most 4096 messages" };

  const messages: any = [];
  for (let index: any = 0; index < input.formated.length; index++) {
    const normalized: any = normalizeChatMessage(input.formated[index], index);
    if (normalized.error) return normalized;
    messages.push(normalized.value);
  }

  const maxContext: any = finiteInteger(
    input.maxContextTokens,
    "maxContextTokens",
    {
      min: 1,
      max: 10_000_000,
    },
  );
  if (maxContext.error) return maxContext;
  const maxResponse: any = finiteInteger(
    input.maxResponseTokens,
    "maxResponseTokens",
    { min: 0, max: 10_000_000 },
  );
  if (maxResponse.error) return maxResponse;
  const additional: any = finiteInteger(
    input.chatAdditionalTokens,
    "chatAdditionalTokens",
    { min: 0, max: 1024 },
  );
  if (additional.error) return additional;
  if (!VALID_ENCODINGS.has(input.encoding))
    return { error: "encoding is not supported" };

  return {
    value: {
      formated: messages,
      maxContextTokens: maxContext.value,
      maxResponseTokens: maxResponse.value,
      chatAdditionalTokens: additional.value,
      encoding: input.encoding,
      useName: input.useName === true,
      countThoughts: input.countThoughts === true,
      supportsInlayImage: input.supportsInlayImage === true,
      visionQuality:
        typeof input.visionQuality === "string" ? input.visionQuality : "high",
      model: typeof input.model === "string" ? input.model.slice(0, 512) : "",
    },
  };
}

function normalizeChatContinuationRequest(
  input: unknown,
): { value: NodeChatContinuationRequest } | { error: string };
function normalizeChatContinuationRequest(input?: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return { error: "Request body must be an object" };
  if (typeof input.result !== "string")
    return { error: "result must be a string" };
  if (!VALID_ENCODINGS.has(input.encoding))
    return { error: "encoding is not supported" };
  const used: any = finiteInteger(
    input.usedContinueTokens,
    "usedContinueTokens",
    {
      min: 0,
      max: 10_000_000,
    },
  );
  if (used.error) return used;
  const minimum: any = finiteInteger(input.minimumTokens, "minimumTokens", {
    min: 0,
    max: 10_000_000,
  });
  if (minimum.error) return minimum;
  return {
    value: {
      result: input.result,
      encoding: input.encoding,
      usedContinueTokens: used.value,
      minimumTokens: minimum.value,
      continueIncomplete: input.continueIncomplete === true,
    },
  };
}

export { normalizeChatPlanRequest, normalizeChatContinuationRequest };
