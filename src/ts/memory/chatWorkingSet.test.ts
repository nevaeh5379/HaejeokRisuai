// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { chatTabsStore, type ChatTab } from "../chatTabs.svelte";
import { activeGenerationChatIds } from "../process/chatRuntimeState";
import { getProtectedChatIds } from "./chatWorkingSet";

function makeTab(id: string, groupId: string, chatId: string): ChatTab {
  return {
    id,
    groupId,
    characterId: `character-${id}`,
    chatId,
    unread: false,
    draft: "",
    translatedDraft: "",
    fileInput: [],
  };
}

describe("getProtectedChatIds", () => {
  beforeEach(() => {
    chatTabsStore.groups = [
      { id: "left", activeTabId: "left-active" },
      { id: "right", activeTabId: "right-active" },
    ];
    chatTabsStore.focusedGroupId = "left";
    chatTabsStore.tabs = [
      makeTab("left-active", "left", "chat-left"),
      makeTab("left-hidden", "left", "chat-hidden"),
      makeTab("right-active", "right", "chat-right"),
    ];
    activeGenerationChatIds.set(new Set());
  });

  it("combines visible split panes, generations, and transition targets", () => {
    activeGenerationChatIds.set(new Set(["chat-generation"]));

    const protectedIds = getProtectedChatIds(["chat-transition"]);

    expect(protectedIds).toEqual(
      new Set([
        "chat-left",
        "chat-right",
        "chat-generation",
        "chat-transition",
      ]),
    );
    expect(protectedIds.has("chat-hidden")).toBe(false);
  });
});
