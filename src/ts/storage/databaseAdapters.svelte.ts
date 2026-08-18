import type {
    Database,
    character,
    groupChat,
    RisuPersona,
    botPreset,
    loreBook,
    customscript,
} from './database.svelte'
import type { RisuModule } from '../process/modules'
import { defaultAutoSuggestPrompt, defaultJailbreak, defaultMainPrompt } from './defaultPrompts'
import type { NodePostgresStorage } from './nodePostgresStorage'
import { primeRootSetting } from './nodeDatabaseSync'

export interface IDatabaseAdapter extends Database {
    readonly isPostgres?: boolean
    ensureLoaded?: (domain?: string) => Promise<void>
    isDomainLoaded?: (domain: string) => boolean
    getLoadedDomains?: () => string[]
}

export interface LocalDatabaseAdapter extends Database {
    [key: string]: any
}

export class LocalDatabaseAdapter implements IDatabaseAdapter {
    readonly isPostgres = false

    constructor(data: Database) {
        Object.assign(this, data)
    }

    async ensureLoaded(_domain?: string): Promise<void> {
        return
    }

    isDomainLoaded(_domain: string): boolean {
        return true
    }

    getLoadedDomains(): string[] {
        return ['*']
    }
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
 * Creates a PostgreSQL-dedicated database adapter that handles on-demand domain loading,
 * ETag caching, Svelte 5 reactivity, and save protection.
 */
export function createPostgresDatabaseAdapter(
    initialData: Database,
    storage: NodePostgresStorage,
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

    async function triggerLoadDomain(domain: string): Promise<any> {
        if (loadingPromises.has(domain)) {
            return await loadingPromises.get(domain)
        }

        const promise = (async () => {
            try {
                switch (domain) {
                    case 'personas': {
                        const personas = await storage.loadPersonas()
                        internalState.personas = personas
                        internalState.loadedDomains.add('personas')
                        primeRootSetting(storage.getCache(), 'personas', personas)
                        return personas
                    }
                    case 'botPresets': {
                        const botPresets = await storage.loadBotPresets()
                        internalState.botPresets = botPresets
                        internalState.loadedDomains.add('botPresets')
                        primeRootSetting(storage.getCache(), 'botPresets', botPresets)
                        return botPresets
                    }
                    case 'loreBook': {
                        const loreBook = await storage.loadLorebooks()
                        internalState.loreBook = loreBook
                        internalState.loadedDomains.add('loreBook')
                        primeRootSetting(storage.getCache(), 'loreBook', loreBook)
                        return loreBook
                    }
                    case 'modules': {
                        const modules = await storage.loadModules()
                        internalState.modules = modules
                        internalState.loadedDomains.add('modules')
                        primeRootSetting(storage.getCache(), 'modules', modules)
                        return modules
                    }
                    case 'scripts': {
                        const globalscript = await storage.loadScripts()
                        internalState.globalscript = globalscript
                        internalState.loadedDomains.add('scripts')
                        primeRootSetting(storage.getCache(), 'globalscript', globalscript)
                        return globalscript
                    }
                    case 'prompts': {
                        const prompts = await storage.loadPrompts()
                        internalState.prompts = prompts
                        internalState.loadedDomains.add('prompts')
                        for (const [k, v] of Object.entries(prompts)) {
                            primeRootSetting(storage.getCache(), k, v)
                        }
                        return prompts
                    }
                    default:
                        return null
                }
            } catch (error) {
                console.error(`PostgreSQL loadDomain failed for '${domain}':`, error)
                return null
            } finally {
                loadingPromises.delete(domain)
            }
        })()

        loadingPromises.set(domain, promise)
        return await promise
    }

    const adapterTarget: any = {
        isPostgres: true,

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
            if (internalState.loadedDomains.has('personas')) keys.add('personas')
            if (internalState.loadedDomains.has('botPresets')) keys.add('botPresets')
            if (internalState.loadedDomains.has('loreBook')) keys.add('loreBook')
            if (internalState.loadedDomains.has('modules')) keys.add('modules')
            if (internalState.loadedDomains.has('scripts')) keys.add('globalscript')
            if (internalState.loadedDomains.has('prompts') && internalState.prompts) {
                for (const k of Object.keys(internalState.prompts)) keys.add(k)
            }
            return Array.from(keys)
        },

        getOwnPropertyDescriptor(target, prop) {
            if (prop in target) {
                return Reflect.getOwnPropertyDescriptor(target, prop)
            }
            if (typeof prop === 'string') {
                if (prop === 'personas' && internalState.loadedDomains.has('personas')) {
                    return { value: internalState.personas, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'botPresets' && internalState.loadedDomains.has('botPresets')) {
                    return { value: internalState.botPresets, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'loreBook' && internalState.loadedDomains.has('loreBook')) {
                    return { value: internalState.loreBook, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'modules' && internalState.loadedDomains.has('modules')) {
                    return { value: internalState.modules, writable: true, enumerable: true, configurable: true }
                }
                if (prop === 'globalscript' && internalState.loadedDomains.has('scripts')) {
                    return { value: internalState.globalscript, writable: true, enumerable: true, configurable: true }
                }
                if (PROMPT_SETTING_KEYS.includes(prop as any) && internalState.loadedDomains.has('prompts') && internalState.prompts) {
                    return { value: internalState.prompts[prop], writable: true, enumerable: true, configurable: true }
                }
            }
            return Reflect.getOwnPropertyDescriptor(internalState.coreData, prop)
        },
    })

    return proxy as IDatabaseAdapter
}
