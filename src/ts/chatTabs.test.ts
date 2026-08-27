import { writable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./stores.svelte", () => ({ selectedCharID: writable(0) }));
vi.mock("./stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [] },
}));

import { ChatTabsStore, type ChatTab } from "./chatTabs.svelte";

function tab(id: string, groupId: string): ChatTab {
  return {
    id,
    groupId,
    characterId: `character-${id}`,
    chatId: `chat-${id}`,
    unread: false,
    draft: "",
    translatedDraft: "",
    fileInput: [],
  };
}

describe("ChatTabsStore.moveTab", () => {
  let store: ChatTabsStore;

  beforeEach(() => {
    store = new ChatTabsStore();
    store.groups = [
      { id: "left", activeTabId: "a" },
      { id: "right", activeTabId: "c" },
    ];
    store.focusedGroupId = "left";
    store.tabs = [tab("a", "left"), tab("b", "left"), tab("c", "right")];
  });

  it("reorders tabs within a split without changing the active tab", () => {
    store.moveTab("a", "left", 1);

    expect(store.tabsForGroup("left").map((item) => item.id)).toEqual(["b", "a"]);
    expect(store.getGroup("left")?.activeTabId).toBe("a");
    expect(store.focusedGroupId).toBe("left");
  });

  it("moves a tab into another split at the requested position", () => {
    store.moveTab("b", "right", 0);

    expect(store.tabsForGroup("left").map((item) => item.id)).toEqual(["a"]);
    expect(store.tabsForGroup("right").map((item) => item.id)).toEqual(["b", "c"]);
    expect(store.getGroup("right")?.activeTabId).toBe("b");
    expect(store.focusedGroupId).toBe("right");
  });

  it("removes a split when its last tab is moved out", () => {
    store.tabs = [tab("a", "left"), tab("c", "right")];

    store.moveTab("a", "right", 1);

    expect(store.groups.map((group) => group.id)).toEqual(["right"]);
    expect(store.tabsForGroup("right").map((item) => item.id)).toEqual(["c", "a"]);
    expect(store.getGroup("right")?.activeTabId).toBe("a");
  });
});
