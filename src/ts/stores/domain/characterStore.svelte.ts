import type { character, groupChat, Chat } from "../../storage/database/schema";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import { getSqlStorage } from "../../storage/sql/sqlStorageFactory";
import { v4 as uuidv4 } from "uuid";
import { sqlCharacterData, sqlChatData } from "../../storage/sql/sqlCommit";
import { settingsStore } from "./settingsStore.svelte";
import { getInitialChatLoadPages } from "../../chatLoadPages";
import { trackDeep, snapshotFingerprint } from "./reactiveUtils";
import { commitSqlChanges } from "../../storage/sql/sqlCommitCoordinator";
import { isCapacitor } from "../../platform";
import type { FlushableStore, InitializableStore } from "./storeContracts";

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

function mergeVariableRecord<T extends Record<string, unknown>>(
  loaded: T | undefined,
  current: T | undefined,
): T | undefined {
  if (loaded === undefined && current === undefined) return undefined;
  return { ...(loaded ?? {}), ...(current ?? {}) } as T;
}

type ChatVariableState = Pick<
  Chat,
  "scriptstate" | "GLGlobalVariables" | "useLocallySetGlobalVariables"
>;

function mergeLoadedChatVariables(
  target: Chat,
  loaded: ChatVariableState,
  current: ChatVariableState,
): void {
  const scriptstate = mergeVariableRecord(
    loaded.scriptstate,
    current.scriptstate,
  );
  const globalVariables = mergeVariableRecord(
    loaded.GLGlobalVariables,
    current.GLGlobalVariables,
  );

  if (scriptstate === undefined) delete target.scriptstate;
  else target.scriptstate = scriptstate;
  if (globalVariables === undefined) delete target.GLGlobalVariables;
  else target.GLGlobalVariables = globalVariables;
  const localGlobalVariableMode =
    current.useLocallySetGlobalVariables !== undefined
      ? current.useLocallySetGlobalVariables
      : loaded.useLocallySetGlobalVariables;
  if (localGlobalVariableMode === undefined) {
    delete target.useLocallySetGlobalVariables;
  } else {
    target.useLocallySetGlobalVariables = localGlobalVariableMode;
  }
}

function mergeLoadedChats(loaded: Chat[], current: Chat[]): Chat[] {
  if (current.length === 0) return loaded;

  const loadedById = new Map(
    loaded.filter((chat) => chat.id).map((chat) => [chat.id!, chat]),
  );
  const currentIds = new Set<string>();
  const merged = current.map((chat) => {
    if (!chat.id) return chat;
    currentIds.add(chat.id);
    const persisted = loadedById.get(chat.id);
    if (!persisted) return chat;
    const loadedVariableState: ChatVariableState = {
      scriptstate: persisted.scriptstate,
      GLGlobalVariables: persisted.GLGlobalVariables,
      useLocallySetGlobalVariables: persisted.useLocallySetGlobalVariables,
    };
    Object.assign(persisted, chat);
    mergeLoadedChatVariables(persisted, loadedVariableState, chat);
    return persisted;
  });

  for (const chat of loaded) {
    if (chat.id && !currentIds.has(chat.id)) merged.push(chat);
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

function toChatSummary(chat: Chat): Chat {
  return {
    id: chat.id,
    name: chat.name ?? "",
    note: chat.note ?? "",
    folderId: chat.folderId ?? undefined,
    lastDate: chat.lastDate ?? undefined,
    message: [],
    messagesLoaded: false,
    messagesFullyLoaded: false,
    detailsLoaded: false,
  } as Chat;
}

function toCharacterSummary(
  char: character | groupChat,
): character | groupChat {
  const chats = (char.chats ?? []).map(toChatSummary);
  const chatPage = Math.min(
    Math.max(char.chatPage ?? 0, 0),
    Math.max(chats.length - 1, 0),
  );
  const runtimeDates = char as unknown as {
    creationDate?: number;
    modificationDate?: number;
    creation_date?: number;
    modification_date?: number;
  };
  const creationDate = runtimeDates.creationDate ?? runtimeDates.creation_date;
  const modificationDate =
    runtimeDates.modificationDate ?? runtimeDates.modification_date;
  return {
    chaId: char.chaId,
    type: char.type ?? "character",
    name: char.name ?? "",
    image: char.image ?? "",
    trashTime: char.trashTime,
    creationDate,
    modificationDate,
    creation_date: creationDate,
    modification_date: modificationDate,
    lastInteraction: char.lastInteraction,
    coldstorage: char.coldstorage,
    coldStoragedChats: char.coldStoragedChats
      ? [...char.coldStoragedChats]
      : undefined,
    detailsLoaded: false,
    chats,
    chatPage,
  } as unknown as character | groupChat;
}

class CharacterStore
  implements
    InitializableStore<
      [characters: (character | groupChat)[], storage: ISqlStorage]
    >,
    FlushableStore
{
  private storage: ISqlStorage | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private touchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private touchIdleHandle: number | null = null;

  // Dirty sets — only IDs, no snapshots.  Serialised at flush time.
  private dirtyCharacters = new Set<string>();
  private dirtyCharacterDeletes = new Set<string>();
  private dirtyCharacterTouches = new Map<string, number>();
  private dirtyChats = new Set<string>();
  private dirtyChatDeletes = new Set<string>();
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
  private hydratedCharacterLru: string[] = [];
  private inactiveDetailReleaseGeneration = 0;

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

  private touchHydratedCharacter(chaId: string): void {
    const index = this.hydratedCharacterLru.indexOf(chaId);
    if (index >= 0) this.hydratedCharacterLru.splice(index, 1);
    this.hydratedCharacterLru.push(chaId);
  }

  init(characters: (character | groupChat)[], storage: ISqlStorage): void {
    this.storage = storage;
    this.cancelScheduledTouchCommit();
    this.arrayDispose?.();
    this.arrayDispose = null;
    this.activeDispose?.();
    this.activeDispose = null;
    this.dirtyCharacters.clear();
    this.dirtyCharacterDeletes.clear();
    this.dirtyCharacterTouches.clear();
    this.dirtyChats.clear();
    this.dirtyChatDeletes.clear();
    this.dirtyChatManifests.clear();
    this.generationOnlyMetadataChats.clear();
    this.hydratedCharacterLru = [];
    this.inactiveDetailReleaseGeneration += 1;
    this.dirtyCharacterIds = false;

    for (const char of characters) {
      char.chaId ||= uuidv4();
      if (char.detailsLoaded !== false) this.touchHydratedCharacter(char.chaId);
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
    let previousCharIds = new Set(knownCharIds);

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
        const currentCharIds = new Set(chars.map((c) => c.chaId));
        for (const id of previousCharIds) {
          if (!currentCharIds.has(id)) this.dirtyCharacterDeletes.add(id);
        }
        for (const id of currentCharIds) this.dirtyCharacterDeletes.delete(id);
        previousCharIds = currentCharIds;
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
      if (c && !c.id) c.id = uuidv4();
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
    let lastManifestKey = (char.chats ?? [])
      .map((c) => c?.id)
      .filter(Boolean)
      .join(",");
    const knownChatIds = new Set<string>(
      (char.chats ?? []).map((c) => c?.id).filter(Boolean) as string[],
    );
    let previousChatIds = new Set(knownChatIds);

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
        // A lazy summary is not authoritative for omitted metadata. In
        // particular, reading a variable must never turn an absent scriptstate
        // into a deletion that races the pending storage hydration.
        if (chat.detailsLoaded === false) {
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
          if (!c) continue;
          if (!c.id) c.id = uuidv4();
          if (!knownChatIds.has(c.id)) {
            knownChatIds.add(c.id);
            this.dirtyChats.add(c.id);
            added = true;
          }
        }
        const manifestKey = chats
          .map((c) => c?.id)
          .filter(Boolean)
          .join(",");
        const currentChatIds = new Set(
          chats.map((c) => c?.id).filter(Boolean) as string[],
        );
        for (const id of previousChatIds) {
          if (!currentChatIds.has(id)) this.dirtyChatDeletes.add(id);
        }
        for (const id of currentChatIds) this.dirtyChatDeletes.delete(id);
        previousChatIds = currentChatIds;
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
      this.dirtyCharacterDeletes.size === 0 &&
      this.dirtyCharacterTouches.size === 0 &&
      this.dirtyChats.size === 0 &&
      this.dirtyChatDeletes.size === 0 &&
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

    const characterDeletes = Array.from(this.dirtyCharacterDeletes).filter(
      (id) => !this.characters.some((character) => character.chaId === id),
    );

    // Serialise dirty chats
    const chats: {
      id: string;
      characterId: string;
      position: number;
      data: unknown;
    }[] = [];
    for (const chatId of this.dirtyChats) {
      for (const char of this.characters) {
        const chatIdx = char.chats?.findIndex((c) => c?.id === chatId);
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

    const chatDeletes = Array.from(this.dirtyChatDeletes).filter(
      (id) =>
        !this.characters.some((character) =>
          character.chats?.some((chat) => chat?.id === id),
        ),
    );

    // Chat manifests (chat list order per character)
    const chatManifests: { characterId: string; ids: string[] }[] = [];
    for (const chaId of this.dirtyChatManifests) {
      const char = this.characters.find((c) => c?.chaId === chaId);
      if (char?.chats) {
        chatManifests.push({
          characterId: chaId,
          ids: char.chats.map((c) => c?.id).filter(Boolean) as string[],
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
    const committedCharacterDeletes = new Set(characterDeletes);
    const committedTouches = new Map(this.dirtyCharacterTouches);
    const committedChatIds = new Set(this.dirtyChats);
    const committedChatDeletes = new Set(chatDeletes);
    const committedManifestIds = new Set(this.dirtyChatManifests);
    const committedCharacterOrder = this.dirtyCharacterIds;
    this.dirtyCharacters.clear();
    for (const id of committedCharacterDeletes)
      this.dirtyCharacterDeletes.delete(id);
    this.dirtyCharacterTouches.clear();
    this.dirtyChats.clear();
    for (const id of committedChatDeletes) this.dirtyChatDeletes.delete(id);
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
        characterDeletes,
        chats,
        chatManifests,
        chatDeletes,
        messages: [],
        messageManifests: [],
      });
    } catch (error) {
      for (const id of committedCharacterIds) {
        this.dirtyCharacterTouches.delete(id);
        this.dirtyCharacters.add(id);
      }
      for (const id of committedCharacterDeletes) {
        if (!this.characters.some((character) => character.chaId === id))
          this.dirtyCharacterDeletes.add(id);
      }
      for (const [id, timestamp] of committedTouches) {
        if (!this.dirtyCharacters.has(id)) {
          const current = this.dirtyCharacterTouches.get(id);
          this.dirtyCharacterTouches.set(id, Math.max(current ?? 0, timestamp));
        }
      }
      for (const id of committedChatIds) this.dirtyChats.add(id);
      for (const id of committedChatDeletes) {
        const stillAbsent = !this.characters.some((character) =>
          character.chats?.some((chat) => chat?.id === id),
        );
        if (stillAbsent) this.dirtyChatDeletes.add(id);
      }
      for (const id of committedManifestIds) this.dirtyChatManifests.add(id);
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
      this.dirtyCharacterDeletes.size > 0 ||
      this.dirtyCharacterTouches.size > 0 ||
      this.dirtyChats.size > 0 ||
      this.dirtyChatDeletes.size > 0 ||
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
    const char = this.characters[index];
    if (char?.chaId && char.detailsLoaded !== false) {
      this.touchHydratedCharacter(char.chaId);
    }
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
      const removedId = this.characters[index]?.chaId;
      this.characters.splice(index, 1);
      if (removedId) this.dirtyCharacterDeletes.add(removedId);
      this.dirtyCharacterIds = true;
      this.scheduleCommit();
      if (this.selectedId >= this.characters.length) {
        this.selectedId = this.characters.length - 1;
      }
      this.observeActive();
    }
  }

  private hasProtectedCharacterDetails(
    char: character | groupChat,
    protectedChatIds: ReadonlySet<string>,
  ): boolean {
    const chaId = char.chaId;
    if (!chaId) return true;
    if (
      this.dirtyCharacters.has(chaId) ||
      this.dirtyChatManifests.has(chaId) ||
      this.characterDetailPromises.has(chaId)
    ) {
      return true;
    }
    return (char.chats ?? []).some((chat) =>
      Boolean(
        chat.id &&
        (protectedChatIds.has(chat.id) ||
          chat.preventMessageCompaction ||
          this.dirtyChats.has(chat.id) ||
          this.chatDetailPromises.has(chat.id) ||
          this.olderChatPromises.has(chat.id)),
      ),
    );
  }

  cancelInactiveCharacterDetailRelease(): void {
    this.inactiveDetailReleaseGeneration += 1;
  }

  releaseInactiveCharacterDetails(
    getProtectedChatIds: () => ReadonlySet<string>,
  ): void {
    const generation = ++this.inactiveDetailReleaseGeneration;
    const batchSize = settingsStore.state.lowSpecMode ? 2 : isCapacitor ? 4 : 8;
    const warmCount = settingsStore.state.lowSpecMode ? 1 : isCapacitor ? 2 : 4;
    const scheduleIdle = (callback: () => void) => {
      if ("requestIdleCallback" in globalThis) {
        globalThis.requestIdleCallback(callback, { timeout: 2000 });
      } else {
        globalThis.setTimeout(callback, 0);
      }
    };

    scheduleIdle(() => {
      if (generation !== this.inactiveDetailReleaseGeneration) return;
      const protectedCharacterIds = new Set<string>();
      const protectedChats = getProtectedChatIds();
      const selected = this.characters[this.selectedId]?.chaId;
      if (selected) protectedCharacterIds.add(selected);

      for (const char of this.characters) {
        if (!char.chaId) continue;
        if (this.hasProtectedCharacterDetails(char, protectedChats)) {
          protectedCharacterIds.add(char.chaId);
        }
      }

      const warmIds = new Set(
        this.hydratedCharacterLru
          .filter((id) => !protectedCharacterIds.has(id))
          .slice(-warmCount),
      );
      const candidates = this.characters
        .filter(
          (char) =>
            char.chaId &&
            char.detailsLoaded !== false &&
            !protectedCharacterIds.has(char.chaId) &&
            !warmIds.has(char.chaId),
        )
        .map((char) => char.chaId!);

      let cursor = 0;
      const releaseBatch = () => {
        if (generation !== this.inactiveDetailReleaseGeneration) return;
        const protectedNow = getProtectedChatIds();
        const nextCursor = Math.min(cursor + batchSize, candidates.length);
        for (; cursor < nextCursor; cursor += 1) {
          const chaId = candidates[cursor];
          const index = this.characters.findIndex(
            (char) => char.chaId === chaId,
          );
          const char = this.characters[index];
          if (
            !char ||
            index === this.selectedId ||
            char.detailsLoaded === false
          )
            continue;
          if (this.hasProtectedCharacterDetails(char, protectedNow)) continue;

          for (const chat of char.chats ?? []) {
            if (chat.id) this.generationOnlyMetadataChats.delete(chat.id);
          }
          this.characters[index] = toCharacterSummary(char);
          this.hydratedCharacterLru = this.hydratedCharacterLru.filter(
            (id) => id !== chaId,
          );
        }
        if (cursor < candidates.length) scheduleIdle(releaseBatch);
      };
      releaseBatch();
    });
  }

  async ensureCharacterDetails(chaId: string): Promise<void> {
    this.cancelInactiveCharacterDetailRelease();
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
            const currentCharacter = this.characters[idx];
            const existingChats = currentCharacter.chats ?? [];
            const currentChatPage = currentCharacter.chatPage ?? 0;
            const activeChatId = existingChats[currentChatPage]?.id;
            const loadedChats = fullChar.chats ?? [];
            const mergedChats = mergeLoadedChats(loadedChats, existingChats);
            const activeChatIndex = activeChatId
              ? mergedChats.findIndex((chat) => chat.id === activeChatId)
              : -1;
            this.characters[idx] = Object.assign(currentCharacter, fullChar, {
              chats: mergedChats,
              chatPage:
                activeChatIndex >= 0
                  ? activeChatIndex
                  : Math.min(
                      currentChatPage,
                      Math.max(0, mergedChats.length - 1),
                    ),
              detailsLoaded: true,
            });
            this.touchHydratedCharacter(chaId);
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
      fullyLoaded
        ? undefined
        : { messageLimit: getInitialChatLoadPages(settingsStore.state) },
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
          const deferredVariableEdit =
            chat.detailsLoaded === false &&
            (chat.scriptstate !== undefined ||
              chat.GLGlobalVariables !== undefined ||
              chat.useLocallySetGlobalVariables !== undefined);
          const currentVariableState = {
            scriptstate: chat.scriptstate,
            GLGlobalVariables: chat.GLGlobalVariables,
            useLocallySetGlobalVariables: chat.useLocallySetGlobalVariables,
          } satisfies ChatVariableState;
          Object.assign(chat, fullChat);
          mergeLoadedChatVariables(chat, fullChat, currentVariableState);
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
          if (deferredVariableEdit) {
            this.dirtyChats.add(chatId);
            this.scheduleCommit();
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
    this.hydratedCharacterLru = [];
    this.inactiveDetailReleaseGeneration += 1;
  }
}

export const characterStore = new CharacterStore();
