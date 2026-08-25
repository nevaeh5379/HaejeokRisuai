import type { OpenAIChat } from "../chat-core/types.cjs";
import type { TokenizerEncoding } from "./compute.cjs";

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

export function normalizeChatPlanRequest(input: unknown):
  | { value: NodeChatPlanRequest }
  | { error: string };
