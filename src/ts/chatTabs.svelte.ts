import { get } from "svelte/store";
import { selectedCharID } from "./stores.svelte";
import { characterStore } from "./stores/domain/characterStore.svelte";

export interface ChatTab {
  id: string;
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
  activeTabId = $state<string | null>(null);
  navigating = $state(false);

  get activeTab(): ChatTab | undefined {
    return this.tabs.find((tab) => tab.id === this.activeTabId);
  }

  syncActiveTarget(characterId: string, chatId: string): void {
    if (!characterId || !chatId || this.navigating) return;
    const active = this.activeTab;
    if (!active) {
      const tab = this.createTab(characterId, chatId);
      this.tabs.push(tab);
      this.activeTabId = tab.id;
      return;
    }
    active.characterId = characterId;
    active.chatId = chatId;
    active.unread = false;
  }

  addFromCurrent(): ChatTab | null {
    const character = characterStore.characters[get(selectedCharID)];
    const chat = character?.chats?.[character.chatPage ?? 0];
    if (!character?.chaId || !chat?.id) return null;
    const tab = this.createTab(character.chaId, chat.id);
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    return tab;
  }

  openTarget(characterId: string, chatId: string): ChatTab {
    const existing = this.tabs.find(
      (tab) => tab.characterId === characterId && tab.chatId === chatId,
    );
    if (existing) {
      this.activeTabId = existing.id;
      existing.unread = false;
      return existing;
    }
    const tab = this.createTab(characterId, chatId);
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    return tab;
  }

  setActive(tabId: string): ChatTab | null {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return null;
    this.activeTabId = tab.id;
    tab.unread = false;
    return tab;
  }

  close(tabId: string): { activeChanged: boolean; activeTab: ChatTab | null } {
    if (this.tabs.length <= 1) {
      return { activeChanged: false, activeTab: this.activeTab ?? null };
    }
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return { activeChanged: false, activeTab: this.activeTab ?? null };
    const wasActive = this.activeTabId === tabId;
    this.tabs.splice(index, 1);
    if (!wasActive) return { activeChanged: false, activeTab: this.activeTab ?? null };

    const next = this.tabs[Math.min(index, this.tabs.length - 1)] ?? null;
    this.activeTabId = next?.id ?? null;
    if (next) next.unread = false;
    return { activeChanged: true, activeTab: next };
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
    if (!chatId || this.activeTab?.chatId === chatId) return;
    for (const tab of this.tabs) {
      if (tab.chatId === chatId) tab.unread = true;
    }
  }

  isActiveChat(chatId: string): boolean {
    return Boolean(chatId && this.activeTab?.chatId === chatId);
  }

  private createTab(characterId: string, chatId: string): ChatTab {
    return {
      id: createTabId(),
      characterId,
      chatId,
      unread: false,
      draft: "",
      translatedDraft: "",
      fileInput: [],
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
