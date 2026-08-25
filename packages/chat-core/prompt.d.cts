import type { OpenAIChat, PromptSections } from "./types.cjs";

export interface DepthPromptInput {
  role: OpenAIChat["role"];
  prompt: string;
  pos: string;
  depth: number;
}

export interface TriggerPromptInput {
  additonalSysPrompt?: {
    promptend?: string;
    historyend?: string;
    start?: string;
  };
}

export function applyMemoryPromptPolicy(
  chats: OpenAIChat[],
  sections: PromptSections,
  hasPromptTemplate: boolean,
  memoryCardUsed: boolean,
): OpenAIChat[];

export function insertDepthPrompts(
  sections: PromptSections,
  depthPrompts: readonly DepthPromptInput[],
  renderPrompt: (prompt: string) => string,
): void;

export function applyTriggerPromptPolicy(
  sections: PromptSections,
  triggerResult?: TriggerPromptInput | null,
): void;

export function buildPromptBiases(
  biases: readonly (readonly [string, number])[],
  renderBias: (text: string) => string,
): [string, number][];
