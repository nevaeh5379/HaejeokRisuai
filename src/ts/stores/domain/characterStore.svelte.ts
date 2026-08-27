import type { character, groupChat, Chat } from "../../storage/database.svelte";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import { getSqlStorage } from "../../storage/sqlStorageFactory";
import { v4 as uuidv4 } from "uuid";
import { sqlCharacterData, sqlChatData } from "../../storage/sqlCommit";
import { settingsStore } from "./settingsStore.svelte";
import { getInitialChatLoadPages } from "../../chatLoadPages";
import { trackDeep, snapshotFingerprint } from "./reactiveUtils";
import { commitSqlChanges } from "../../storage/sqlCommitCoordinator";

// Keep persisted history ordering, overlay newer in-memory fields, and retain
// stable-ID messages that have not reached storage yet.

const CHARACTER_RUNTIME_KEYS = new Set([
  "chats",
  "chaId",
  "detailsLoaded",
  // Persisted through the scalar-only character touch path. Tracking it here
  // would turn every selection/generation timestamp into a full character write.
  "lastInteraction",
]);
const CHAT_RUNTIME_KEYS = new Set([
  "message",
  "id",
  "messagesLoaded",
  "messageOffset",
  "messageTotal",
  "messagesFullyLoaded",
  "preventMessageCompaction",
  "detailsLoaded",
]);

function persistedFieldsFingerprint(
  value: Record<string, unknown>,
  excluded: Set<string>,
): string {
  const persisted: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (excluded.has(key)) continue;
    persisted[key] = value[key];
  }
  trackDeep(persisted);
  return snapshotFingerprint(persisted);
}

function mergeLoadedChats(loaded: Chat[], current: Chat[]): Chat[] {
  if (current.length === 0) return loaded;

  const currentById = new Map(
    current.filter((chat) => chat.id).map((chat) => [chat.id!, chat]),
  );
  const loadedIds = new Set<string>();
  const merged = loaded.map((chat) => {
    if (!chat.id) return chat;
    loadedIds.add(chat.id);
    const existing = currentById.get(chat.id);
    if (!existing) return chat;
    Object.assign(chat, existing);
    chat.detailsLoaded = true;
    return chat;
  });

  for (const chat of current) {
    if (chat.id && !loadedIds.has(chat.id)) merged.push(chat);
  }
  return merged;
}

function mergeLoadedMessages(
  loaded: Chat["message"],
  current: Chat["message"],
): Chat["message"] {
  if (current.length === 0) return loaded;

  const currentById = new Map(
    current
      .filter((message) => message.chatId)
      .map((message) => [message.chatId!, message]),
  );
  const loadedIds = new Set<string>();
  const merged = loaded.map((message) => {
    if (!message.chatId) return message;
    loadedIds.add(message.chatId);
    const existing = currentById.get(message.chatId);
    return existing ? { ...message, ...existing } : message;
  });

  for (const message of current) {
    if (message.chatId && !loadedIds.has(message.chatId)) merged.push(message);
  }
  return merged;
}

class CharacterStore {
  private storage: ISqlStorage | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private touchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private touchIdleHandle: number | null = null;

  // Dirty sets — only IDs, no snapshots.  Serialised at flush time.
  private dirtyCharacters = new Set<string>();
  private dirtyCharacterTouches = new Map<string, number>();
  private dirtyChats = new Set<string>();
  private dirtyChatManifests = new Set<string>(); // character IDs whose chat list changed
  private dirtyCharacterIds = false; // character order changed

  // Effect lifecycles
  private arrayDispose: (() => void) | null = null;
  private activeDispose: (() => void) | null = null;
  private charIdsSnapshot = "";

  private characterDetailPromises = new Map<string, Promise<void>>();
  private chatDetailPromises = new Map<string, Promise<void>>();
  private olderChatPromises = new Map<string, Promise<number>>();
  // Full history can be loaded without expensive historical generation/prompt metadata.
  private generationOnlyMetadataChats = new Set<string>();

  characters = $state<(character | groupChat)[]>([]);
  selectedId = $state<number>(-1);

  get currentCharacter(): (character | groupChat) | undefined {
    return this.characters[this.selectedId];
  }

  get currentChat(): Chat | undefined {
    const char = this.currentCharacter;
    if (!char || !char.chats) return undefined;
    return char.chats[char.chatPage ?? 0];
  }

  init(characters: (character | groupChat)[], storage: ISqlStorage): void {
    this.storage = storage;
    this.cancelScheduledTouchCommit();
    this.arrayDispose?.();
    this.arrayDispose = null;
    this.activeDispose?.();
    this.activeDispose = null;
    this.dirtyCharacters.clear();
    this.dirtyCharacterTouches.clear();
    this.dirtyChats.clear();
    this.dirtyChatManifests.clear();
    this.generationOnlyMetadataChats.clear();
    this.dirtyCharacterIds = false;

    for (const char of characters) {
      char.chaId ||= uuidv4();
      for (const chat of char.chats ?? []) {
        chat.id ||= uuidv4();
      }
    }
    this.charIdsSnapshot = characters.map((c) => c.chaId).join(",");
    this.characters = characters;
    this.selectedId = -1;
    this.observeArray();
    this.observeActive();
  }

  // ── Character array tracking (order & additions) ─────────────────

  private observeArray(): void {
    this.arrayDispose?.();
    this.arrayDispose = null;

    const knownCharIds = new Set<string>(
      this.characters.map((c) => c.chaId).filter(Boolean),
    );

    this.arrayDispose = $effect.root(() => {
      $effect(() => {
        const chars = this.characters;
        let orderChanged = false;
        for (const c of chars) {
          if (!c.chaId) c.chaId = uuidv4();
          if (!knownCharIds.has(c.chaId)) {
            knownCharIds.add(c.chaId);
            this.dirtyCharacters.add(c.chaId);
            orderChanged = true;
          }
        }
        const currentIds = chars.map((c) => c.chaId).join(",");
        if (currentIds !== this.charIdsSnapshot || orderChanged) {
          this.charIdsSnapshot = currentIds;
          this.dirtyCharacterIds = true;
          this.scheduleCommit();
        }
      });
    });
  }

  // ── Active character + active chat tracking ──────────────────────

  private observeActive(): void {
    this.activeDispose?.();
    this.activeDispose = null;

    const char = this.characters[this.selectedId];
    if (!char) return;

    // Preserve the legacy invariant: every chat must have a stable id
    // (the old observe loop assigned these during traversal).
    for (const c of char.chats ?? []) {
      if (!c.id) c.id = uuidv4();
    }

    // Track only data that is actually persisted. Message bodies live in the
    // message store and must not cause character/chat metadata commits while
    // streaming. Fingerprints also suppress broad Svelte proxy invalidations
    // when the persisted metadata itself did not change.
    let lastCharFingerprint = persistedFieldsFingerprint(
      char as unknown as Record<string, unknown>,
      CHARACTER_RUNTIME_KEYS,
    );
    const activeChatAtObserve = char.chats?.[char.chatPage ?? 0];
    let lastChatId = activeChatAtObserve?.id;
    let lastChatFingerprint = activeChatAtObserve
      ? persistedFieldsFingerprint(
          activeChatAtObserve as unknown as Record<string, unknown>,
          CHAT_RUNTIME_KEYS,
        )
      : "";
    let lastManifestKey = (char.chats ?? []).map((c) => c.id).join(",");
    const knownChatIds = new Set<string>((char.chats ?? []).map((c) => c.id));

    this.activeDispose = $effect.root(() => {
      $effect(() => {
        const fingerprint = persistedFieldsFingerprint(
          char as unknown as Record<string, unknown>,
          CHARACTER_RUNTIME_KEYS,
        );
        if (fingerprint === lastCharFingerprint) return;
        lastCharFingerprint = fingerprint;
        this.dirtyCharacterTouches.delete(char.chaId);
        this.dirtyCharacters.add(char.chaId);
        this.scheduleCommit();
      });

      // Chat switches should not persist a chat row by themselves. The new
      // active chat becomes the comparison baseline; only later metadata
      // changes to that same chat are committed.
      $effect(() => {
        const page = char.chatPage ?? 0;
        const chat = char.chats?.[page];
        if (!chat) {
          lastChatId = undefined;
          lastChatFingerprint = "";
          return;
        }
        const fingerprint = persistedFieldsFingerprint(
          chat as unknown as Record<string, unknown>,
          CHAT_RUNTIME_KEYS,
        );
        if (chat.id !== lastChatId) {
          lastChatId = chat.id;
          lastChatFingerprint = fingerprint;
          return;
        }
        if (fingerprint === lastChatFingerprint) return;
        lastChatFingerprint = fingerprint;
        if (chat.id) {
          this.dirtyChats.add(chat.id);
          this.scheduleCommit();
        }
      });

      // Track chat list structure only. Broad proxy invalidations from message
      // mutations may rerun this effect, but an unchanged manifest is a no-op.
      $effect(() => {
        const chats = char.chats ?? [];
        let added = false;
        for (const c of chats) {
          if (!c.id) c.id = uuidv4();
          if (!knownChatIds.has(c.id)) {
            knownChatIds.add(c.id);
            this.dirtyChats.add(c.id);
            added = true;
          }
        }
        const manifestKey = chats.map((c) => c.id).join(",");
        if (manifestKey === lastManifestKey && !added) return;
        lastManifestKey = manifestKey;
        this.dirtyChatManifests.add(char.chaId);
        this.scheduleCommit();
      });
    });
  }

  // ── Explicit dirty marking for non-active characters/chats ───────

  markCharacterDirty(chaId: string): void {
    this.dirtyCharacterTouches.delete(chaId);
    this.dirtyCharacters.add(chaId);
    this.scheduleCommit();
  }

  touchCharacterInteraction(index: number, timestamp = Date.now()): void {
    const char = this.characters[index];
    if (!char?.chaId) return;
    char.lastInteraction = timestamp;
    if (!this.dirtyCharacters.has(char.chaId)) {
      this.dirtyCharacterTouches.set(char.chaId, timestamp);
    }
    this.scheduleTouchCommit();
  }

  markChatDirty(chatId: string): void {
    this.dirtyChats.add(chatId);
    this.scheduleCommit();
  }

  markChatManifestDirty(chaId: string): void {
    this.dirtyChatManifests.add(chaId);
    this.scheduleCommit();
  }

  markCharacterOrderDirty(): void {
    this.dirtyCharacterIds = true;
    this.charIdsSnapshot = this.characters.map((c) => c.chaId || "").join(",");
    this.scheduleCommit();
  }

  // ── Commit pipeline ───────────────────────────────────────────────

  private cancelScheduledTouchCommit(): void {
    if (this.touchDebounceTimer) {
      clearTimeout(this.touchDebounceTimer);
      this.touchDebounceTimer = null;
    }
    if (this.touchIdleHandle !== null) {
      if ("cancelIdleCallback" in globalThis) {
        globalThis.cancelIdleCallback(this.touchIdleHandle);
      }
      this.touchIdleHandle = null;
    }
  }

  private scheduleTouchCommit(): void {
    this.cancelScheduledTouchCommit();
    this.touchDebounceTimer = setTimeout(() => {
      this.touchDebounceTimer = null;
      const flushTouches = () => {
        this.touchIdleHandle = null;
        void this.flush();
      };
      if ("requestIdleCallback" in globalThis) {
        this.touchIdleHandle = globalThis.requestIdleCallback(flushTouches, {
          timeout: 3000,
        });
      } else {
        this.touchDebounceTimer = setTimeout(flushTouches, 0);
      }
    }, 750);
  }

  private scheduleCommit(): void {
    this.cancelScheduledTouchCommit();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, 300);
  }

  async flush(): Promise<void> {
    this.cancelScheduledTouchCommit();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (
      this.dirtyCharacters.size === 0 &&
      this.dirtyCharacterTouches.size === 0 &&
      this.dirtyChats.size === 0 &&
      this.dirtyChatManifests.size === 0 &&
      !this.dirtyCharacterIds
    ) {
      return;
    }

    const storage = this.storage || (await getSqlStorage());

    // Serialise dirty characters
    const characters: { id: string; position: number; data: unknown }[] = [];
    for (const chaId of this.dirtyCharacters) {
      const idx = this.characters.findIndex((c) => c.chaId === chaId);
      if (idx >= 0) {
        characters.push({
          id: chaId,
          position: idx,
          data: sqlCharacterData($state.snapshot(this.characters[idx])),
        });
      }
    }

    const characterTouches = Array.from(
      this.dirtyCharacterTouches,
      ([id, lastInteraction]) => ({ id, lastInteraction }),
    ).filter((touch) => !this.dirtyCharacters.has(touch.id));

    // Serialise dirty chats
    const chats: {
      id: string;
      characterId: string;
      position: number;
      data: unknown;
    }[] = [];
    for (const chatId of this.dirtyChats) {
      for (const char of this.characters) {
        const chatIdx = char.chats?.findIndex((c) => c.id === chatId);
        if (chatIdx !== undefined && chatIdx >= 0) {
          chats.push({
            id: chatId,
            characterId: char.chaId,
            position: chatIdx,
            data: sqlChatData($state.snapshot(char.chats[chatIdx])),
          });
          break;
        }
      }
    }

    // Chat manifests (chat list order per character)
    const chatManifests: { characterId: string; ids: string[] }[] = [];
    for (const chaId of this.dirtyChatManifests) {
      const char = this.characters.find((c) => c.chaId === chaId);
      if (char?.chats) {
        chatManifests.push({
          characterId: chaId,
          ids: char.chats.map((c) => c.id).filter(Boolean) as string[],
        });
      }
    }

    // Character order
    const characterIds = this.dirtyCharacterIds
      ? this.characters.map((c) => c.chaId)
      : undefined;

    let action = "character";
    if (characters.length > 0) {
      action = "character";
    } else if (chats.length > 0 || chatManifests.length > 0) {
      action = "chat";
    } else if (characterTouches.length > 0) {
      action = "character-touch";
    } else if (characterIds !== undefined) {
      action = "order";
    }

    const committedCharacterIds = new Set(this.dirtyCharacters);
    const committedTouches = new Map(this.dirtyCharacterTouches);
    const committedChatIds = new Set(this.dirtyChats);
    const committedManifestIds = new Set(this.dirtyChatManifests);
    const committedCharacterOrder = this.dirtyCharacterIds;
    this.dirtyCharacters.clear();
    this.dirtyCharacterTouches.clear();
    this.dirtyChats.clear();
    this.dirtyChatManifests.clear();
    this.dirtyCharacterIds = false;

    try {
      await commitSqlChanges(storage, {
        baseRevision: storage.getRevision(),
        action,
        root: { upserts: [], deletes: [] },
        characters,
        characterTouches,
        characterIds,
        chats,
        chatManifests,
        messages: [],
        messageManifests: [],
      });
    } catch (error) {
      for (const id of committedCharacterIds) {
        this.dirtyCharacterTouches.delete(id);
        this.dirtyCharacters.add(id);
      }
      for (const [id, timestamp] of committedTouches) {
        if (!this.dirtyCharacters.has(id)) {
          const current = this.dirtyCharacterTouches.get(id);
          this.dirtyCharacterTouches.set(id, Math.max(current ?? 0, timestamp));
        }
      }
      for (const id of committedChatIds) this.dirtyChats.add(id);
      for (const id of committedManifestIds)
        this.dirtyChatManifests.add(id);
      this.dirtyCharacterIds ||= committedCharacterOrder;
      console.error(
        "[CharacterStore] Failed to commit character changes to SQL storage:",
        error,
      );
    }
  }

  hasPendingWrites(): boolean {
    return (
      this.dirtyCharacters.size > 0 ||
      this.dirtyCharacterTouches.size > 0 ||
      this.dirtyChats.size > 0 ||
      this.dirtyChatManifests.size > 0 ||
      this.dirtyCharacterIds
    );
  }

  // ── Public accessors ──────────────────────────────────────────────

  get(
    index: number,
    options?: { snapshot?: boolean },
  ): (character | groupChat) | undefined {
    const char = this.characters[index];
    if (!char) return undefined;
    return options?.snapshot
      ? ($state.snapshot(char) as character | groupChat)
      : char;
  }

  getById(id: string): (character | groupChat) | undefined {
    return this.characters.find((c) => c.chaId === id);
  }

  getCurrentCharacter(options?: {
    snapshot?: boolean;
  }): (character | groupChat) | undefined {
    return this.get(this.selectedId, options);
  }

  setCurrentCharacter(char: character | groupChat): void {
    if (this.selectedId >= 0 && this.selectedId < this.characters.length) {
      char.chaId ||= this.characters[this.selectedId].chaId || uuidv4();
      this.characters[this.selectedId] = char;
      this.dirtyCharacterTouches.delete(char.chaId);
      this.dirtyCharacters.add(char.chaId);
      this.scheduleCommit();
      this.observeActive();
    }
  }

  getCharacterByIndex(
    index: number,
    options?: { snapshot?: boolean },
  ): (character | groupChat) | undefined {
    return this.get(index, options);
  }

  setCharacterByIndex(index: number, char: character | groupChat): void {
    if (index >= 0 && index < this.characters.length) {
      char.chaId ||= this.characters[index].chaId || uuidv4();
      this.characters[index] = char;
      this.dirtyCharacterTouches.delete(char.chaId);
      this.dirtyCharacters.add(char.chaId);
      this.scheduleCommit();
      if (index === this.selectedId) {
        this.observeActive();
      }
    }
  }

  getCurrentChat(): Chat | undefined {
    return this.currentChat;
  }

  setCurrentChat(chat: Chat): void {
    const char = this.currentCharacter;
    if (char && char.chats) {
      char.chats[char.chatPage ?? 0] = chat;
    }
  }

  select(index: number): void {
    this.selectedId = index;
    // Re-observe the new active character
    this.observeActive();
  }

  add(char: character | groupChat): number {
    char.chaId ||= uuidv4();
    this.dirtyCharacterTouches.delete(char.chaId);
    this.dirtyCharacters.add(char.chaId);
    this.dirtyCharacterIds = true;
    this.characters.push(char);
    this.scheduleCommit();
    return this.characters.length - 1;
  }

  remove(index: number): void {
    if (index >= 0 && index < this.characters.length) {
      this.characters.splice(index, 1);
      this.dirtyCharacterIds = true;
      this.scheduleCommit();
      if (this.selectedId >= this.characters.length) {
        this.selectedId = this.characters.length - 1;
      }
      this.observeActive();
    }
  }

  async ensureCharacterDetails(chaId: string): Promise<void> {
    if (this.characterDetailPromises.has(chaId)) {
      return this.characterDetailPromises.get(chaId);
    }
    const storage = this.storage || (await getSqlStorage());
    const promise = (async () => {
      try {
        const fullChar = await (storage.loadCharacterForSelection?.(chaId) ??
          storage.loadCharacter(chaId));
        if (fullChar) {
          const idx = this.characters.findIndex((c) => c.chaId === chaId);
          if (idx >= 0) {
            const existingChats = this.characters[idx].chats ?? [];
            const loadedChats = fullChar.chats ?? [];
            this.characters[idx] = Object.assign(
              this.characters[idx],
              fullChar,
              {
                chats: mergeLoadedChats(loadedChats, existingChats),
                detailsLoaded: true,
              },
            );
            if (idx === this.selectedId) {
              this.observeActive();
            }
          }
        }
      } catch (error) {
        console.error(
          `[CharacterStore] loadCharacter failed for ${chaId}:`,
          error,
        );
      } finally {
        this.characterDetailPromises.delete(chaId);
      }
    })();
    this.characterDetailPromises.set(chaId, promise);
    return promise;
  }

  async refreshChat(chatId: string): Promise<boolean> {
    const char = this.characters.find((item) =>
      item.chats?.some((chat) => chat.id === chatId),
    );
    const chat = char?.chats?.find((item) => item.id === chatId);
    if (!char || !chat) return false;

    const storage = this.storage || (await getSqlStorage());
    const fullyLoaded = chat.messagesFullyLoaded !== false;
    const transient = {
      preventMessageCompaction: chat.preventMessageCompaction,
      isStreaming: chat.isStreaming,
      activeStreamingDisplayOptimizationMode:
        chat.activeStreamingDisplayOptimizationMode,
    };
    const refreshed = await storage.loadChat(
      chatId,
      fullyLoaded ? undefined : { messageLimit: getInitialChatLoadPages(settingsStore.state) },
    );
    if (!refreshed) return false;

    Object.assign(chat, refreshed, transient);
    if (this.characters[this.selectedId] === char) this.observeActive();
    return true;
  }

  async ensureChatMessages(
    chatId: string,
    options: { full?: boolean; generation?: boolean } = {},
  ): Promise<void> {
    const initialMessagePageSize = getInitialChatLoadPages(settingsStore.state);
    const char = this.characters.find((c) =>
      c.chats?.some((ch) => ch.id === chatId),
    );
    const chat = char?.chats?.find((ch) => ch.id === chatId);
    const needsFullMetadata =
      options.full &&
      !options.generation &&
      this.generationOnlyMetadataChats.has(chatId);
    if (
      chat?.messagesLoaded !== false &&
      chat?.detailsLoaded !== false &&
      (!options.full || chat.messagesFullyLoaded !== false) &&
      !needsFullMetadata
    ) {
      return;
    }

    if (this.chatDetailPromises.has(chatId)) {
      await this.chatDetailPromises.get(chatId);
      if (
        options.full &&
        (chat?.messagesFullyLoaded === false ||
          (!options.generation && this.generationOnlyMetadataChats.has(chatId)))
      ) {
        await this.ensureChatMessages(chatId, options);
      }
      return;
    }

    const storage = this.storage || (await getSqlStorage());
    const promise = (async () => {
      try {
        if (
          options.full &&
          chat?.detailsLoaded !== false &&
          chat?.messagesLoaded !== false
        ) {
          const previousMessages = chat.message ?? [];
          const messages = await storage.loadChatMessages(chatId, {
            mode: options.generation ? "generation" : "full",
          });
          chat.message = mergeLoadedMessages(messages, previousMessages);
          chat.messageOffset = 0;
          chat.messageTotal = chat.message.length;
          chat.messagesFullyLoaded = true;
          chat.messagesLoaded = true;
          if (options.generation) {
            this.generationOnlyMetadataChats.add(chatId);
          } else {
            this.generationOnlyMetadataChats.delete(chatId);
          }
          return;
        }

        const fullChat = await storage.loadChat(
          chatId,
          options.full ? undefined : { messageLimit: initialMessagePageSize },
        );
        if (fullChat && chat) {
          Object.assign(chat, fullChat);
          chat.messagesLoaded = true;
          chat.messageOffset ??= 0;
          chat.messageTotal ??= chat.message.length;
          chat.messagesFullyLoaded ??= chat.messageOffset === 0;
          chat.detailsLoaded = true;

          // Storage hydration is not a user edit. If this chat became active
          // before the async SQL read completed, refresh the persistence
          // baseline immediately so loaded metadata is never written straight
          // back to SQLite as a false-positive change.
          if (char && this.characters[this.selectedId] === char) {
            this.observeActive();
          }
        }
      } catch (error) {
        console.error(`[CharacterStore] loadChat failed for ${chatId}:`, error);
      } finally {
        this.chatDetailPromises.delete(chatId);
      }
    })();
    this.chatDetailPromises.set(chatId, promise);
    return promise;
  }

  async loadOlderChatMessages(chatId: string, limit = 60): Promise<number> {
    const currentPromise = this.olderChatPromises.get(chatId);
    if (currentPromise) return currentPromise;

    const storage = this.storage || (await getSqlStorage());
    const promise = (async () => {
      await this.ensureChatMessages(chatId);
      const char = this.characters.find((c) =>
        c.chats?.some((ch) => ch.id === chatId),
      );
      const chat = char?.chats?.find((ch) => ch.id === chatId);
      if (!chat || chat.messagesFullyLoaded !== false || !chat.messageOffset)
        return 0;

      const before = chat.messageOffset;
      const page = await storage.loadChatMessagePage(chatId, before, limit);
      const known = new Set(chat.message.map((m) => m.chatId).filter(Boolean));
      const older = page.messages.filter(
        (m) => !m.chatId || !known.has(m.chatId),
      );
      chat.message = older.concat(chat.message);
      chat.messageOffset = page.offset;
      chat.messageTotal = page.total;
      chat.messagesFullyLoaded = !page.hasMore;
      return older.length;
    })().finally(() => this.olderChatPromises.delete(chatId));

    this.olderChatPromises.set(chatId, promise);
    return promise;
  }

  dispose(): void {
    this.cancelScheduledTouchCommit();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.arrayDispose?.();
    this.arrayDispose = null;
    this.activeDispose?.();
    this.activeDispose = null;
    this.generationOnlyMetadataChats.clear();
  }
}

export const characterStore = new CharacterStore();
