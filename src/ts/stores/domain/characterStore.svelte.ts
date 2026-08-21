import type { character, groupChat, Chat } from '../../storage/database.svelte'
import type { ISqlStorage } from '../../storage/ISqlStorage'
import { getSqlStorage } from '../../storage/sqlStorageFactory'
import { v4 as uuidv4 } from 'uuid'
import { sqlCharacterData, sqlChatData } from '../../storage/sqlCommit'
import { isMemoryConstrainedDevice } from '../../memory/deviceMemory'

function snapshotFingerprint(value: unknown): string {
    try {
        const serialized = JSON.stringify(value)
        if (!serialized) return ''
        let hash = 2166136261
        for (let index = 0; index < serialized.length; index++) {
            hash ^= serialized.charCodeAt(index)
            hash = Math.imul(hash, 16777619)
        }
        return `${serialized.length}:${hash >>> 0}`
    } catch {
        return ''
    }
}

class CharacterStore {
    private storage: ISqlStorage | null = null
    private debounceTimer: ReturnType<typeof setTimeout> | null = null
    private pendingCharacters = new Map<string, { id: string; position: number; data: unknown }>()
    private pendingCharacterIds: string[] | undefined = undefined
    private pendingChats = new Map<string, { id: string; characterId: string; position: number; data: unknown }>()
    private pendingChatManifests = new Map<string, string[]>()
    private rootDispose: (() => void) | null = null
    private characterFingerprints = new Map<string, string>()
    private chatFingerprints = new Map<string, string>()
    private chatManifestFingerprints = new Map<string, string>()
    private charIdsFingerprint = ''
    private characterDetailPromises = new Map<string, Promise<void>>()
    private chatDetailPromises = new Map<string, Promise<void>>()
    private olderChatPromises = new Map<string, Promise<number>>()

    characters = $state<(character | groupChat)[]>([])
    selectedId = $state<number>(-1)

    get currentCharacter(): (character | groupChat) | undefined {
        return this.characters[this.selectedId]
    }

    get currentChat(): Chat | undefined {
        const char = this.currentCharacter
        if (!char || !char.chats) return undefined
        return char.chats[char.chatPage ?? 0]
    }

    init(characters: (character | groupChat)[], storage: ISqlStorage): void {
        this.storage = storage
        this.rootDispose?.()
        this.characterFingerprints.clear()
        this.chatFingerprints.clear()
        this.chatManifestFingerprints.clear()
        this.pendingCharacters.clear()
        this.pendingChats.clear()
        this.pendingChatManifests.clear()
        this.pendingCharacterIds = undefined

        for (const char of characters) {
            char.chaId ||= uuidv4()
            for (const chat of char.chats ?? []) {
                chat.id ||= uuidv4()
            }
        }
        this.charIdsFingerprint = characters.map((c) => c.chaId).join(',')
        this.characters = characters
        this.observe()
    }

    private observe(): void {
        let initial = true
        this.rootDispose = $effect.root(() => {
            $effect(() => {
                const chars = this.characters
                const currentCharIds = chars.map((c) => c.chaId || '').join(',')
                let anyChanges = false

                for (let i = 0; i < chars.length; i++) {
                    const char = chars[i]
                    char.chaId ||= uuidv4()
                    const charData = sqlCharacterData($state.snapshot(char))
                    const charFp = snapshotFingerprint(charData)

                    if (initial) {
                        this.characterFingerprints.set(char.chaId, charFp)
                    } else {
                        const prevCharFp = this.characterFingerprints.get(char.chaId)
                        if (prevCharFp !== charFp) {
                            this.characterFingerprints.set(char.chaId, charFp)
                            this.pendingCharacters.set(char.chaId, {
                                id: char.chaId,
                                position: i,
                                data: charData,
                            })
                            anyChanges = true
                        }
                    }

                    const chats = char.chats ?? []
                    const chatIds = chats.map((c) => c.id || '')
                    const manifestKey = chatIds.join(',')

                    if (initial) {
                        this.chatManifestFingerprints.set(char.chaId, manifestKey)
                    } else {
                        const prevManifest = this.chatManifestFingerprints.get(char.chaId)
                        if (prevManifest !== manifestKey) {
                            this.chatManifestFingerprints.set(char.chaId, manifestKey)
                            this.pendingChatManifests.set(char.chaId, chatIds.filter(Boolean))
                            anyChanges = true
                        }
                    }

                    for (let j = 0; j < chats.length; j++) {
                        const chat = chats[j]
                        chat.id ||= uuidv4()
                        const chatData = sqlChatData($state.snapshot(chat))
                        const chatFp = snapshotFingerprint(chatData)

                        if (initial) {
                            this.chatFingerprints.set(chat.id, chatFp)
                        } else {
                            const prevChatFp = this.chatFingerprints.get(chat.id)
                            if (prevChatFp !== chatFp) {
                                this.chatFingerprints.set(chat.id, chatFp)
                                this.pendingChats.set(chat.id, {
                                    id: chat.id,
                                    characterId: char.chaId,
                                    position: j,
                                    data: chatData,
                                })
                                anyChanges = true
                            }
                        }
                    }
                }

                if (!initial) {
                    if (currentCharIds !== this.charIdsFingerprint) {
                        this.charIdsFingerprint = currentCharIds
                        this.pendingCharacterIds = chars.map((c) => c.chaId)
                        anyChanges = true
                    }
                    if (anyChanges) {
                        this.scheduleCommit()
                    }
                } else {
                    this.charIdsFingerprint = currentCharIds
                }
                initial = false
            })
        })
    }

    private scheduleCommit(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
        }
        this.debounceTimer = setTimeout(() => {
            void this.flush()
        }, 300)
    }

    async flush(): Promise<void> {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
        if (
            this.pendingCharacters.size === 0 &&
            this.pendingCharacterIds === undefined &&
            this.pendingChats.size === 0 &&
            this.pendingChatManifests.size === 0
        ) {
            return
        }

        const storage = this.storage || await getSqlStorage()
        const characters = Array.from(this.pendingCharacters.values())
        const characterIds = this.pendingCharacterIds
        const chats = Array.from(this.pendingChats.values())
        const chatManifests = Array.from(this.pendingChatManifests.entries()).map(([characterId, ids]) => ({ characterId, ids }))

        let action = 'character'
        if (this.pendingCharacters.size > 0) {
            action = 'character'
        } else if (this.pendingChats.size > 0 || this.pendingChatManifests.size > 0) {
            action = 'chat'
        } else if (this.pendingCharacterIds !== undefined) {
            action = 'order'
        }

        this.pendingCharacters.clear()
        this.pendingCharacterIds = undefined
        this.pendingChats.clear()
        this.pendingChatManifests.clear()

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
            })
        } catch (error) {
            console.error('[CharacterStore] Failed to commit character changes to SQL storage:', error)
        }
    }

    get(index: number, options?: { snapshot?: boolean }): (character | groupChat) | undefined {
        const char = this.characters[index]
        if (!char) return undefined
        return options?.snapshot ? ($state.snapshot(char) as (character | groupChat)) : char
    }

    getById(id: string): (character | groupChat) | undefined {
        return this.characters.find((c) => c.chaId === id)
    }

    getCurrentCharacter(options?: { snapshot?: boolean }): (character | groupChat) | undefined {
        return this.get(this.selectedId, options)
    }

    setCurrentCharacter(char: character | groupChat): void {
        if (this.selectedId >= 0 && this.selectedId < this.characters.length) {
            this.characters[this.selectedId] = char
        }
    }

    getCharacterByIndex(index: number, options?: { snapshot?: boolean }): (character | groupChat) | undefined {
        return this.get(index, options)
    }

    setCharacterByIndex(index: number, char: character | groupChat): void {
        this.characters[index] = char
    }

    getCurrentChat(): Chat | undefined {
        return this.currentChat
    }

    setCurrentChat(chat: Chat): void {
        const char = this.currentCharacter
        if (char && char.chats) {
            char.chats[char.chatPage ?? 0] = chat
        }
    }

    select(index: number): void {
        this.selectedId = index
    }

    add(char: character | groupChat): number {
        char.chaId ||= uuidv4()
        this.characters.push(char)
        return this.characters.length - 1
    }

    remove(index: number): void {
        if (index >= 0 && index < this.characters.length) {
            this.characters.splice(index, 1)
            if (this.selectedId >= this.characters.length) {
                this.selectedId = this.characters.length - 1
            }
        }
    }

    async ensureCharacterDetails(chaId: string): Promise<void> {
        if (this.characterDetailPromises.has(chaId)) {
            return this.characterDetailPromises.get(chaId)
        }
        const storage = this.storage || await getSqlStorage()
        const promise = (async () => {
            try {
                const fullChar = await storage.loadCharacter(chaId)
                if (fullChar) {
                    const idx = this.characters.findIndex((c) => c.chaId === chaId)
                    if (idx >= 0) {
                        const existingChats = this.characters[idx].chats
                        this.characters[idx] = Object.assign(this.characters[idx], fullChar, {
                            chats: existingChats,
                            detailsLoaded: true,
                        })
                        this.characterFingerprints.set(chaId, snapshotFingerprint(sqlCharacterData(this.characters[idx])))
                    }
                }
            } catch (error) {
                console.error(`[CharacterStore] loadCharacter failed for ${chaId}:`, error)
            } finally {
                this.characterDetailPromises.delete(chaId)
            }
        })()
        this.characterDetailPromises.set(chaId, promise)
        return promise
    }

    async ensureChatMessages(chatId: string, options: { full?: boolean } = {}): Promise<void> {
        const initialMessagePageSize = isMemoryConstrainedDevice() ? 24 : 60
        const char = this.characters.find((c) => c.chats?.some((ch) => ch.id === chatId))
        const chat = char?.chats?.find((ch) => ch.id === chatId)
        if (
            chat?.messagesLoaded !== false &&
            chat?.detailsLoaded !== false &&
            (!options.full || chat.messagesFullyLoaded !== false)
        ) {
            return
        }

        if (this.chatDetailPromises.has(chatId)) {
            await this.chatDetailPromises.get(chatId)
            return
        }

        const storage = this.storage || await getSqlStorage()
        const promise = (async () => {
            try {
                const fullChat = await storage.loadChat(
                    chatId,
                    options.full ? undefined : { messageLimit: initialMessagePageSize },
                )
                if (fullChat && chat) {
                    Object.assign(chat, fullChat)
                    chat.messagesLoaded = true
                    chat.messageOffset ??= 0
                    chat.messageTotal ??= chat.message.length
                    chat.messagesFullyLoaded ??= chat.messageOffset === 0
                    chat.detailsLoaded = true
                    this.chatFingerprints.set(chatId, snapshotFingerprint(sqlChatData(chat)))
                }
            } catch (error) {
                console.error(`[CharacterStore] loadChat failed for ${chatId}:`, error)
            } finally {
                this.chatDetailPromises.delete(chatId)
            }
        })()
        this.chatDetailPromises.set(chatId, promise)
        return promise
    }

    async loadOlderChatMessages(chatId: string, limit = 60): Promise<number> {
        const currentPromise = this.olderChatPromises.get(chatId)
        if (currentPromise) return currentPromise

        const storage = this.storage || await getSqlStorage()
        const promise = (async () => {
            await this.ensureChatMessages(chatId)
            const char = this.characters.find((c) => c.chats?.some((ch) => ch.id === chatId))
            const chat = char?.chats?.find((ch) => ch.id === chatId)
            if (!chat || chat.messagesFullyLoaded !== false || !chat.messageOffset) return 0

            const before = chat.messageOffset
            const page = await storage.loadChatMessagePage(chatId, before, limit)
            const known = new Set(chat.message.map((m) => m.chatId).filter(Boolean))
            const older = page.messages.filter((m) => !m.chatId || !known.has(m.chatId))
            chat.message = older.concat(chat.message)
            chat.messageOffset = page.offset
            chat.messageTotal = page.total
            chat.messagesFullyLoaded = !page.hasMore
            return older.length
        })().finally(() => this.olderChatPromises.delete(chatId))

        this.olderChatPromises.set(chatId, promise)
        return promise
    }

    dispose(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
        this.rootDispose?.()
        this.rootDispose = null
    }
}

export const characterStore = new CharacterStore()
