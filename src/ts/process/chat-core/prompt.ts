import type { OpenAIChat, PromptSections } from "./types";

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
): OpenAIChat[] {
  const memories: OpenAIChat[] = [];
  if (!hasPromptTemplate && chats.length > 0) {
    sections.lastChat.push(chats[chats.length - 1]);
    chats.splice(chats.length - 1, 1);
  }

  sections.chats = chats
    .map((chat) => {
      if (chat.memo !== "supaMemory" && chat.memo !== "hypaMemory") {
        chat.removable = true;
      } else if (memoryCardUsed) {
        memories.push(chat);
        return { role: "system", content: "" } as OpenAIChat;
      } else {
        chat.content = `<Previous Conversation>${chat.content}</Previous Conversation>`;
      }
      return chat;
    })
    .filter((chat) => chat.content.trim() !== "" || Boolean(chat.multimodals?.length));

  return memories;
}

export function insertDepthPrompts(
  sections: PromptSections,
  depthPrompts: readonly DepthPromptInput[],
  renderPrompt: (prompt: string) => string,
): void {
  for (const depthPrompt of depthPrompts) {
    const chat: OpenAIChat = {
      role: depthPrompt.role,
      content: renderPrompt(depthPrompt.prompt),
    };
    const depth =
      depthPrompt.pos === "depth"
        ? depthPrompt.depth
        : sections.chats.length - depthPrompt.depth;
    sections.chats.splice(depth, 0, chat);
  }
}

export function applyTriggerPromptPolicy(
  sections: PromptSections,
  triggerResult?: TriggerPromptInput | null,
): void {
  const prompts = triggerResult?.additonalSysPrompt;
  if (!prompts) return;
  if (prompts.promptend) {
    sections.postEverything.push({ role: "system", content: prompts.promptend });
  }
  if (prompts.historyend) {
    sections.lastChat.push({ role: "system", content: prompts.historyend });
  }
  if (prompts.start) {
    sections.lastChat.unshift({ role: "system", content: prompts.start });
  }
}

export function buildPromptBiases(
  biases: readonly (readonly [string, number])[],
  renderBias: (text: string) => string,
): [string, number][] {
  return biases.map(([text, weight]) => [
    renderBias(
      text
        .replaceAll("\\n", "\n")
        .replaceAll("\\r", "\r")
        .replaceAll("\\\\", "\\"),
    ),
    weight,
  ]);
}
