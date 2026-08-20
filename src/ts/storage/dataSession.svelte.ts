import { v4 as uuidv4 } from 'uuid'
import type { Chat, Database, Message, character, groupChat } from './database.svelte'
import type { IDatabaseAdapter } from './databaseAdapters.svelte'
import type { ISqlStorage } from './ISqlStorage'
import {
    createEmptySqlCommit,
    buildSqlReplaceCommit,
    hasSqlCommitChanges,
    sqlCharacterData,
    sqlChatData,
    sqlMessageData,
    type SqlCharacterUpsert,
    type SqlChatUpsert,
    type SqlCommit,
    type SqlMessageUpsert,
} from './sqlCommit'
import { saving } from '../stores.svelte'
import { isMemoryConstrainedDevice } from '../memory/deviceMemory'

type Disposer = () => void

interface PendingChanges {
    rootUpserts: Map<string, unknown>
    rootDeletes: Set<string>
    characters: Map<string, SqlCharacterUpsert>
    characterIds?: string[]
    chats: Map<string, SqlChatUpsert>
    chatManifests: Map<string, string[]>
    messages: Map<string, SqlMessageUpsert>
    messageManifests: Map<string, string[]>
}

function pendingChanges(): PendingChanges {
    return {
        rootUpserts: new Map(),
        rootDeletes: new Set(),
        characters: new Map(),
        chats: new Map(),
        chatManifests: new Map(),
        messages: new Map(),
        messageManifests: new Map(),
    }
}

function snapshotWithout(value: Record<string, any>, excluded: Set<string>): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
        if (!excluded.has(key)) result[key] = $state.snapshot(value[key])
    }
    return result
}

function snapshotFingerprint(value: Record<string, unknown>): string {
    try {
        const serialized = JSON.stringify(value)
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

function trackDeep(value: unknown, seen = new WeakSet<object>()): void {
    if (!value || typeof value !== 'object' || seen.has(value as object)) return
    seen.add(value as object)
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Blob || value instanceof Date) return
    if (value instanceof Map) {
        for (const [key, item] of value) {
            trackDeep(key, seen)
            trackDeep(item, seen)
        }
        return
    }
    if (value instanceof Set) {
        for (const item of value) trackDeep(item, seen)
        return
    }
    for (const key of Object.keys(value)) trackDeep((value as Record<string, unknown>)[key], seen)
}

function trackWithout(value: Record<string, any>, excluded: Set<string>): void {
    for (const key of Object.keys(value)) {
        if (!excluded.has(key)) trackDeep(value[key])
    }
}

function messageKey(chatId: string, messageId: string): string {
    return `${chatId}\u0000${messageId}`
}

/**
 * The application data boundary. It owns the identity map already exposed to
 * Svelte and turns changes to loaded rows into bounded SQL commits. New code
 * should use the typed collections/commands below; row observers keep legacy
 * UI bindings correct during the cut-over without scanning the whole DB.
 */
export class DataSession {
    readonly database: Database
    readonly settings = {
        set: <K extends keyof Database>(key: K, value: Database[K]) => {
            this.database[key] = value
            this.queueRoot(String(key), $state.snapshot(value))
        },
        delete: (key: keyof Database) => {
            delete this.database[key]
            this.pending.rootUpserts.delete(String(key))
            this.pending.rootDeletes.add(String(key))
            this.scheduleFlush()
        },
    }
    readonly characters = {
        get: (id: string) => this.database.characters?.find((value) => value.chaId === id),
        update: (id: string, update: (value: character | groupChat) => void) => {
            const value = this.database.characters?.find((item) => item.chaId === id)
            if (!value) throw new Error(`Unknown character: ${id}`)
            update(value)
            this.queueCharacter(value)
        },
    }
    readonly chats = {
        get: (id: string) => this.findChat(id)?.chat,
        update: (id: string, update: (value: Chat) => void) => {
            const found = this.findChat(id)
            if (!found) throw new Error(`Unknown chat: ${id}`)
            update(found.chat)
            this.queueChat(found.character, found.chat)
        },
    }
    readonly commands = {
        appendMessage: (chatId: string, message: Message) => {
            const found = this.findChat(chatId)
            if (!found) throw new Error(`Unknown chat: ${chatId}`)
            message.chatId ||= uuidv4()
            found.chat.message ??= []
            found.chat.message.push(message)
            this.queueMessage(found.chat, message)
            this.queueMessageManifest(found.chat)
        },
        deleteMessage: (chatId: string, messageId: string) => {
            const found = this.findChat(chatId)
            if (!found) throw new Error(`Unknown chat: ${chatId}`)
            if (found.chat.messagesFullyLoaded === false) {
                throw new Error(`Chat must be fully loaded before deleting messages: ${chatId}`)
            }
            found.chat.message = (found.chat.message ?? []).filter((message) => message.chatId !== messageId)
            this.queueMessageManifest(found.chat)
        },
    }

    private revision: number
    private pending = pendingChanges()
    private flushTimer: ReturnType<typeof setTimeout> | null = null
    private flushPromise: Promise<void> | null = null
    private disposed = false
    private releaseRequestId = 0
    private compactionRequestIds = new Map<string, number>()
    private rootDispose: Disposer | null = null
    private rootWatchers = new Map<string, Disposer>()
    private characterWatchers = new Map<string, { value: character | groupChat, dispose: Disposer }>()
    private chatWatchers = new Map<string, { value: Chat, parentId: string, dispose: Disposer }>()
    private messageWatchers = new Map<string, { value: Message, chatId: string, dispose: Disposer }>()

    constructor(database: Database, private readonly storage: ISqlStorage) {
        this.database = database
        this.revision = storage.getRevision()
        this.observe()
        window.addEventListener('pagehide', this.handlePageHide)
        document.addEventListener('visibilitychange', this.handleVisibilityChange)
    }

    async transaction<T>(operation: (session: DataSession) => T | Promise<T>): Promise<T> {
        const result = await operation(this)
        await this.flush()
        return result
    }

    async flush(): Promise<void> {
        if (this.disposed) return
        if (this.flushTimer) {
            clearTimeout(this.flushTimer)
            this.flushTimer = null
        }
        if (this.flushPromise) {
            await this.flushPromise
            if (this.hasPending()) await this.flush()
            return
        }
        if (!this.hasPending()) return
        const batch = this.takePending()
        const commit = this.toCommit(batch)
        if (!hasSqlCommitChanges(commit)) return

        saving.state = true
        let conflicted = false
        this.flushPromise = this.storage.commit(commit).then((result) => {
            this.revision = result.revision
        }).catch((error) => {
            this.mergePending(batch)
            conflicted = error?.name === 'NodePostgresRevisionConflictError' || error?.name === 'SqlRevisionConflictError'
            if (!conflicted) this.scheduleFlush(1500)
            console.error('SQL DataSession commit failed:', error)
            if (conflicted) {
                void import('../alert').then(({ alertNormalWait }) =>
                    alertNormalWait('Database data changed in another tab. This tab will reload to prevent overwriting it.')
                ).then(() => location.reload())
            }
        }).finally(() => {
            saving.state = false
            this.flushPromise = null
            if (!conflicted && this.hasPending()) this.scheduleFlush()
        })
        return this.flushPromise
    }

    /**
     * Drops message bodies for chats that are no longer visible. SQL-backed
     * chats can hydrate them again on demand, so retaining every chat visited
     * during a session only grows the browser heap. Flush first so legacy
     * reactive edits have been snapshotted before their objects are released.
     */
    async releaseInactiveChatMessages(activeChatId?: string): Promise<void> {
        const requestId = ++this.releaseRequestId
        await this.flush()
        if (this.disposed || requestId !== this.releaseRequestId) return

        for (const character of this.database.characters ?? []) {
            for (const chat of character.chats ?? []) {
                if (!chat.id || chat.id === activeChatId || chat.messagesLoaded === false) continue

                for (const [key, watcher] of this.messageWatchers) {
                    if (watcher.chatId === chat.id) {
                        watcher.dispose()
                        this.messageWatchers.delete(key)
                    }
                }

                // Mark unloaded before clearing: the chat observer must not
                // interpret this memory eviction as deleting every message.
                chat.messagesLoaded = false
                chat.messageOffset = undefined
                chat.messageTotal = undefined
                chat.messagesFullyLoaded = false
                chat.message = []
            }
        }
    }

    async compactChatMessages(chatId: string, keep = isMemoryConstrainedDevice() ? 24 : 60): Promise<void> {
        const requestId = (this.compactionRequestIds.get(chatId) ?? 0) + 1
        this.compactionRequestIds.set(chatId, requestId)
        await this.flush()
        if (this.disposed || this.compactionRequestIds.get(chatId) !== requestId) return

        const found = this.findChat(chatId)
        const chat = found?.chat
        if (!chat || chat.preventMessageCompaction || chat.messagesFullyLoaded === false || chat.message.length <= keep) return

        const removed = chat.message.slice(0, -keep)
        const removedIds = new Set(removed.map((message) => message.chatId).filter(Boolean))
        for (const [key, watcher] of this.messageWatchers) {
            if (watcher.chatId === chatId && removedIds.has(watcher.value.chatId)) {
                watcher.dispose()
                this.messageWatchers.delete(key)
            }
        }

        const total = chat.message.length
        chat.message = chat.message.slice(-keep)
        chat.messageOffset = total - chat.message.length
        chat.messageTotal = total
        chat.messagesFullyLoaded = false
    }

    cancelChatMessageCompaction(chatId: string): void {
        this.compactionRequestIds.set(chatId, (this.compactionRequestIds.get(chatId) ?? 0) + 1)
    }

    dispose(): void {
        this.disposed = true
        if (this.flushTimer) clearTimeout(this.flushTimer)
        this.rootDispose?.()
        for (const dispose of this.rootWatchers.values()) dispose()
        for (const watcher of this.characterWatchers.values()) watcher.dispose()
        for (const watcher of this.chatWatchers.values()) watcher.dispose()
        for (const watcher of this.messageWatchers.values()) watcher.dispose()
        window.removeEventListener('pagehide', this.handlePageHide)
        document.removeEventListener('visibilitychange', this.handleVisibilityChange)
    }

    async replaceWith(database: Database): Promise<DataSession> {
        if (database === this.database) return this
        await this.flush()
        const result = await this.storage.commit(buildSqlReplaceCommit(database, this.revision))
        this.revision = result.revision
        this.dispose()
        return new DataSession(database, this.storage)
    }

    private observe(): void {
        let initialCharacters = true
        let initialRoots = true
        this.rootDispose = $effect.root(() => {
            $effect(() => {
                const keys = this.loadedRootKeys()
                const keySet = new Set(keys)
                for (const key of keys) {
                    this.watchRoot(key, !initialRoots && !this.rootWatchers.has(key))
                }
                for (const [key, dispose] of this.rootWatchers) {
                    if (!keySet.has(key)) {
                        dispose()
                        this.rootWatchers.delete(key)
                        if (!initialRoots) this.pending.rootDeletes.add(key)
                    }
                }
                initialRoots = false
            })

            $effect(() => {
                const characters = this.database.characters ?? []
                for (const value of characters) value.chaId ||= uuidv4()
                const ids = characters.map((value) => value.chaId)
                const current = new Set(ids)
                for (const value of characters) this.watchCharacter(value, !initialCharacters && !this.characterWatchers.has(value.chaId))
                for (const [id, watcher] of this.characterWatchers) {
                    if (!current.has(id)) {
                        watcher.dispose()
                        this.characterWatchers.delete(id)
                    }
                }
                if (!initialCharacters) {
                    this.pending.characterIds = [...ids]
                    for (const value of characters) this.queueCharacter(value)
                    this.scheduleFlush()
                }
                initialCharacters = false
            })
        })
    }

    private loadedRootKeys(): string[] {
        const adapter = this.database as IDatabaseAdapter
        const keys = adapter.getLoadedRootKeys?.() ?? Object.keys(this.database)
        return keys.filter((key) => key !== 'characters' && key !== 'isSql' &&
            key !== 'ensureLoaded' && key !== 'isDomainLoaded' && key !== 'getLoadedDomains' &&
            key !== 'getLoadedRootKeys' && key !== 'applyCoreDefaults' && key !== 'ensureCharacterDetails' && key !== 'ensureChatMessages' &&
            key !== 'loadOlderChatMessages')
    }

    private watchRoot(key: string, isNew: boolean): void {
        if (this.rootWatchers.has(key)) return
        let initial = true
        const dispose = $effect.root(() => {
            $effect(() => {
                const value = (this.database as any)[key]
                if (initial) {
                    trackDeep(value)
                    if (isNew) this.queueRoot(key, $state.snapshot(value))
                } else {
                    this.queueRoot(key, $state.snapshot(value))
                }
                initial = false
            })
        })
        this.rootWatchers.set(key, dispose)
    }

    private watchCharacter(value: character | groupChat, isNew: boolean): void {
        const id = value.chaId
        const previous = this.characterWatchers.get(id)
        if (previous?.value === value) return
        previous?.dispose()

        let initial = true
        let chatManifestInitial = true
        let previousChatIds: string[] = []
        let previousCharacterData = ''
        const dispose = $effect.root(() => {
            $effect(() => {
                if (value.detailsLoaded === false) return
                const data = snapshotWithout(value, new Set(['chats', 'chaId', 'detailsLoaded']))
                const fingerprint = snapshotFingerprint(data)
                if (initial) {
                    trackWithout(value, new Set(['chats', 'chaId', 'detailsLoaded']))
                    previousCharacterData = fingerprint
                    initial = false
                    return
                }
                if (fingerprint !== previousCharacterData) {
                    previousCharacterData = fingerprint
                    this.queueCharacterData(value, data)
                }
            })
            $effect(() => {
                const chats = value.chats ?? []
                for (const chat of chats) chat.id ||= uuidv4()
                const ids = chats.map((chat) => chat.id!)
                const manifestChanged = ids.length !== previousChatIds.length ||
                    ids.some((id, index) => id !== previousChatIds[index])
                const current = new Set(ids)
                for (const chat of chats) {
                    const shouldQueueAsNew = (isNew && chatManifestInitial) ||
                        (!chatManifestInitial && !this.chatWatchers.has(chat.id!))
                    this.watchChat(value, chat, shouldQueueAsNew)
                }
                for (const [chatId, watcher] of this.chatWatchers) {
                    if (watcher.parentId === id && !current.has(chatId)) {
                        watcher.dispose()
                        this.chatWatchers.delete(chatId)
                    }
                }
                if (!chatManifestInitial && manifestChanged) {
                    this.pending.chatManifests.set(id, [...ids])
                    this.scheduleFlush()
                }
                previousChatIds = [...ids]
                chatManifestInitial = false
            })
        })
        this.characterWatchers.set(id, { value, dispose })
        if (isNew) this.queueCharacter(value)
    }

    private watchChat(parent: character | groupChat, chat: Chat, isNew: boolean): void {
        const id = chat.id!
        const previous = this.chatWatchers.get(id)
        if (previous?.value === chat) return
        previous?.dispose()

        let initial = true
        let messagesWereLoaded = chat.messagesLoaded !== false
        let messagesWereFullyLoaded = chat.messagesFullyLoaded !== false
        let previousMessageOffset = chat.messageOffset ?? 0
        let messageManifestInitial = true
        let previousChatData = ''
        const transientChatKeys = new Set([
            'message', 'id', 'messagesLoaded', 'messageOffset', 'messageTotal',
            'messagesFullyLoaded', 'preventMessageCompaction', 'detailsLoaded',
        ])
        const dispose = $effect.root(() => {
            $effect(() => {
                const data = snapshotWithout(chat, transientChatKeys)
                const fingerprint = snapshotFingerprint(data)
                if (initial) {
                    trackWithout(chat, transientChatKeys)
                    previousChatData = fingerprint
                    initial = false
                    return
                }
                if (fingerprint !== previousChatData) {
                    previousChatData = fingerprint
                    this.queueChatData(parent, chat, data)
                }
            })
            $effect(() => {
                const loaded = chat.messagesLoaded !== false
                const fullyLoaded = chat.messagesFullyLoaded !== false
                const messageOffset = chat.messageOffset ?? 0
                const messages = loaded ? (chat.message ?? []) : []
                for (const message of messages) message.chatId ||= uuidv4()
                const ids = messages.map((message) => message.chatId!)
                const current = new Set(ids)
                if (loaded) {
                    const hydrating = !messagesWereLoaded || (messagesWereFullyLoaded !== fullyLoaded) ||
                        (!fullyLoaded && messageOffset < previousMessageOffset)
                    for (const message of messages) this.watchMessage(chat, message, isNew && messageManifestInitial)
                    for (const [key, watcher] of this.messageWatchers) {
                        if (watcher.chatId === id && !current.has(key.slice(id.length + 1))) {
                            watcher.dispose()
                            this.messageWatchers.delete(key)
                        }
                    }
                    if (!messageManifestInitial && !hydrating) {
                        if (fullyLoaded) this.pending.messageManifests.set(id, [...ids])
                        for (const message of messages) this.queueMessage(chat, message)
                        this.scheduleFlush()
                    }
                    messageManifestInitial = false
                }
                messagesWereLoaded = loaded
                messagesWereFullyLoaded = fullyLoaded
                previousMessageOffset = messageOffset
            })
        })
        this.chatWatchers.set(id, { value: chat, parentId: parent.chaId, dispose })
        if (isNew) this.queueChat(parent, chat)
    }

    private watchMessage(chat: Chat, message: Message, isNew: boolean): void {
        const key = messageKey(chat.id!, message.chatId!)
        const previous = this.messageWatchers.get(key)
        if (previous?.value === message) return
        previous?.dispose()
        let initial = true
        const dispose = $effect.root(() => {
            $effect(() => {
                const isStreaming = chat.isStreaming === true
                if (initial) {
                    trackWithout(message, new Set(['chatId']))
                    initial = false
                    return
                }
                const data = snapshotWithout(message, new Set(['chatId']))
                if (!isStreaming) this.queueMessageData(chat, message, data)
            })
        })
        this.messageWatchers.set(key, { value: message, chatId: chat.id!, dispose })
        if (isNew) this.queueMessage(chat, message)
    }

    private queueRoot(key: string, value: unknown): void {
        if (value === undefined) {
            this.pending.rootUpserts.delete(key)
            this.pending.rootDeletes.add(key)
            this.scheduleFlush()
            return
        }
        this.pending.rootDeletes.delete(key)
        this.pending.rootUpserts.set(key, value)
        this.scheduleFlush()
    }

    private queueCharacter(value: character | groupChat): void {
        this.queueCharacterData(value, sqlCharacterData(value))
    }

    private queueCharacterData(value: character | groupChat, data: unknown): void {
        const position = this.database.characters?.findIndex((item) => item.chaId === value.chaId) ?? -1
        if (position < 0) return
        this.pending.characters.set(value.chaId, { id: value.chaId, position, data })
        this.scheduleFlush()
    }

    private queueChat(parent: character | groupChat, chat: Chat): void {
        this.queueChatData(parent, chat, sqlChatData(chat))
    }

    private queueChatData(parent: character | groupChat, chat: Chat, data: unknown): void {
        const position = parent.chats?.findIndex((item) => item.id === chat.id) ?? -1
        if (position < 0) return
        this.pending.chats.set(chat.id!, { id: chat.id!, characterId: parent.chaId, position, data })
        this.scheduleFlush()
    }

    private queueMessage(chat: Chat, message: Message): void {
        this.queueMessageData(chat, message, sqlMessageData(message))
    }

    private queueMessageData(chat: Chat, message: Message, data: unknown): void {
        const localPosition = chat.message?.findIndex((item) => item.chatId === message.chatId) ?? -1
        if (localPosition < 0) return
        const position = (chat.messagesFullyLoaded === false ? (chat.messageOffset ?? 0) : 0) + localPosition
        const key = messageKey(chat.id!, message.chatId!)
        this.pending.messages.set(key, { id: message.chatId!, chatId: chat.id!, position, data })
        this.scheduleFlush()
    }

    private queueMessageManifest(chat: Chat): void {
        if (chat.messagesFullyLoaded === false) return
        this.pending.messageManifests.set(chat.id!, (chat.message ?? []).map((message) => message.chatId!))
        this.scheduleFlush()
    }

    private findChat(id: string): { character: character | groupChat, chat: Chat } | undefined {
        for (const character of this.database.characters ?? []) {
            const chat = character.chats?.find((value) => value.id === id)
            if (chat) return { character, chat }
        }
    }

    private scheduleFlush(delay = 350): void {
        if (this.disposed || this.flushTimer) return
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null
            void this.flush()
        }, delay)
    }

    private hasPending(): boolean {
        return this.pending.rootUpserts.size > 0 || this.pending.rootDeletes.size > 0 ||
            this.pending.characters.size > 0 || this.pending.characterIds !== undefined ||
            this.pending.chats.size > 0 || this.pending.chatManifests.size > 0 ||
            this.pending.messages.size > 0 || this.pending.messageManifests.size > 0
    }

    private takePending(): PendingChanges {
        const result = this.pending
        this.pending = pendingChanges()
        return result
    }

    private toCommit(batch: PendingChanges): SqlCommit {
        const commit = createEmptySqlCommit(this.revision)
        commit.idempotencyKey = uuidv4()
        commit.root.upserts = Array.from(batch.rootUpserts, ([key, value]) => ({ key, value }))
        commit.root.deletes = Array.from(batch.rootDeletes)
        commit.characters = Array.from(batch.characters.values())
        commit.characterIds = batch.characterIds
        commit.chats = Array.from(batch.chats.values())
        commit.chatManifests = Array.from(batch.chatManifests, ([characterId, ids]) => ({ characterId, ids }))
        commit.messages = Array.from(batch.messages.values())
        commit.messageManifests = Array.from(batch.messageManifests, ([chatId, ids]) => ({ chatId, ids }))
        return commit
    }

    private mergePending(batch: PendingChanges): void {
        for (const [key, value] of batch.rootUpserts) if (!this.pending.rootUpserts.has(key)) this.pending.rootUpserts.set(key, value)
        for (const key of batch.rootDeletes) if (!this.pending.rootUpserts.has(key)) this.pending.rootDeletes.add(key)
        for (const [key, value] of batch.characters) if (!this.pending.characters.has(key)) this.pending.characters.set(key, value)
        if (this.pending.characterIds === undefined) this.pending.characterIds = batch.characterIds
        for (const [key, value] of batch.chats) if (!this.pending.chats.has(key)) this.pending.chats.set(key, value)
        for (const [key, value] of batch.chatManifests) if (!this.pending.chatManifests.has(key)) this.pending.chatManifests.set(key, value)
        for (const [key, value] of batch.messages) if (!this.pending.messages.has(key)) this.pending.messages.set(key, value)
        for (const [key, value] of batch.messageManifests) if (!this.pending.messageManifests.has(key)) this.pending.messageManifests.set(key, value)
    }

    private handlePageHide = () => { void this.flush() }
    private handleVisibilityChange = () => {
        if (document.visibilityState === 'hidden') void this.flush()
    }
}

let activeDataSession: DataSession | null = null
let replacementQueue: Promise<void> = Promise.resolve()

export function startDataSession(database: Database, storage: ISqlStorage): DataSession {
    activeDataSession?.dispose()
    activeDataSession = new DataSession(database, storage)
    return activeDataSession
}

export function getDataSession(): DataSession {
    if (!activeDataSession) throw new Error('DataSession has not been started')
    return activeDataSession
}

export function replaceActiveDataSession(database: Database): Promise<void> {
    replacementQueue = replacementQueue.then(async () => {
        if (!activeDataSession || activeDataSession.database === database) return
        activeDataSession = await activeDataSession.replaceWith(database)
    })
    return replacementQueue
}

export async function flushDataSession(): Promise<void> {
    await activeDataSession?.flush()
}

export function releaseInactiveChatMessages(activeChatId?: string): void {
    void activeDataSession?.releaseInactiveChatMessages(activeChatId)
}

export function compactChatMessages(chatId: string): void {
    void activeDataSession?.compactChatMessages(chatId)
}

export function cancelChatMessageCompaction(chatId: string): void {
    activeDataSession?.cancelChatMessageCompaction(chatId)
}
