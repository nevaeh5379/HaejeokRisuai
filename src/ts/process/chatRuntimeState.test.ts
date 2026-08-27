import { afterEach, describe, expect, it } from "vitest";
import { get } from "svelte/store";
import {
  beginChatGeneration,
  chatProcessStages,
  endChatGeneration,
  getChatProcessStage,
  setChatProcessStage,
  setRemoteChatGeneration,
  activeGenerationChatIds,
} from "./chatRuntimeState";

const chatIds = ["chat-a", "chat-b"];

afterEach(() => {
  for (const chatId of chatIds) {
    endChatGeneration(chatId);
    setRemoteChatGeneration(chatId, false, "lifecycle:test");
    setRemoteChatGeneration(chatId, false, "model-job:test");
  }
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

  it("keeps a remote chat active until every lifecycle source ends", () => {
    setRemoteChatGeneration("chat-a", true, "lifecycle:test");
    setRemoteChatGeneration("chat-a", true, "model-job:test");
    setRemoteChatGeneration("chat-a", false, "model-job:test");

    expect(get(activeGenerationChatIds).has("chat-a")).toBe(true);

    setRemoteChatGeneration("chat-a", false, "lifecycle:test");
    expect(get(activeGenerationChatIds).has("chat-a")).toBe(false);
  });
});