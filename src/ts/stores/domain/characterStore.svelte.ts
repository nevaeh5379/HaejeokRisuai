import type { character, groupChat, Chat } from "../../storage/database.svelte";
import type { ISqlStorage } from "../../storage/ISqlStorage";
import { getSqlStorage } from "../../storage/sqlStorageFactory";
import { v4 as uuidv4 } from "uuid";
import { sqlCharacterData, sqlChatData } from "../../storage/sqlCommit";
import { settingsStore } from "./settingsStore.svelte";
import { trackDeep, snapshotFingerprint } from "./reactiveUtils";

class CharacterStore {
  private storage: ISqlStorage | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Dirty sets — only IDs, no snapshots.  Serialised at flush time.
  private dirtyCharacters = new Set<string>();
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
    this.arrayDispose?.();
    this.arrayDispose = null;
    this.activeDispose?.();
    this.activeDispose = null;
    this.dirtyCharacters.clear();
    this.dirtyChats.clear();
    this.dirtyChatManifests.clear();
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

    // Synchronous baselines taken at observe time.  The first (async) effect
    // run compares against these so mutations occurring between observe and
    // the first flush are still detected; later runs mark unconditionally.
    const charBaseline = snapshotFingerprint(
      sqlCharacterData($state.snapshot(char)),
    );
    const activeChatAtObserve = char.chats?.[char.chatPage ?? 0];
    const chatBaselineId = activeChatAtObserve?.id;
    const chatBaselineFp =
      activeChatAtObserve && activeChatAtObserve.id !== undefined
        ? snapshotFingerprint(sqlChatData($state.snapshot(activeChatAtObserve)))
        : "";
    const manifestBaseline = (char.chats ?? []).map((c) => c.id).join(",");
    // Chats already known to storage when observation started; additions get marked
    const knownChatIds = new Set<string>((char.chats ?? []).map((c) => c.id));

    let charInitial = true;
    let manifestInitial = true;
    // Deduplicates chat switches: only mutations to the *same* chat count as changes
    let lastChatId: string | undefined = undefined;

    this.activeDispose = $effect.root(() => {
      // Track active character property changes
      $effect(() => {
        trackDeep(char);
        if (charInitial) {
          charInitial = false;
          if (
            snapshotFingerprint(sqlCharacterData($state.snapshot(char))) !==
            charBaseline
          ) {
            this.dirtyCharacters.add(char.chaId);
            this.scheduleCommit();
          }
          return;
        }
        this.dirtyCharacters.add(char.chaId);
        this.scheduleCommit();
      });

      // Track active chat (follows chatPage) property changes
      $effect(() => {
        const chat = char.chats?.[char.chatPage ?? 0];
        if (!chat) return;
        trackDeep(chat);
        if (lastChatId === undefined && chat.id === chatBaselineId) {
          // First observation of the baseline chat — compare against observe-time state
          lastChatId = chat.id;
          if (
            chatBaselineFp !== "" &&
            snapshotFingerprint(sqlChatData($state.snapshot(chat))) !==
              chatBaselineFp
          ) {
            this.dirtyChats.add(chat.id);
            this.scheduleCommit();
          }
          return;
        }
        const isSameChat = lastChatId === chat.id;
        lastChatId = chat.id;
        if (!isSameChat) return;
        this.dirtyChats.add(chat.id);
        this.scheduleCommit();
      });

      // Track chat list structural changes (add/remove/reorder).
      // Also assigns ids to newly added chats (legacy observe-loop duty)
      // and marks added chats so their metadata rows get persisted.
      $effect(() => {
        const chats = char.chats ?? [];
        let added = false;
        for (const c of chats) {
          if (!c.id) {
            c.id = uuidv4();
          }
          if (!knownChatIds.has(c.id)) {
            knownChatIds.add(c.id);
            this.dirtyChats.add(c.id);
            added = true;
          }
        }
        if (manifestInitial) {
          manifestInitial = false;
          const manifestKey = chats.map((c) => c.id).join(",");
          if (manifestKey !== manifestBaseline || added) {
            this.dirtyChatManifests.add(char.chaId);
            this.scheduleCommit();
          }
          return;
        }
        this.dirtyChatManifests.add(char.chaId);
        this.scheduleCommit();
      });
    });
  }

  // ── Explicit dirty marking for non-active characters/chats ───────

  markCharacterDirty(chaId: string): void {
    this.dirtyCharacters.add(chaId);
    this.scheduleCommit();
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

  private scheduleCommit(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, 300);
  }

  async flush(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (
      this.dirtyCharacters.size === 0 &&
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
    } else if (characterIds !== undefined) {
      action = "order";
    }

    this.dirtyCharacters.clear();
    this.dirtyChats.clear();
    this.dirtyChatManifests.clear();
    this.dirtyCharacterIds = false;

    try {
      await storage.commit({
        baseRevision: storage.getRevision(),
        action,
        root: { upserts: [], deletes: [] },
        characters,
        characterIds,
        chats,
        chatManifests,
        messages: [],
        messageManifests: [],
      });
    } catch (error) {
      console.error(
        "[CharacterStore] Failed to commit character changes to SQL storage:",
        error,
      );
    }
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
        const fullChar = await storage.loadCharacter(chaId);
        if (fullChar) {
          const idx = this.characters.findIndex((c) => c.chaId === chaId);
          if (idx >= 0) {
            const existingChats = this.characters[idx].chats;
            this.characters[idx] = Object.assign(
              this.characters[idx],
              fullChar,
              {
                chats: existingChats,
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

  async ensureChatMessages(
    chatId: string,
    options: { full?: boolean; generation?: boolean } = {},
  ): Promise<void> {
    const initialMessagePageSize = settingsStore.state.lowSpecMode ? 12 : 60;
    const char = this.characters.find((c) =>
      c.chats?.some((ch) => ch.id === chatId),
    );
    const chat = char?.chats?.find((ch) => ch.id === chatId);
    if (
      chat?.messagesLoaded !== false &&
      chat?.detailsLoaded !== false &&
      (!options.full || chat.messagesFullyLoaded !== false)
    ) {
      return;
    }

    if (this.chatDetailPromises.has(chatId)) {
      await this.chatDetailPromises.get(chatId);
      if (options.full && chat?.messagesFullyLoaded === false) {
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
          if (options.generation && previousMessages.length > 0) {
            const previousById = new Map(
              previousMessages
                .filter((message) => message.chatId)
                .map((message) => [message.chatId!, message]),
            );
            chat.message = messages.map((message) => {
              const previous = message.chatId
                ? previousById.get(message.chatId)
                : undefined;
              return previous ? { ...message, ...previous } : message;
            });
          } else {
            chat.message = messages;
          }
          chat.messageOffset = 0;
          chat.messageTotal = chat.message.length;
          chat.messagesFullyLoaded = true;
          chat.messagesLoaded = true;
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
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.arrayDispose?.();
    this.arrayDispose = null;
    this.activeDispose?.();
    this.activeDispose = null;
  }
}

export const characterStore = new CharacterStore();
