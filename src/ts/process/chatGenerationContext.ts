import type { FormatingOrderItem } from "../storage/database.svelte";
import type { PromptItem, PromptSettings } from "./prompt";

/**
 * Request-local prompt/session overrides. These values must never be copied
 * into settingsStore; BTW generations can run concurrently with the main chat.
 */
export interface ChatGenerationOverrides {
  promptTemplate?: PromptItem[] | null;
  promptSettings?: PromptSettings;
  mainPrompt?: string;
  jailbreak?: string;
  globalNote?: string;
  formatingOrder?: FormatingOrderItem[];
  promptPreprocess?: boolean;
  jailbreakToggle?: boolean;
  moduleIds?: string[];
  chatVariables?: Record<string, string>;
  suppressTriggers?: boolean;
  skipMemory?: boolean;
  pluginsEnabled?: boolean;
}

export function generationOverride<T, K extends keyof ChatGenerationOverrides>(
  overrides: ChatGenerationOverrides | undefined,
  key: K,
  fallback: T,
): T {
  if (!overrides || !(key in overrides)) return fallback;
  const value = overrides[key];
  return (value === undefined ? fallback : value) as T;
}
