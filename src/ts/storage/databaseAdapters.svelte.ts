import type {
    Database,
    character,
    groupChat,
    Chat,
    RisuPersona,
    botPreset,
    loreBook,
    customscript,
} from './database.svelte'
import type { RisuModule } from '../process/modules'
import { defaultAutoSuggestPrompt, defaultJailbreak, defaultMainPrompt } from './defaultPrompts'
import type { ISqlStorage } from './ISqlStorage'

export interface IDatabaseAdapter extends Database {
    readonly isSql?: boolean
    ensureLoaded?: (domain?: string) => Promise<void>
    isDomainLoaded?: (domain: string) => boolean
    getLoadedDomains?: () => string[]
    getLoadedRootKeys?: () => string[]
}

export const POSTGRES_DOMAINS = [
    'personas',
    'botPresets',
    'loreBook',
    'modules',
    'prompts',
    'scripts',
] as const

export type PostgresDomainName = typeof POSTGRES_DOMAINS[number]

export const PROMPT_SETTING_KEYS = [
    'mainPrompt',
    'jailbreak',
    'globalNote',
    'additionalPrompt',
    'supaMemoryPrompt',
    'personaPrompt',
    'emotionPrompt',
    'emotionPrompt2',
    'autoSuggestPrompt',
    'translatorPrompt',
    'instructChatTemplate',
    'JinjaTemplate',
    'customTokenizer',
    'promptTemplate',
    'promptSettings',
    'customPromptTemplateToggle',
] as const

const fallbackBotPreset: botPreset = {
    name: 'Default',
    apiType: 'gemini-3-flash-preview',
    openAIKey: '',
    localNetworkMode: false,
    localNetworkTimeoutSec: 600,
    mainPrompt: defaultMainPrompt,
    jailbreak: defaultJailbreak,
    globalNote: '',
    temperature: 80,
    maxContext: 4000,
    maxResponse: 300,
    frequencyPenalty: 70,
    PresensePenalty: 70,
    formatingOrder: ['main', 'description', 'personaPrompt', 'chats', 'lastChat', 'jailbreak', 'lorebook', 'globalNote', 'authorNote'],
    aiModel: 'gemini-3-flash-preview',
    subModel: 'gemini-3-flash-preview',
    currentPluginProvider: '',
    textgenWebUIStreamURL: '',
    textgenWebUIBlockingURL: '',
    forceReplaceUrl: '',
    forceReplaceUrl2: '',
    promptPreprocess: false,
    proxyKey: '',
    bias: [],
    ooba: {
        mode: 'instruct',
        instruction_template: '',
        user_name: '',
        character_name: '',
    } as any,
    ainconfig: {
        model: 'kayra-v1',
        prefix: 'vanilla',
    } as any,
    reverseProxyOobaArgs: {
        mode: 'instruct',
    },
    top_p: 1,
    useInstructPrompt: false,
    verbosity: 1,
}

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
): IDatabaseAdapter {
    const internalState = $state<{
        personas: RisuPersona[] | null
        botPresets: botPreset[] | null
        loreBook: { name: string; data: loreBook[] }[] | null
        modules: RisuModule[] | null
        globalscript: customscript[] | null
        prompts: Record<string, any> | null
        loadedDomains: Set<string>
        coreData: Record<string, any>
    }>({
        personas: null,
        botPresets: null,
        loreBook: null,
        modules: null,
        globalscript: null,
        prompts: null,
        loadedDomains: new Set<string>(),
        coreData: { ...initialData },
    })

    const loadingPromises = new Map<string, Promise<any>>()

    // Check if initialData already contained any full domain (e.g. from shallow=false)
    if (initialData.personas && initialData.personas.length > 0) {
        internalState.personas = initialData.personas
        internalState.loadedDomains.add('personas')
    }
    if (initialData.botPresets && initialData.botPresets.length > 0) {
        internalState.botPresets = initialData.botPresets
        internalState.loadedDomains.add('botPresets')
    }
    if (initialData.loreBook && initialData.loreBook.length > 0) {
        internalState.loreBook = initialData.loreBook
        internalState.loadedDomains.add('loreBook')
    }
    if (initialData.modules && initialData.modules.length > 0) {
        internalState.modules = initialData.modules
        internalState.loadedDomains.add('modules')
    }
    if (initialData.globalscript && initialData.globalscript.length > 0) {
        internalState.globalscript = initialData.globalscript
        internalState.loadedDomains.add('scripts')
    }
    if (initialData.mainPrompt !== undefined) {
        internalState.prompts = {}
        for (const k of PROMPT_SETTING_KEYS) {
            if ((initialData as any)[k] !== undefined) {
                internalState.prompts[k] = (initialData as any)[k]
            }
        }
        internalState.loadedDomains.add('prompts')
    }

    // ── Character / chat detail loading ────────────────────────────────
    // Characters are stored in coreData as shallow metadata. When a specific
    // character is accessed for full detail, `loadCharacter` is triggered and
    // the shallow entry is replaced with the full one. Likewise for chat
    // messages via `loadChat`.

    const characterDetailPromises = new Map<string, Promise<void>>()
    const chatDetailPromises = new Map<string, Promise<void>>()

    async function ensureCharacterDetails(chaId: string): Promise<void> {
        if (characterDetailPromises.has(chaId)) {
            return characterDetailPromises.get(chaId)
        }
        const promise = (async () => {
            try {
                const fullChar = await storage.loadCharacter(chaId)
                if (fullChar) {
                    const chars = internalState.coreData.characters as (character | groupChat)[]
                    const idx = chars.findIndex((c) => c.chaId === chaId)
                    if (idx >= 0) {
                        const existingChats = chars[idx].chats
                        chars[idx] = Object.assign(chars[idx], fullChar, {
                            chats: existingChats,
                            detailsLoaded: true,
                        })
                    }
                }
            } catch (error) {
                console.error(`SQL loadCharacter failed for ${chaId}:`, error)
            } finally {
                characterDetailPromises.delete(chaId)
            }
        })()
        characterDetailPromises.set(chaId, promise)
        return promise
    }

    async function ensureChatMessages(chatId: string): Promise<void> {
        if (chatDetailPromises.has(chatId)) {
            return chatDetailPromises.get(chatId)
        }
        const promise = (async () => {
            try {
                const fullChat = await storage.loadChat(chatId)
                if (fullChat) {
                    const chars = internalState.coreData.characters as (character | groupChat)[]
                    for (const char of chars) {
                        if (!char?.chats) continue
                        const chatIdx = char.chats.findIndex((c) => c.id === chatId)
                        if (chatIdx >= 0) {
                            Object.assign(char.chats[chatIdx], fullChat)
                            char.chats[chatIdx].messagesLoaded = true
                            char.chats[chatIdx].detailsLoaded = true
                            break
                        }
                    }
                }
            } catch (error) {
                console.error(`SQL loadChat failed for ${chatId}:`, error)
            } finally {
                chatDetailPromises.delete(chatId)
            }
        })()
        chatDetailPromises.set(chatId, promise)
        return promise
    }

    async function triggerLoadDomain(domain: string): Promise<any> {
        if (loadingPromises.has(domain)) {
            return await loadingPromises.get(domain)
        }

        const promise = (async () => {
            try {
                switch (domain) {
                    case 'personas': {
                        const personas = await storage.loadPersonas()
                        const mappedPersonas = (personas && personas.length > 0) ? personas.map((p) => ({
                            ...p,
                            largePortrait: p.largePortrait ?? false,
                        })) : [{
                            name: internalState.coreData.username || 'User',
                            icon: internalState.coreData.userIcon || '',
                            personaPrompt: '',
                            note: internalState.coreData.userNote || '',
                            largePortrait: false,
                        }]
                        internalState.personas = mappedPersonas
                        internalState.loadedDomains.add('personas')
                        return internalState.personas
                    }
                    case 'botPresets': {
                        const botPresets = await storage.loadBotPresets()
                        internalState.botPresets = botPresets
                        internalState.loadedDomains.add('botPresets')
                        return botPresets
                    }
                    case 'loreBook': {
                        const loreBook = await storage.loadLorebooks()
                        internalState.loreBook = loreBook
                        internalState.loadedDomains.add('loreBook')
                        return loreBook
                    }
                    case 'modules': {
                        const modules = await storage.loadModules()
                        internalState.modules = modules
                        internalState.loadedDomains.add('modules')
                        return modules
                    }
                    case 'scripts': {
                        const globalscript = await storage.loadScripts()
                        internalState.globalscript = globalscript
                        internalState.loadedDomains.add('scripts')
                        return globalscript
                    }
                    case 'prompts': {
                        const prompts = await storage.loadPrompts()
                        internalState.prompts = prompts
                        internalState.loadedDomains.add('prompts')
                        return prompts
                    }
                    default:
                        return null
                }
            } catch (error) {
                console.error(`SQL loadDomain failed for '${domain}':`, error)
                return null
            } finally {
                loadingPromises.delete(domain)
            }
        })()

        loadingPromises.set(domain, promise)
        return await promise
    }

    const adapterTarget: any = {
        isSql: true,

        async ensureLoaded(domain?: string): Promise<void> {
            if (!domain) {
                await Promise.all([
                    triggerLoadDomain('personas'),
                    triggerLoadDomain('botPresets'),
                    triggerLoadDomain('loreBook'),
                    triggerLoadDomain('modules'),
                    triggerLoadDomain('prompts'),
                    triggerLoadDomain('scripts'),
                ])
                return
            }
            await triggerLoadDomain(domain)
        },

        isDomainLoaded(domain: string): boolean {
            return internalState.loadedDomains.has(domain)
        },

        getLoadedDomains(): string[] {
            return Array.from(internalState.loadedDomains)
        },

        getLoadedRootKeys(): string[] {
            const keys = new Set(Object.keys(internalState.coreData))
            if (internalState.loadedDomains.has('personas')) keys.add('personas')
            if (internalState.loadedDomains.has('botPresets')) keys.add('botPresets')
            if (internalState.loadedDomains.has('loreBook')) keys.add('loreBook')
            if (internalState.loadedDomains.has('modules')) keys.add('modules')
            if (internalState.loadedDomains.has('scripts')) keys.add('globalscript')
            if (internalState.loadedDomains.has('prompts')) {
                for (const key of PROMPT_SETTING_KEYS) keys.add(key)
            }
            return Array.from(keys)
        },
    }

    const proxy = new Proxy(adapterTarget, {
        get(target, prop, receiver) {
            if (typeof prop === 'symbol') {
                return Reflect.get(target, prop, receiver)
            }
            if (prop in target) {
                return target[prop]
            }

            // Deferred domain: personas
            if (prop === 'personas') {
                if (!internalState.loadedDomains.has('personas')) {
                    if (internalState.personas === null) {
                        internalState.personas = [{
                            name: internalState.coreData.username || 'User',
                            icon: internalState.coreData.userIcon || '',
                            personaPrompt: '',
                            note: internalState.coreData.userNote || '',
                            largePortrait: false,
                        }]
                        triggerLoadDomain('personas')
                    }
                }
                if (!internalState.personas || internalState.personas.length === 0) {
                    internalState.personas = [{
                        name: internalState.coreData.username || 'User',
                        icon: internalState.coreData.userIcon || '',
                        personaPrompt: '',
                        note: internalState.coreData.userNote || '',
                        largePortrait: false,
                    }]
                }
                return internalState.personas
            }

            // Deferred domain: botPresets
            if (prop === 'botPresets') {
                if (!internalState.loadedDomains.has('botPresets')) {
                    if (internalState.botPresets === null) {
                        internalState.botPresets = [{ ...fallbackBotPreset }]
                        triggerLoadDomain('botPresets')
                    }
                }
                return internalState.botPresets
            }

            // Deferred domain: loreBook
            if (prop === 'loreBook') {
                if (!internalState.loadedDomains.has('loreBook')) {
                    if (internalState.loreBook === null) {
                        internalState.loreBook = [{ name: 'Default', data: [] }]
                        triggerLoadDomain('loreBook')
                    }
                }
                return internalState.loreBook
            }

            // Deferred domain: modules
            if (prop === 'modules') {
                if (!internalState.loadedDomains.has('modules')) {
                    if (internalState.modules === null) {
                        internalState.modules = []
                        triggerLoadDomain('modules')
                    }
                }
                return internalState.modules
            }

            // Deferred domain: globalscript
            if (prop === 'globalscript') {
                if (!internalState.loadedDomains.has('scripts')) {
                    if (internalState.globalscript === null) {
                        internalState.globalscript = []
                        triggerLoadDomain('scripts')
                    }
                }
                return internalState.globalscript
            }

            // Deferred domain: prompts
            if (PROMPT_SETTING_KEYS.includes(prop as any)) {
                if (!internalState.loadedDomains.has('prompts')) {
                    if (internalState.prompts === null) {
                        internalState.prompts = {
                            mainPrompt: defaultMainPrompt,
                            jailbreak: defaultJailbreak,
                            globalNote: '',
                            additionalPrompt: 'The assistant must act as {{char}}. user is {{user}}.',
                            supaMemoryPrompt: '',
                            personaPrompt: '',
                            emotionPrompt: '',
                            emotionPrompt2: '',
                            autoSuggestPrompt: defaultAutoSuggestPrompt,
                            translatorPrompt: '',
                            instructChatTemplate: '',
                            JinjaTemplate: '',
                            customTokenizer: '',
                            promptTemplate: undefined,
                            promptSettings: undefined,
                            customPromptTemplateToggle: '',
                        }
                        triggerLoadDomain('prompts')
                    }
                }
                if (internalState.prompts && (prop in internalState.prompts)) {
                    return internalState.prompts[prop]
                }
            }

            return internalState.coreData[prop]
        },

        set(target, prop, value, receiver) {
            if (typeof prop === 'symbol') {
                return Reflect.set(target, prop, value, receiver)
            }
            if (prop in target) {
                target[prop] = value
                return true
            }

            if (prop === 'personas') {
                internalState.personas = value
                internalState.loadedDomains.add('personas')
                return true
            }
            if (prop === 'botPresets') {
                internalState.botPresets = value
                internalState.loadedDomains.add('botPresets')
                return true
            }
            if (prop === 'loreBook') {
                internalState.loreBook = value
                internalState.loadedDomains.add('loreBook')
                return true
            }
            if (prop === 'modules') {
                internalState.modules = value
                internalState.loadedDomains.add('modules')
                return true
            }
            if (prop === 'globalscript') {
                internalState.globalscript = value
                internalState.loadedDomains.add('scripts')
                return true
            }
            if (PROMPT_SETTING_KEYS.includes(prop as any)) {
                internalState.prompts ??= {}
                internalState.prompts[prop] = value
                internalState.loadedDomains.add('prompts')
                return true
            }

            internalState.coreData[prop] = value
            return true
        },

        has(target, prop) {
            if (prop in target) return true
            if (prop === 'personas') return true
            if (prop === 'botPresets') return true
            if (prop === 'loreBook') return true
            if (prop === 'modules') return true
            if (prop === 'globalscript') return true
            if (typeof prop === 'string' && PROMPT_SETTING_KEYS.includes(prop as any)) return true
            return prop in internalState.coreData
        },

        ownKeys(target) {
            const keys = new Set<string>([...Object.keys(target), ...Object.keys(internalState.coreData)])
            keys.add('personas')
            keys.add('botPresets')
            keys.add('loreBook')
            keys.add('modules')
            keys.add('globalscript')
            for (const k of PROMPT_SETTING_KEYS) {
                keys.add(k)
            }
            return Array.from(keys)
        },

        getOwnPropertyDescriptor(target, prop) {
            if (prop in target) {
                return Reflect.getOwnPropertyDescriptor(target, prop)
            }
            if (typeof prop === 'string') {
                if (prop === 'personas') {
                    return { value: (proxy as any).personas, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'botPresets') {
                    return { value: (proxy as any).botPresets, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'loreBook') {
                    return { value: (proxy as any).loreBook, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'modules') {
                    return { value: (proxy as any).modules, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'globalscript') {
                    return { value: (proxy as any).globalscript, writable: true, enumerable: true, configurable: true }
                }
                if (PROMPT_SETTING_KEYS.includes(prop as any)) {
                    return { value: (proxy as any)[prop], writable: true, enumerable: true, configurable: true }
                }
            }
            return Reflect.getOwnPropertyDescriptor(internalState.coreData, prop)
        },
    })

    // Expose lazy loaders on the adapter for external use (e.g. characters.ts)
    ;(proxy as any).ensureCharacterDetails = ensureCharacterDetails
    ;(proxy as any).ensureChatMessages = ensureChatMessages

    return proxy as IDatabaseAdapter
}
