import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  beginChatGeneration,
  chatProcessStages,
  endChatGeneration,
  getChatProcessStage,
  setChatProcessStage,
} from "./chatRuntimeState";

const chatIds = ["chat-a", "chat-b"];

afterEach(() => {
  for (const chatId of chatIds) endChatGeneration(chatId);
});

describe("chat process stages", () => {
  it("tracks concurrent chat stages independently", () => {
    expect(beginChatGeneration("chat-a")).toBe(true);
    expect(beginChatGeneration("chat-b")).toBe(true);

    setChatProcessStage("chat-a", 3);
    setChatProcessStage("chat-b", 1);

    const stages = get(chatProcessStages);
    expect(getChatProcessStage(stages, "chat-a")).toBe(3);
    expect(getChatProcessStage(stages, "chat-b")).toBe(1);
  });

  it("clears only the stage for the generation that ended", () => {
    expect(beginChatGeneration("chat-a")).toBe(true);
    expect(beginChatGeneration("chat-b")).toBe(true);
    setChatProcessStage("chat-a", 4);
    setChatProcessStage("chat-b", 2);

    endChatGeneration("chat-a");

    const stages = get(chatProcessStages);
    expect(stages.has("chat-a")).toBe(false);
    expect(getChatProcessStage(stages, "chat-b")).toBe(2);
  });
});