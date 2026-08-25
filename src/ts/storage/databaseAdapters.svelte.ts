import type {
  Database,
  character,
  groupChat,
  Chat,
  RisuPersona,
  botPreset,
  loreBook,
  customscript,
} from "./database.svelte";
import type { RisuModule } from "../process/modules";
import {
  defaultAutoSuggestPrompt,
  defaultJailbreak,
  defaultMainPrompt,
} from "./defaultPrompts";
import type { ISqlStorage } from "./ISqlStorage";
import { cancelChatMessageCompaction } from "../stores/domain/messageStore.svelte";

export interface IDatabaseAdapter extends Database {
  readonly isSql?: boolean;
  ensureLoaded?: (domain?: string) => Promise<void>;
  isDomainLoaded?: (domain: string) => boolean;
  getLoadedDomains?: () => string[];
  getLoadedRootKeys?: () => string[];
  applyCoreDefaults?: (normalize: (coreData: Database) => Database) => void;
  ensureCharacterDetails?: (characterId: string) => Promise<void>;
  ensureChatMessages?: (
    chatId: string,
    options?: { full?: boolean },
  ) => Promise<void>;
  loadOlderChatMessages?: (chatId: string, limit?: number) => Promise<number>;
}

export const POSTGRES_DOMAINS = [
  "personas",
  "loreBook",
  "modules",
  "prompts",
  "scripts",
] as const;

export type PostgresDomainName = (typeof POSTGRES_DOMAINS)[number];

export const PROMPT_SETTING_KEYS = [
  "mainPrompt",
  "jailbreak",
  "globalNote",
  "additionalPrompt",
  "supaMemoryPrompt",
  "personaPrompt",
  "emotionPrompt",
  "emotionPrompt2",
  "autoSuggestPrompt",
  "translatorPrompt",
  "instructChatTemplate",
  "JinjaTemplate",
  "customTokenizer",
  "promptTemplate",
  "promptSettings",
  "customPromptTemplateToggle",
] as const;

const fallbackBotPreset: botPreset = {
  name: "Default",
  apiType: "gemini-3-flash-preview",
  openAIKey: "",
  localNetworkMode: false,
  localNetworkTimeoutSec: 600,
  mainPrompt: defaultMainPrompt,
  jailbreak: defaultJailbreak,
  globalNote: "",
  temperature: 80,
  maxContext: 4000,
  maxResponse: 300,
  frequencyPenalty: 70,
  PresensePenalty: 70,
  formatingOrder: [
    "main",
    "description",
    "personaPrompt",
    "chats",
    "lastChat",
    "jailbreak",
    "lorebook",
    "globalNote",
    "authorNote",
  ],
  aiModel: "gemini-3-flash-preview",
  subModel: "gemini-3-flash-preview",
  currentPluginProvider: "",
  textgenWebUIStreamURL: "",
  textgenWebUIBlockingURL: "",
  forceReplaceUrl: "",
  forceReplaceUrl2: "",
  promptPreprocess: false,
  proxyKey: "",
  bias: [],
  ooba: {
    mode: "instruct",
    instruction_template: "",
    user_name: "",
    character_name: "",
  } as any,
  ainconfig: {
    model: "kayra-v1",
    prefix: "vanilla",
  } as any,
  reverseProxyOobaArgs: {
    mode: "instruct",
  },
  top_p: 1,
  useInstructPrompt: false,
  verbosity: 1,
};

interface DomainConfig {
  domainName: PostgresDomainName;
  getDefault: (coreData: Record<string, any>) => any;
  normalizeInitial?: (val: any) => any;
}

const DEFERRED_DOMAINS: Record<string, DomainConfig> = {
  personas: {
    domainName: "personas",
    getDefault: (core) => [
      {
        name: core.username || "User",
        icon: core.userIcon || "",
        personaPrompt: "",
        note: core.userNote || "",
        largePortrait: false,
      },
    ],
    normalizeInitial: (personas) =>
      (personas ?? []).map((persona: any) => ({
        ...persona,
        largePortrait: persona?.largePortrait ?? false,
      })),
  },
  loreBook: {
    domainName: "loreBook",
    getDefault: () => [{ name: "Default", data: [] }],
    normalizeInitial: (val) => val ?? [],
  },
  modules: {
    domainName: "modules",
    getDefault: () => [],
    normalizeInitial: (val) => val ?? [],
  },
  globalscript: {
    domainName: "scripts",
    getDefault: () => [],
    normalizeInitial: (val) => val ?? [],
  },
};

/**
 * Creates a SQL-backed database adapter that handles on-demand domain loading,
 * Svelte 5 reactivity, character/chat/message lazy loading, and save protection.
 *
 * Works with any {@link ISqlStorage} backend (Node server, web SQLite WASM,
 * Tauri SQLite).
 */
export function createSqlDatabaseAdapter(
  initialData: Database,
  storage: ISqlStorage,
  initialLoadedDomains: readonly PostgresDomainName[] = [],
): IDatabaseAdapter {
  const coreData = { ...initialData } as Record<string, any>;
  for (const key of [
    ...Object.keys(DEFERRED_DOMAINS),
    ...PROMPT_SETTING_KEYS,
  ]) {
    delete coreData[key];
  }
  let promptDefaults: Record<string, any> = {
    mainPrompt: defaultMainPrompt,
    jailbreak: defaultJailbreak,
    globalNote: "",
    additionalPrompt: "The assistant must act as {{char}}. user is {{user}}.",
    supaMemoryPrompt: "",
    personaPrompt: "",
    emotionPrompt: "",
    emotionPrompt2: "",
    autoSuggestPrompt: defaultAutoSuggestPrompt,
    translatorPrompt: "",
    instructChatTemplate: "",
    JinjaTemplate: "",
    customTokenizer: "",
    promptTemplate: [],
    promptSettings: {
      assistantPrefill: "",
      postEndInnerFormat: "",
      sendChatAsSystem: false,
      sendName: false,
      utilOverride: false,
      customChainOfThought: false,
      maxThoughtTagDepth: -1,
    },
    customPromptTemplateToggle: "",
  };

  const internalState = $state<{
    personas: RisuPersona[] | null;
    loreBook: { name: string; data: loreBook[] }[] | null;
    modules: RisuModule[] | null;
    globalscript: customscript[] | null;
    prompts: Record<string, any> | null;
    loadedDomains: Set<string>;
    coreData: Record<string, any>;
  }>({
    personas: null,
    loreBook: null,
    modules: null,
    globalscript: null,
    prompts: null,
    loadedDomains: new Set<string>(),
    coreData,
  });

  const loadingPromises = new Map<string, Promise<any>>();

  const wasInitiallyLoaded = (domain: PostgresDomainName, key: string) =>
    initialLoadedDomains.includes(domain) ||
    Object.prototype.hasOwnProperty.call(initialData, key);

  for (const [key, config] of Object.entries(DEFERRED_DOMAINS)) {
    if (wasInitiallyLoaded(config.domainName, key)) {
      const raw = (initialData as any)[key];
      (internalState as any)[key] = config.normalizeInitial
        ? config.normalizeInitial(raw)
        : raw;
      internalState.loadedDomains.add(config.domainName);
    }
  }
  if (
    initialLoadedDomains.includes("prompts") ||
    PROMPT_SETTING_KEYS.some((key) =>
      Object.prototype.hasOwnProperty.call(initialData, key),
    )
  ) {
    internalState.prompts = {};
    for (const k of PROMPT_SETTING_KEYS) {
      if ((initialData as any)[k] !== undefined) {
        internalState.prompts[k] = (initialData as any)[k];
      }
    }
    internalState.loadedDomains.add("prompts");
  }

  // ── Character / chat detail loading ────────────────────────────────
  // Characters are stored in coreData as shallow metadata. When a specific
  // character is accessed for full detail, `loadCharacter` is triggered and
  // the shallow entry is replaced with the full one. Likewise for chat
  // messages via `loadChat`.

  const characterDetailPromises = new Map<string, Promise<void>>();
  const chatDetailPromises = new Map<string, Promise<void>>();
  const olderChatPromises = new Map<string, Promise<number>>();
  const initialMessagePageSize = initialData.lowSpecMode ? 24 : 60;

  function findChat(chatId: string): Chat | undefined {
    const chars = internalState.coreData.characters as (
      character | groupChat
    )[];
    for (const char of chars) {
      const chat = char?.chats?.find((value) => value.id === chatId);
      if (chat) return chat;
    }
  }

  async function ensureCharacterDetails(chaId: string): Promise<void> {
    if (characterDetailPromises.has(chaId)) {
      return characterDetailPromises.get(chaId);
    }
    const promise = (async () => {
      try {
        const fullChar = await storage.loadCharacter(chaId);
        if (fullChar) {
          const chars = internalState.coreData.characters as (
            character | groupChat
          )[];
          const idx = chars.findIndex((c) => c.chaId === chaId);
          if (idx >= 0) {
            const existingChats = chars[idx].chats;
            chars[idx] = Object.assign(chars[idx], fullChar, {
              chats: existingChats,
              detailsLoaded: true,
            });
          }
        }
      } catch (error) {
        console.error(`SQL loadCharacter failed for ${chaId}:`, error);
      } finally {
        characterDetailPromises.delete(chaId);
      }
    })();
    characterDetailPromises.set(chaId, promise);
    return promise;
  }

  async function ensureChatMessages(
    chatId: string,
    options: { full?: boolean } = {},
  ): Promise<void> {
    cancelChatMessageCompaction(chatId);
    const existing = findChat(chatId);
    if (
      existing?.messagesLoaded !== false &&
      existing?.detailsLoaded !== false &&
      (!options.full || existing.messagesFullyLoaded !== false)
    )
      return;

    if (chatDetailPromises.has(chatId)) {
      await chatDetailPromises.get(chatId);
      if (options.full && findChat(chatId)?.messagesFullyLoaded === false) {
        await ensureChatMessages(chatId, options);
      }
      return;
    }
    const promise = (async () => {
      try {
        const current = findChat(chatId);
        if (
          options.full &&
          current?.detailsLoaded !== false &&
          current?.messagesLoaded !== false
        ) {
          const messages = await storage.loadChatMessages(chatId);
          current.message = messages;
          current.messageOffset = 0;
          current.messageTotal = messages.length;
          current.messagesFullyLoaded = true;
          return;
        }

        const fullChat = await storage.loadChat(
          chatId,
          options.full ? undefined : { messageLimit: initialMessagePageSize },
        );
        if (fullChat) {
          const chars = internalState.coreData.characters as (
            character | groupChat
          )[];
          for (const char of chars) {
            if (!char?.chats) continue;
            const chatIdx = char.chats.findIndex((c) => c.id === chatId);
            if (chatIdx >= 0) {
              Object.assign(char.chats[chatIdx], fullChat);
              char.chats[chatIdx].messagesLoaded = true;
              char.chats[chatIdx].messageOffset ??= 0;
              char.chats[chatIdx].messageTotal ??=
                char.chats[chatIdx].message.length;
              char.chats[chatIdx].messagesFullyLoaded ??=
                char.chats[chatIdx].messageOffset === 0;
              char.chats[chatIdx].detailsLoaded = true;
              break;
            }
          }
        }
      } catch (error) {
        console.error(`SQL loadChat failed for ${chatId}:`, error);
      } finally {
        chatDetailPromises.delete(chatId);
      }
    })();
    chatDetailPromises.set(chatId, promise);
    return promise;
  }

  async function loadOlderChatMessages(
    chatId: string,
    limit = initialMessagePageSize,
  ): Promise<number> {
    const currentPromise = olderChatPromises.get(chatId);
    if (currentPromise) return currentPromise;

    const promise = (async () => {
      await ensureChatMessages(chatId);
      const chat = findChat(chatId);
      if (!chat || chat.messagesFullyLoaded !== false || !chat.messageOffset)
        return 0;

      const before = chat.messageOffset;
      const page = await storage.loadChatMessagePage(chatId, before, limit);
      if (findChat(chatId) !== chat || chat.messageOffset !== before) return 0;

      const known = new Set(
        chat.message.map((message) => message.chatId).filter(Boolean),
      );
      const older = page.messages.filter(
        (message) => !message.chatId || !known.has(message.chatId),
      );
      chat.message = older.concat(chat.message);
      chat.messageOffset = page.offset;
      chat.messageTotal = page.total;
      chat.messagesFullyLoaded = !page.hasMore;
      return older.length;
    })().finally(() => olderChatPromises.delete(chatId));

    olderChatPromises.set(chatId, promise);
    return promise;
  }

  async function triggerLoadDomain(domain: string): Promise<any> {
    if (internalState.loadedDomains.has(domain)) return null;
    if (loadingPromises.has(domain)) {
      return await loadingPromises.get(domain);
    }

    const promise = (async () => {
      try {
        switch (domain) {
          case "personas": {
            const personas = await storage.loadPersonas();
            const mappedPersonas =
              personas && personas.length > 0
                ? personas.map((p) => ({
                    ...p,
                    largePortrait: p.largePortrait ?? false,
                  }))
                : [
                    {
                      name: internalState.coreData.username || "User",
                      icon: internalState.coreData.userIcon || "",
                      personaPrompt: "",
                      note: internalState.coreData.userNote || "",
                      largePortrait: false,
                    },
                  ];
            internalState.personas = mappedPersonas;
            internalState.loadedDomains.add("personas");
            return internalState.personas;
          }
          case "loreBook": {
            const loreBook = await storage.loadLorebooks();
            internalState.loreBook = loreBook;
            internalState.loadedDomains.add("loreBook");
            return loreBook;
          }
          case "modules": {
            const modules = await storage.loadModules();
            internalState.modules = modules;
            const moduleFolders = (await storage.loadSettingKey("moduleFolders")) ?? [];
            internalState.coreData.moduleFolders = moduleFolders;
            internalState.loadedDomains.add("modules");
            return modules;
          }
          case "scripts": {
            const globalscript = await storage.loadScripts();
            internalState.globalscript = globalscript;
            internalState.loadedDomains.add("scripts");
            return globalscript;
          }
          case "prompts": {
            const prompts = await storage.loadPrompts();
            internalState.prompts = { ...promptDefaults, ...prompts };
            internalState.loadedDomains.add("prompts");
            return prompts;
          }
          default:
            return null;
        }
      } catch (error) {
        console.error(`SQL loadDomain failed for '${domain}':`, error);
        return null;
      } finally {
        loadingPromises.delete(domain);
      }
    })();

    loadingPromises.set(domain, promise);
    return await promise;
  }

  const adapterTarget: any = {
    isSql: true,

    applyCoreDefaults(normalize: (coreData: Database) => Database): void {
      normalize(internalState.coreData as Database);
      promptDefaults = Object.fromEntries(
        PROMPT_SETTING_KEYS.map((key) => [key, internalState.coreData[key]]),
      );
      if (internalState.prompts) {
        internalState.prompts = { ...promptDefaults, ...internalState.prompts };
      }
      for (const key of [
        ...Object.keys(DEFERRED_DOMAINS),
        ...PROMPT_SETTING_KEYS,
      ]) {
        delete internalState.coreData[key];
      }
    },

    async ensureLoaded(domain?: string): Promise<void> {
      if (!domain) {
        const domainNames = Array.from(
          new Set(Object.values(DEFERRED_DOMAINS).map((d) => d.domainName)),
        );
        await Promise.all([
          ...domainNames.map((d) => triggerLoadDomain(d)),
          triggerLoadDomain("prompts"),
        ]);
        return;
      }
      await triggerLoadDomain(domain);
    },

    isDomainLoaded(domain: string): boolean {
      return internalState.loadedDomains.has(domain);
    },

    getLoadedDomains(): string[] {
      return Array.from(internalState.loadedDomains);
    },

    getLoadedRootKeys(): string[] {
      const keys = new Set(Object.keys(internalState.coreData));
      for (const [key, config] of Object.entries(DEFERRED_DOMAINS)) {
        if (internalState.loadedDomains.has(config.domainName)) keys.add(key);
      }
      if (internalState.loadedDomains.has("prompts")) {
        for (const key of PROMPT_SETTING_KEYS) keys.add(key);
      }
      return Array.from(keys);
    },
  };

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingUpserts = new Map<string, unknown>();
  const pendingDeletes = new Set<string>();

  function scheduleCommit() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (pendingUpserts.size === 0 && pendingDeletes.size === 0) return;
      const upserts = Array.from(pendingUpserts.entries()).map(
        ([key, value]) => ({ key, value }),
      );
      const deletes = Array.from(pendingDeletes);
      pendingUpserts.clear();
      pendingDeletes.clear();
      try {
        await storage.commit({
          baseRevision: storage.getRevision(),
          action: "settings",
          root: { upserts, deletes },
          characters: [],
          chats: [],
          chatManifests: [],
          messages: [],
          messageManifests: [],
        });
      } catch (error) {
        console.error(
          "[createSqlDatabaseAdapter] Failed to commit root changes:",
          error,
        );
      }
    }, 300);
  }

  const proxy = new Proxy(adapterTarget, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.get(target, prop, receiver);
      }
      if (prop in target) {
        return target[prop];
      }

      const domainConfig = DEFERRED_DOMAINS[prop as string];
      if (domainConfig) {
        const domainKey = prop as string;
        if (!internalState.loadedDomains.has(domainConfig.domainName)) {
          if ((internalState as any)[domainKey] === null) {
            (internalState as any)[domainKey] = domainConfig.getDefault(
              internalState.coreData,
            );
            triggerLoadDomain(domainConfig.domainName);
          }
        }
        if (
          domainKey === "personas" &&
          (!(internalState as any).personas ||
            (internalState as any).personas.length === 0)
        ) {
          (internalState as any).personas = domainConfig.getDefault(
            internalState.coreData,
          );
        }
        return (internalState as any)[domainKey];
      }

      if (PROMPT_SETTING_KEYS.includes(prop as any)) {
        if (!internalState.loadedDomains.has("prompts")) {
          if (internalState.prompts === null) {
            internalState.prompts = { ...promptDefaults };
            triggerLoadDomain("prompts");
          }
        }
        if (internalState.prompts && prop in internalState.prompts) {
          return internalState.prompts[prop];
        }
      }

      return internalState.coreData[prop];
    },

    set(target, prop, value, receiver) {
      if (typeof prop === "symbol") {
        return Reflect.set(target, prop, value, receiver);
      }
      if (prop in target) {
        target[prop] = value;
        return true;
      }

      const propStr = String(prop);
      pendingDeletes.delete(propStr);

      const domainConfig = DEFERRED_DOMAINS[propStr];
      if (domainConfig) {
        (internalState as any)[propStr] = value;
        internalState.loadedDomains.add(domainConfig.domainName);
        pendingUpserts.set(propStr, value);
        scheduleCommit();
        return true;
      }

      if (PROMPT_SETTING_KEYS.includes(prop as any)) {
        internalState.prompts ??= {};
        internalState.prompts[prop] = value;
        internalState.loadedDomains.add("prompts");
        pendingUpserts.set(propStr, value);
        scheduleCommit();
        return true;
      }

      internalState.coreData[prop] = value;
      pendingUpserts.set(propStr, value);
      scheduleCommit();
      return true;
    },

    deleteProperty(target, prop) {
      if (typeof prop === "symbol") {
        return Reflect.deleteProperty(target, prop);
      }
      const propStr = String(prop);
      if (prop in target) {
        delete target[prop];
      }
      if (prop in internalState.coreData) {
        delete internalState.coreData[prop];
      }
      pendingUpserts.delete(propStr);
      pendingDeletes.add(propStr);
      scheduleCommit();
      return true;
    },

    has(target, prop) {
      if (prop in target) return true;
      if (
        typeof prop === "string" &&
        (prop in DEFERRED_DOMAINS || PROMPT_SETTING_KEYS.includes(prop as any))
      )
        return true;
      return prop in internalState.coreData;
    },

    ownKeys(target) {
      const keys = new Set<string>([
        ...Object.keys(target),
        ...Object.keys(internalState.coreData),
        ...Object.keys(DEFERRED_DOMAINS),
        ...PROMPT_SETTING_KEYS,
      ]);
      return Array.from(keys);
    },

    getOwnPropertyDescriptor(target, prop) {
      if (prop in target) {
        return Reflect.getOwnPropertyDescriptor(target, prop);
      }
      if (
        typeof prop === "string" &&
        (prop in DEFERRED_DOMAINS || PROMPT_SETTING_KEYS.includes(prop as any))
      ) {
        return {
          value: (proxy as any)[prop],
          writable: true,
          enumerable: true,
          configurable: true,
        };
      }
      return Reflect.getOwnPropertyDescriptor(internalState.coreData, prop);
    },
  });

  // Expose lazy loaders on the adapter for external use (e.g. characters.ts)
  (proxy as any).ensureCharacterDetails = ensureCharacterDetails;
  (proxy as any).ensureChatMessages = ensureChatMessages;
  (proxy as any).loadOlderChatMessages = loadOlderChatMessages;

  return proxy as IDatabaseAdapter;
}
