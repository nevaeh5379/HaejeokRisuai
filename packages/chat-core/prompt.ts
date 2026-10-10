import type { OpenAIChat, PromptSections } from "./types.ts";

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
("use strict");

function applyMemoryPromptPolicy(
  chats: OpenAIChat[],
  sections: PromptSections,
  hasPromptTemplate: boolean,
  memoryCardUsed: boolean,
): OpenAIChat[];
function applyMemoryPromptPolicy(
  chats?: any,
  sections?: any,
  hasPromptTemplate?: any,
  memoryCardUsed?: any,
): any {
  const memories: any = [];
  if (!hasPromptTemplate && chats.length > 0) {
    sections.lastChat.push(chats[chats.length - 1]);
    chats.splice(chats.length - 1, 1);
  }

  sections.chats = chats
    .map((chat?: any) => {
      if (chat.memo !== "supaMemory" && chat.memo !== "hypaMemory") {
        chat.removable = true;
      } else if (memoryCardUsed) {
        memories.push(chat);
        return { role: "system", content: "" };
      } else {
        chat.content = `<Previous Conversation>${chat.content}</Previous Conversation>`;
      }
      return chat;
    })
    .filter(
      (chat?: any) =>
        chat.content.trim() !== "" || Boolean(chat.multimodals?.length),
    );

  return memories;
}

function insertDepthPrompts(
  sections: PromptSections,
  depthPrompts: readonly DepthPromptInput[],
  renderPrompt: (prompt: string) => string,
): void;
function insertDepthPrompts(
  sections?: any,
  depthPrompts?: any,
  renderPrompt?: any,
): any {
  for (const depthPrompt of depthPrompts) {
    const chat: any = {
      role: depthPrompt.role,
      content: renderPrompt(depthPrompt.prompt),
    };
    const depth: any =
      depthPrompt.pos === "depth"
        ? depthPrompt.depth
        : sections.chats.length - depthPrompt.depth;
    sections.chats.splice(depth, 0, chat);
  }
}

function applyTriggerPromptPolicy(
  sections: PromptSections,
  triggerResult?: TriggerPromptInput | null,
): void;
function applyTriggerPromptPolicy(sections?: any, triggerResult?: any): any {
  const prompts: any = triggerResult?.additonalSysPrompt;
  if (!prompts) return;
  if (prompts.promptend) {
    sections.postEverything.push({
      role: "system",
      content: prompts.promptend,
    });
  }
  if (prompts.historyend) {
    sections.lastChat.push({ role: "system", content: prompts.historyend });
  }
  if (prompts.start) {
    sections.lastChat.unshift({ role: "system", content: prompts.start });
  }
}

function buildPromptBiases(
  biases: readonly (readonly [string, number])[],
  renderBias: (text: string) => string,
): [string, number][];
function buildPromptBiases(biases?: any, renderBias?: any): any {
  return biases.map(([text, weight]: any) => [
    renderBias(
      text
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\\\", "\\"),
    ),
    weight,
  ]);
}

export {
  applyMemoryPromptPolicy,
  insertDepthPrompts,
  applyTriggerPromptPolicy,
  buildPromptBiases,
};
