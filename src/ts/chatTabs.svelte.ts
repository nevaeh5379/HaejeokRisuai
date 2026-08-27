import { get } from "svelte/store";
import { selectedCharID } from "./stores.svelte";
import { characterStore } from "./stores/domain/characterStore.svelte";

export interface ChatTab {
  id: string;
  groupId: string;
  characterId: string;
  chatId: string;
  unread: boolean;
  draft: string;
  translatedDraft: string;
  fileInput: string[];
}

export interface ChatTarget {
  characterId: string;
  chatId: string;
  characterName: string;
  chatName: string;
}

export interface ChatTabGroup {
  id: string;
  activeTabId: string | null;
}

const MAX_CHAT_GROUPS = 2;

function createGroupId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `chat-group-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createTabId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `chat-tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function findChatTarget(chatId: string): ChatTarget | null {
  if (!chatId) return null;
  for (const character of characterStore.characters) {
    const chat = character.chats?.find((item) => item.id === chatId);
    if (!chat || !character.chaId) continue;
    return {
      characterId: character.chaId,
      chatId,
      characterName: character.name || "RisuAI",
      chatName: chat.name || "Chat",
    };
  }
  return null;
}

class ChatTabsStore {
  tabs = $state<ChatTab[]>([]);
  groups = $state<ChatTabGroup[]>([{ id: createGroupId(), activeTabId: null }]);
  focusedGroupId = $state(this.groups[0].id);
  navigating = $state(false);

  get focusedGroup(): ChatTabGroup {
    return this.groups.find((group) => group.id === this.focusedGroupId) ?? this.groups[0];
  }

  get activeTabId(): string | null {
    return this.focusedGroup?.activeTabId ?? null;
  }

  set activeTabId(value: string | null) {
    if (this.focusedGroup) this.focusedGroup.activeTabId = value;
  }

  get activeTab(): ChatTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId);
  }

  getGroup(groupId: string): ChatTabGroup | undefined {
    return this.groups.find((group) => group.id === groupId);
  }

  tabsForGroup(groupId: string): ChatTab[] {
    return this.tabs.filter((tab) => tab.groupId === groupId);
  }

  activeTabForGroup(groupId: string): ChatTab | undefined {
    const activeTabId = this.getGroup(groupId)?.activeTabId;
    return this.tabs.find((tab) => tab.id === activeTabId);
  }

  focusGroup(groupId: string): void {
    if (this.getGroup(groupId)) this.focusedGroupId = groupId;
  }

  syncActiveTarget(
    characterId: string,
    chatId: string,
    groupId = this.focusedGroupId,
  ): void {
    if (!characterId || !chatId || this.navigating) return;
    const group = this.getGroup(groupId);
    if (!group) return;
    const active = this.activeTabForGroup(groupId);
    if (!active) {
      const tab = this.createTab(characterId, chatId, groupId);
      this.tabs.push(tab);
      group.activeTabId = tab.id;
      return;
    }
    active.characterId = characterId;
    active.chatId = chatId;
    active.unread = false;
  }

  addFromCurrent(groupId = this.focusedGroupId): ChatTab | null {
    const group = this.getGroup(groupId);
    if (!group) return null;

    const active = this.activeTabForGroup(groupId);
    if (active) {
      const tab = this.createTab(active.characterId, active.chatId, groupId);
      this.tabs.push(tab);
      group.activeTabId = tab.id;
      this.focusedGroupId = groupId;
      return tab;
    }

    const character = characterStore.characters[get(selectedCharID)];
    const chat = character?.chats?.[character.chatPage ?? 0];
    if (!character?.chaId || !chat?.id) return null;
    const tab = this.createTab(character.chaId, chat.id, groupId);
    this.tabs.push(tab);
    group.activeTabId = tab.id;
    this.focusedGroupId = groupId;
    return tab;
  }

  openTarget(
    characterId: string,
    chatId: string,
    groupId = this.focusedGroupId,
  ): ChatTab {
    const existing = this.tabs.find(
      (tab) => tab.characterId === characterId && tab.chatId === chatId,
    );
    if (existing) {
      this.focusedGroupId = existing.groupId;
      const group = this.getGroup(existing.groupId);
      if (group) group.activeTabId = existing.id;
      existing.unread = false;
      return existing;
    }
    const group = this.getGroup(groupId) ?? this.focusedGroup;
    const tab = this.createTab(characterId, chatId, group.id);
    this.tabs.push(tab);
    group.activeTabId = tab.id;
    this.focusedGroupId = group.id;
    return tab;
  }

  setActive(tabId: string): ChatTab | null {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return null;
    const group = this.getGroup(tab.groupId);
    if (!group) return null;
    this.focusedGroupId = group.id;
    group.activeTabId = tab.id;
    tab.unread = false;
    return tab;
  }

  close(tabId: string): { activeChanged: boolean; activeTab: ChatTab | null } {
    if (this.tabs.length <= 1) {
      return { activeChanged: false, activeTab: this.activeTab ?? null };
    }
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return { activeChanged: false, activeTab: this.activeTab ?? null };
    const group = this.getGroup(tab.groupId);
    if (!group) return { activeChanged: false, activeTab: this.activeTab ?? null };
    const groupTabs = this.tabsForGroup(group.id);
    const groupIndex = groupTabs.findIndex((item) => item.id === tabId);
    const wasGroupActive = group.activeTabId === tabId;
    const wasFocused = this.focusedGroupId === group.id;
    this.tabs.splice(this.tabs.indexOf(tab), 1);

    if (groupTabs.length === 1 && this.groups.length > 1) {
      const index = this.groups.findIndex((item) => item.id === group.id);
      this.groups.splice(index, 1);
      if (wasFocused) {
        const nextGroup = this.groups[Math.min(index, this.groups.length - 1)] ?? this.groups[0];
        this.focusedGroupId = nextGroup.id;
        return { activeChanged: true, activeTab: this.activeTabForGroup(nextGroup.id) ?? null };
      }
      return { activeChanged: false, activeTab: this.activeTab ?? null };
    }

    if (wasGroupActive) {
      const remaining = this.tabsForGroup(group.id);
      const next = remaining[Math.min(groupIndex, remaining.length - 1)] ?? null;
      group.activeTabId = next?.id ?? null;
      if (next) next.unread = false;
      return { activeChanged: wasFocused, activeTab: wasFocused ? next : this.activeTab ?? null };
    }
    return { activeChanged: false, activeTab: this.activeTab ?? null };
  }

  closeOthers(tabId: string): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    this.tabs = this.tabs.filter((item) => item.groupId !== tab.groupId || item.id === tabId);
    const group = this.getGroup(tab.groupId);
    if (group) group.activeTabId = tab.id;
    tab.unread = false;
  }

  closeToRight(tabId: string): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const groupTabs = this.tabsForGroup(tab.groupId);
    const index = groupTabs.findIndex((item) => item.id === tabId);
    if (index < 0) return;
    const removeIds = new Set(groupTabs.slice(index + 1).map((item) => item.id));
    this.tabs = this.tabs.filter((item) => !removeIds.has(item.id));
  }

  canSplit(): boolean {
    return this.groups.length < MAX_CHAT_GROUPS;
  }

  splitRight(tabId: string): ChatTab | null {
    if (!this.canSplit()) return null;
    const source = this.tabs.find((item) => item.id === tabId);
    if (!source) return null;
    const sourceGroupIndex = this.groups.findIndex((group) => group.id === source.groupId);
    if (sourceGroupIndex < 0) return null;
    const group: ChatTabGroup = { id: createGroupId(), activeTabId: null };
    const copy = this.createTab(source.characterId, source.chatId, group.id, source);
    group.activeTabId = copy.id;
    this.groups.splice(sourceGroupIndex + 1, 0, group);
    this.tabs.push(copy);
    this.focusedGroupId = group.id;
    return copy;
  }

  hasAdjacentGroup(groupId: string, direction: -1 | 1): boolean {
    const index = this.groups.findIndex((group) => group.id === groupId);
    return index >= 0 && Boolean(this.groups[index + direction]);
  }

  moveToAdjacentGroup(tabId: string, direction: -1 | 1): ChatTab | null {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return null;
    const sourceGroup = this.getGroup(tab.groupId);
    const sourceIndex = this.groups.findIndex((group) => group.id === tab.groupId);
    const targetGroup = this.groups[sourceIndex + direction];
    if (!sourceGroup || !targetGroup) return null;
    const sourceTabs = this.tabsForGroup(sourceGroup.id);
    tab.groupId = targetGroup.id;
    targetGroup.activeTabId = tab.id;
    tab.unread = false;
    this.focusedGroupId = targetGroup.id;

    if (sourceTabs.length === 1) {
      this.groups.splice(sourceIndex, 1);
    } else if (sourceGroup.activeTabId === tab.id) {
      sourceGroup.activeTabId = sourceTabs.find((item) => item.id !== tab.id)?.id ?? null;
    }
    return tab;
  }

  saveDraft(
    tabId: string,
    draft: string,
    translatedDraft: string,
    fileInput: string[],
  ): void {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    tab.draft = draft;
    tab.translatedDraft = translatedDraft;
    tab.fileInput = [...fileInput];
  }

  markUnread(chatId: string): void {
    if (!chatId || this.isActiveChat(chatId)) return;
    for (const tab of this.tabs) {
      if (tab.chatId === chatId) tab.unread = true;
    }
  }

  isActiveChat(chatId: string): boolean {
    if (!chatId) return false;
    return this.groups.some((group) => this.activeTabForGroup(group.id)?.chatId === chatId);
  }

  private createTab(
    characterId: string,
    chatId: string,
    groupId: string,
    source?: ChatTab,
  ): ChatTab {
    return {
      id: createTabId(),
      groupId,
      characterId,
      chatId,
      unread: false,
      draft: source?.draft ?? "",
      translatedDraft: source?.translatedDraft ?? "",
      fileInput: [...(source?.fileInput ?? [])],
    };
  }
}

export const chatTabsStore = new ChatTabsStore();
let navigationSequence = 0;

export async function navigateToChatTab(tabId: string): Promise<boolean> {
  const tab = chatTabsStore.setActive(tabId);
  if (!tab) return false;
  const characterIndex = characterStore.characters.findIndex(
    (character) => character.chaId === tab.characterId,
  );
  if (characterIndex < 0) return false;
  const sequence = ++navigationSequence;

  chatTabsStore.navigating = true;
  try {
    if (get(selectedCharID) !== characterIndex) {
      const { changeChar } = await import("./characters");
      await changeChar(characterIndex);
    }
    if (sequence !== navigationSequence || chatTabsStore.activeTabId !== tabId) return false;
    const character = characterStore.characters[characterIndex];
    const chatIndex = character?.chats?.findIndex((chat) => chat.id === tab.chatId) ?? -1;
    if (chatIndex < 0) return false;
    if (character.chatPage !== chatIndex) {
      const { changeChatTo } = await import("./globalApi.svelte");
      changeChatTo(chatIndex);
    }
    tab.unread = false;
    return true;
  } finally {
    if (sequence === navigationSequence) chatTabsStore.navigating = false;
  }
}

export async function openChatTargetInTab(
  characterId: string,
  chatId: string,
): Promise<boolean> {
  const tab = chatTabsStore.openTarget(characterId, chatId);
  return navigateToChatTab(tab.id);
}
