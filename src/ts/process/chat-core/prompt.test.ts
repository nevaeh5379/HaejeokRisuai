import { describe, expect, it } from "vitest";
import {
  applyMemoryPromptPolicy,
  applyTriggerPromptPolicy,
  buildPromptBiases,
  insertDepthPrompts,
} from "./prompt";
import type { OpenAIChat, PromptSections } from "./types";

function sections(): PromptSections {
  return {
    main: [], jailbreak: [], chats: [], lorebook: [], globalNote: [],
    authorNote: [], lastChat: [], description: [], postEverything: [], personaPrompt: [],
  };
}

const chat = (content: string, memo?: string): OpenAIChat => ({
  role: "user",
  content,
  memo,
});

describe("prompt core policies", () => {
  it("moves the last history item outside chats when no prompt template is active", () => {
    const target = sections();
    const chats = [chat("older"), chat("latest")];
    applyMemoryPromptPolicy(chats, target, false, false);
    expect(target.lastChat.map((item) => item.content)).toEqual(["latest"]);
    expect(target.chats.map((item) => item.content)).toEqual(["older"]);
    expect(target.chats[0].removable).toBe(true);
  });

  it("extracts memory cards when the template consumes them", () => {
    const target = sections();
    const memory = chat("summary", "supaMemory");
    const memories = applyMemoryPromptPolicy([memory], target, true, true);
    expect(memories).toEqual([memory]);
    expect(target.chats).toEqual([]);
  });

  it("inserts depth and relative-depth prompts at their intended locations", () => {
    const target = sections();
    target.chats = [chat("a"), chat("b"), chat("c")];
    insertDepthPrompts(target, [
      { role: "system", prompt: "direct", pos: "depth", depth: 1 },
      { role: "system", prompt: "relative", pos: "after", depth: 1 },
    ], (value) => `rendered:${value}`);
    expect(target.chats.map((item) => item.content)).toEqual([
      "a", "rendered:direct", "b", "rendered:relative", "c",
    ]);
  });

  it("places trigger prompts at the correct prompt boundaries", () => {
    const target = sections();
    target.lastChat.push(chat("history"));
    applyTriggerPromptPolicy(target, {
      additonalSysPrompt: { start: "start", historyend: "end", promptend: "post" },
    });
    expect(target.lastChat.map((item) => item.content)).toEqual(["start", "history", "end"]);
    expect(target.postEverything.map((item) => item.content)).toEqual(["post"]);
  });

  it("normalizes escaped bias text before rendering", () => {
    expect(buildPromptBiases([["a\\nb\\\\c\\rd", 2]], (value) => `[${value}]`)).toEqual([
      ["[a\nb\\c\rd]", 2],
    ]);
  });
});
