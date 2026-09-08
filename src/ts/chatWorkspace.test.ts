import { describe, expect, it } from "vitest";
import type { ChatTab, ChatTabsSnapshot } from "./chatTabs.svelte";
import {
  ChatWindowManager,
  MAIN_CHAT_WORKSPACE_WINDOW_ID,
  createSingleTabSnapshot,
} from "./chatWorkspace";

function tab(id: string, chatId = `chat-${id}`): ChatTab {
  return {
    id,
    groupId: "source",
    characterId: `character-${id}`,
    chatId,
    unread: false,
    draft: `draft-${id}`,
    translatedDraft: "",
    fileInput: [`${id}.png`],
  };
}

function snapshot(...tabs: ChatTab[]): ChatTabsSnapshot {
  return {
    tabs,
    groups: [{ id: "source", activeTabId: tabs[0]?.id ?? null }],
    focusedGroupId: "source",
  };
}

describe("ChatWindowManager", () => {
  it("tracks main and auxiliary windows as one workspace", () => {
    const manager = new ChatWindowManager(snapshot(tab("main")));
    manager.registerAuxiliary("aux-1", createSingleTabSnapshot(tab("aux")));

    expect(manager.listWindows().map((window) => window.id)).toEqual([
      MAIN_CHAT_WORKSPACE_WINDOW_ID,
      "aux-1",
    ]);
    expect(manager.getWindow("aux-1")?.kind).toBe("auxiliary");
  });

  it("preserves duplicate chats as distinct tab instances", () => {
    const manager = new ChatWindowManager();
    manager.registerAuxiliary(
      "aux-1",
      snapshot(tab("first", "same-chat"), tab("second", "same-chat")),
    );

    expect(manager.getWindow("aux-1")?.tabs.tabs.map((item) => item.id)).toEqual([
      "first",
      "second",
    ]);
  });

  it("removes auxiliary windows without deleting main", () => {
    const manager = new ChatWindowManager(snapshot(tab("main")));
    manager.registerAuxiliary("aux-1", createSingleTabSnapshot(tab("aux")));

    expect(manager.removeWindow("aux-1")).toBe(true);
    expect(manager.removeWindow(MAIN_CHAT_WORKSPACE_WINDOW_ID)).toBe(false);
    expect(manager.getWindow(MAIN_CHAT_WORKSPACE_WINDOW_ID)).not.toBeNull();
  });

  it("round-trips workspace layout and bounds", () => {
    const manager = new ChatWindowManager(snapshot(tab("main")));
    manager.registerAuxiliary("aux-1", createSingleTabSnapshot(tab("aux")), {
      x: 20,
      y: 30,
      width: 900,
      height: 700,
    });
    const saved = manager.snapshot();
    const restored = new ChatWindowManager();
    restored.restore(saved);

    expect(restored.snapshot()).toEqual(saved);
  });
});
