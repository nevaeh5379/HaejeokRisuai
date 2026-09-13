import { writable } from "svelte/store";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./stores.svelte", () => ({ selectedCharID: writable(0) }));
vi.mock("./stores/domain/characterStore.svelte", () => ({
  characterStore: { characters: [] },
}));

import { ChatTabsStore, type ChatTab } from "./chatTabs.svelte";
import { characterStore } from "./stores/domain/characterStore.svelte";

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

    expect(store.tabsForGroup("left").map((item) => item.id)).toEqual([
      "b",
      "a",
    ]);
    expect(store.getGroup("left")?.activeTabId).toBe("a");
    expect(store.focusedGroupId).toBe("left");
  });

  it("moves a tab into another split at the requested position", () => {
    store.moveTab("b", "right", 0);

    expect(store.tabsForGroup("left").map((item) => item.id)).toEqual(["a"]);
    expect(store.tabsForGroup("right").map((item) => item.id)).toEqual([
      "b",
      "c",
    ]);
    expect(store.getGroup("right")?.activeTabId).toBe("b");
    expect(store.focusedGroupId).toBe("right");
  });

  it("removes a split when its last tab is moved out", () => {
    store.tabs = [tab("a", "left"), tab("c", "right")];

    store.moveTab("a", "right", 1);

    expect(store.groups.map((group) => group.id)).toEqual(["right"]);
    expect(store.tabsForGroup("right").map((item) => item.id)).toEqual([
      "c",
      "a",
    ]);
    expect(store.getGroup("right")?.activeTabId).toBe("a");
  });
});


describe("ChatTabsStore.detach", () => {
  it("allows the final tab to leave the main window", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    store.tabs = [tab("only", groupId)];
    store.groups[0].activeTabId = "only";

    const result = store.detach("only");

    expect(result).toEqual({
      activeChanged: true,
      activeTab: null,
      becameEmpty: true,
    });
    expect(store.tabs).toEqual([]);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0].activeTabId).toBeNull();
  });
});


describe("ChatTabsStore.openTargetDuplicate", () => {
  it("creates a distinct tab even when the same chat is already open", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    const first = store.openTarget("character-a", "chat-a", groupId);
    const duplicate = store.openTargetDuplicate("character-a", "chat-a", groupId);

    expect(duplicate.id).not.toBe(first.id);
    expect(store.tabsForGroup(groupId)).toHaveLength(2);
    expect(store.tabsForGroup(groupId).map((item) => [item.characterId, item.chatId])).toEqual([
      ["character-a", "chat-a"],
      ["character-a", "chat-a"],
    ]);
    expect(store.getGroup(groupId)?.activeTabId).toBe(duplicate.id);
  });

  it("does not change normal openTarget de-duplication", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    const first = store.openTarget("character-a", "chat-a", groupId);
    const reopened = store.openTarget("character-a", "chat-a", groupId);

    expect(reopened.id).toBe(first.id);
    expect(store.tabsForGroup(groupId)).toHaveLength(1);
  });
});


describe("ChatTabsStore.pruneChat", () => {
  it("removes the tab of a deleted chat and promotes the next tab", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    store.tabs = [tab("a", groupId), tab("b", groupId)];
    store.groups[0].activeTabId = "a";
    store.focusedGroupId = groupId;

    const result = store.pruneChat("chat-a");

    expect(result.activeChanged).toBe(true);
    expect(result.activeTab?.id).toBe("b");
    expect(store.tabs.map((item) => item.id)).toEqual(["b"]);
    expect(store.getGroup(groupId)?.activeTabId).toBe("b");
  });

  it("keeps the active tab when pruning an unrelated chat", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    store.tabs = [tab("a", groupId), tab("b", groupId)];
    store.groups[0].activeTabId = "a";
    store.focusedGroupId = groupId;

    const result = store.pruneChat("chat-b");

    expect(result.activeChanged).toBe(false);
    expect(result.activeTab?.id).toBe("a");
    expect(store.tabs.map((item) => item.id)).toEqual(["a"]);
    expect(store.getGroup(groupId)?.activeTabId).toBe("a");
  });

  it("collapses a split that lost its last tab and moves focus", () => {
    const store = new ChatTabsStore();
    store.groups = [
      { id: "left", activeTabId: "a" },
      { id: "right", activeTabId: "c" },
    ];
    store.focusedGroupId = "left";
    store.tabs = [tab("a", "left"), tab("c", "right")];

    const result = store.pruneChat("chat-a");

    expect(store.groups.map((group) => group.id)).toEqual(["right"]);
    expect(store.focusedGroupId).toBe("right");
    expect(result.activeChanged).toBe(true);
    expect(result.activeTab?.id).toBe("c");
  });

  it("nulls the active tab when the last group loses its only tab", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    store.tabs = [tab("only", groupId)];
    store.groups[0].activeTabId = "only";
    store.focusedGroupId = groupId;

    const result = store.pruneChat("chat-only");

    expect(store.tabs).toEqual([]);
    expect(store.groups).toHaveLength(1);
    expect(store.groups[0].activeTabId).toBeNull();
    expect(result.activeChanged).toBe(true);
    expect(result.activeTab).toBeNull();
  });
});

describe("ChatTabsStore.pruneCharacter", () => {
  it("removes every tab of a deleted character across groups", () => {
    const store = new ChatTabsStore();
    store.groups = [
      { id: "left", activeTabId: "a" },
      { id: "right", activeTabId: "c" },
    ];
    store.focusedGroupId = "left";
    store.tabs = [tab("a", "left"), tab("b", "left"), tab("c", "right")];

    const result = store.pruneCharacter("character-a");

    expect(store.tabs.map((item) => item.id)).toEqual(["b", "c"]);
    expect(store.getGroup("left")?.activeTabId).toBe("b");
    expect(result.activeTab?.id).toBe("b");
  });
});

describe("ChatTabsStore.pruneInvalidTargets", () => {
  it("drops every tab whose character/chat no longer exists", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    store.tabs = [tab("a", groupId), tab("b", groupId), tab("c", groupId)];
    store.groups[0].activeTabId = "a";
    store.focusedGroupId = groupId;

    const result = store.pruneInvalidTargets(
      (characterId, chatId) => chatId !== "chat-a" && chatId !== "chat-c",
    );

    expect(store.tabs.map((item) => item.id)).toEqual(["b"]);
    expect(store.getGroup(groupId)?.activeTabId).toBe("b");
    expect(result.activeChanged).toBe(true);
  });
});


describe("ChatTabsStore workspace snapshots", () => {
  it("restores tab identity, drafts, and split layout", () => {
    const source = new ChatTabsStore();
    source.groups = [
      { id: "left", activeTabId: "a" },
      { id: "right", activeTabId: "b" },
    ];
    const a = tab("a", "left");
    a.draft = "draft-a";
    a.fileInput = ["a.png"];
    source.tabs = [a, tab("b", "right")];
    source.focusedGroupId = "right";

    const target = new ChatTabsStore();
    target.restoreSnapshot(source.snapshot());

    expect(target.snapshot()).toEqual(source.snapshot());
    expect(target.tabs[0]).not.toBe(source.tabs[0]);
    expect(target.tabs[0].fileInput).not.toBe(source.tabs[0].fileInput);
  });

  it("imports a transferred tab without de-duplicating the same chat", () => {
    const store = new ChatTabsStore();
    const groupId = store.groups[0].id;
    const first = store.openTarget("character-a", "chat-a", groupId);
    const duplicate = { ...first, id: "transferred", fileInput: [] };

    const imported = store.importTransferredTab(duplicate, groupId, 1);

    expect(imported?.id).toBe("transferred");
    expect(store.tabsForGroup(groupId).map((item) => item.id)).toEqual([
      first.id,
      "transferred",
    ]);
  });
});

describe("navigateToChatTab stale target validation", () => {
  it("does not activate a stale tab and prunes it instead", async () => {
    const { chatTabsStore, navigateToChatTab } = await import(
      "./chatTabs.svelte"
    );
    const groupId = chatTabsStore.groups[0].id;
    const valid = tab("valid", groupId);
    const stale = tab("stale", groupId);
    chatTabsStore.tabs = [valid, stale];
    chatTabsStore.groups[0].activeTabId = "valid";
    chatTabsStore.focusedGroupId = groupId;

    // character-a does not exist in the mocked (empty) store.
    const result = await navigateToChatTab("stale");

    expect(result).toBe(false);
    expect(chatTabsStore.tabs.map((item) => item.id)).toEqual(["valid"]);
    expect(chatTabsStore.activeTabId).toBe("valid");
  });

  it("does not activate a tab whose chat was deleted", async () => {
    const { chatTabsStore, navigateToChatTab } = await import(
      "./chatTabs.svelte"
    );
    const groupId = chatTabsStore.groups[0].id;
    const valid = tab("valid", groupId);
    const stale = tab("stale", groupId);
    chatTabsStore.tabs = [valid, stale];
    chatTabsStore.groups[0].activeTabId = "valid";
    chatTabsStore.focusedGroupId = groupId;
    characterStore.characters = [
      {
        chaId: "character-valid",
        chats: [{ id: "chat-valid" }],
        chatPage: 0,
      },
    ] as any;

    const result = await navigateToChatTab("stale");

    expect(result).toBe(false);
    expect(chatTabsStore.tabs.map((item) => item.id)).toEqual(["valid"]);
    expect(chatTabsStore.activeTabId).toBe("valid");
  });

  it("activates a valid tab of the already selected character", async () => {
    const { chatTabsStore, navigateToChatTab } = await import(
      "./chatTabs.svelte"
    );
    const groupId = chatTabsStore.groups[0].id;
    const target = tab("target", groupId);
    chatTabsStore.tabs = [target];
    chatTabsStore.groups[0].activeTabId = null;
    chatTabsStore.focusedGroupId = groupId;
    characterStore.characters = [
      {
        chaId: "character-target",
        chats: [{ id: "chat-target" }],
        chatPage: 0,
      },
    ] as any;

    const result = await navigateToChatTab("target");

    expect(result).toBe(true);
    expect(chatTabsStore.activeTabId).toBe("target");
  });
});
