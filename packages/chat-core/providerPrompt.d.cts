import type { OpenAIChat } from "./types.cjs";
import type { LLMFlagValue } from "../protocol/modelFlags.cjs";

export interface ProviderPromptFormatOptions {
  systemContentReplacement?: string;
  systemRoleReplacement?: string;
}

export function formatProviderMessages(
  formated: OpenAIChat[],
  flags: readonly LLMFlagValue[],
  options?: ProviderPromptFormatOptions,
): OpenAIChat[];
