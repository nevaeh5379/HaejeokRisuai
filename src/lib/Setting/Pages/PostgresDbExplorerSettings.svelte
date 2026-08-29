<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import {
        RefreshCwIcon,
        SettingsIcon,
        TableIcon,
        XIcon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import { NodeStorage } from 'src/ts/storage/nodeStorage'
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte'
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte'
    import { moduleStore } from 'src/ts/stores/domain/moduleStore.svelte'
    import { getMimeType } from 'src/ts/media'
    import DbExplorerTabNav from './DbExplorer/DbExplorerTabNav.svelte'
    import DbTableExplorerTab from './DbExplorer/tabs/DbTableExplorerTab.svelte'
    import DbConfigTab from './DbExplorer/tabs/DbConfigTab.svelte'
    import DbStatsTab from './DbExplorer/tabs/DbStatsTab.svelte'
    import DbHistoryTab from './DbExplorer/tabs/DbHistoryTab.svelte'
    import type {
        BotChatStats,
        DbExplorerTabType,
        DbOverallStats
    } from './DbExplorer/types'
    import type {
        NodePostgresRevision,
        NodePostgresTableInfo,
        NodePostgresTokenUsage,
    } from 'src/ts/storage/nodePostgresStorage'

    interface Props {
        close?: () => void
    }

    let { close = () => {} }: Props = $props()

    let currentTab = $state<DbExplorerTabType>('tables')
    let configEnabled = $state<boolean | null>(null)
    let tables = $state<NodePostgresTableInfo[]>([])
    let revisions = $state<NodePostgresRevision[]>([])
    let tokenUsage = $state<NodePostgresTokenUsage[]>([])
    let busy = $state(false)
    let error = $state('')

    // Thumbnail cache for Bot avatars in Stats tab
    let thumbnailUrls = $state<Map<string, string>>(new Map())
    let remoteBotStats = $state<BotChatStats[] | null>(null)

    // ── 봇별 및 전체 통계 계산 ──
    const botStats = $derived.by<BotChatStats[]>(() => {
        if (remoteBotStats && remoteBotStats.length > 0) {
            return remoteBotStats
        }
        const chars = characterStore.characters || []
        return chars.map((char: any) => {
            const isGroup = char.type === 'group'
            const chats = Array.isArray(char.chats) ? char.chats : []
            let totalMessages = 0
            let userMessages = 0
            let botMessages = 0
            let longestSessionMessages = 0
            let lastActiveDate: number | null = char.lastInteractionTime ?? null
            let totalBotLen = 0
            let totalUserLen = 0

            for (const chat of chats) {
                if (chat?.lastDate && (!lastActiveDate || chat.lastDate > lastActiveDate)) {
                    lastActiveDate = chat.lastDate
                }
                const msgs = Array.isArray(chat.message) ? chat.message : []
                const msgCount = chat.messageTotal ?? msgs.length
                totalMessages += msgCount
                if (msgCount > longestSessionMessages) {
                    longestSessionMessages = msgCount
                }
                for (const m of msgs) {
                    if (m?.time && (!lastActiveDate || m.time > lastActiveDate)) {
                        lastActiveDate = m.time
                    }
                    const textLen = typeof m?.data === 'string' ? m.data.length : 0
                    if (m?.role === 'user' || m?.saying === 'user') {
                        userMessages++
                        totalUserLen += textLen
                    } else {
                        botMessages++
                        totalBotLen += textLen
                    }
                }
            }

            if (totalMessages > 0 && userMessages === 0 && botMessages === 0) {
                userMessages = Math.floor(totalMessages / 2)
                botMessages = totalMessages - userMessages
            }

            const totalSessions = chats.length
            return {
                id: char.chaId || char.name,
                name: char.name || (isGroup ? 'Group' : 'Character'),
                avatarKey: char.image,
                image: char.image,
                isGroup,
                totalSessions,
                totalMessages,
                userMessages,
                botMessages,
                longestSessionMessages,
                lastActiveDate,
                avgBotMessageLen: botMessages > 0 ? Math.round(totalBotLen / botMessages) : 0,
                avgUserMessageLen: userMessages > 0 ? Math.round(totalUserLen / userMessages) : 0,
                avgMessagesPerSession: totalSessions > 0 ? Number((totalMessages / totalSessions).toFixed(1)) : 0,
            }
        })
    })

    const overallStats = $derived.by<DbOverallStats>(() => {
        let totalSessions = 0
        let totalMessages = 0
        for (const b of botStats) {
            totalSessions += b.totalSessions
            totalMessages += b.totalMessages
        }
        let totalInputTokens = 0
        let totalOutputTokens = 0
        for (const t of tokenUsage) {
            totalInputTokens += t.totalInputTokens || 0
            totalOutputTokens += t.totalOutputTokens || 0
        }
        let totalRows = 0
        for (const t of tables) {
            totalRows += t.rowCount || 0
        }

        return {
            totalCharacters: botStats.length,
            totalSessions,
            totalMessages,
            totalInputTokens,
            totalOutputTokens,
            totalTokens: totalInputTokens + totalOutputTokens,
            totalModules: (moduleStore.modules?.length ?? 0),
            totalLorebooks: (settingsStore.state.loreBook?.length ?? 0),
            totalTables: tables.length,
            totalRows
        }
    })

    function getNodeStorage() {
        if (!(forageStorage.realStorage instanceof NodeStorage)) {
            throw new Error('Node storage is not available')
        }
        return forageStorage.realStorage
    }

    async function loadThumbnail(key: string) {
        if (!key || thumbnailUrls.has(key)) return
        if (key.startsWith('data:') || key.startsWith('http:') || key.startsWith('https:')) {
            thumbnailUrls.set(key, key)
            thumbnailUrls = new Map(thumbnailUrls)
            return
        }
        try {
            const storage = getNodeStorage()
            const data = await storage.getItem(key)
            if (data && data.length > 0) {
                const blob = new Blob([data as unknown as BlobPart], { type: getMimeType(key) })
                const url = URL.createObjectURL(blob)
                thumbnailUrls.set(key, url)
                thumbnailUrls = new Map(thumbnailUrls)
                return
            }
        } catch {}
        try {
            const data = await forageStorage.getItem(key)
            if (data && data.length > 0) {
                const blob = new Blob([data as unknown as BlobPart], { type: getMimeType(key) })
                const url = URL.createObjectURL(blob)
                thumbnailUrls.set(key, url)
                thumbnailUrls = new Map(thumbnailUrls)
            }
        } catch {}
    }

    function clearThumbnailCache() {
        for (const url of thumbnailUrls.values()) {
            URL.revokeObjectURL(url)
        }
        thumbnailUrls = new Map()
    }

    async function refreshTables() {
        busy = true
        error = ''
        try {
            const storage = getNodeStorage().postgres
            const config = await storage.getServerConfig()
            configEnabled = config.enabled
            tables = config.enabled ? await storage.listDbTables() : []
            revisions = config.enabled ? await storage.listRevisions() : []
            tokenUsage = config.enabled ? await storage.getTokenUsage() : []
            remoteBotStats = config.enabled && typeof storage.getBotChatStats === 'function' ? await storage.getBotChatStats() : null
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    onMount(() => {
        refreshTables()
    })

    onDestroy(() => {
        clearThumbnailCache()
    })
</script>

<svelte:window
    onkeydown={(e) => {
        if (e.key === 'Escape') {
            close()
        }
    }}
/>

<!-- Backdrop Overlay -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-3 md:p-5 lg:p-6 animate-in fade-in duration-200"
    onclick={close}
    role="presentation"
>
    <!-- Modal Container -->
    <div
        class="flex h-full w-full sm:h-[94vh] sm:max-h-[980px] sm:max-w-6xl md:max-w-7xl lg:max-w-[110rem] flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-darkborderc bg-bgcolor text-textcolor shadow-2xl animate-in zoom-in-95 duration-200"
        onclick={(e) => e.stopPropagation()}
        role="presentation"
    >
        <!-- Modal Header Bar -->
        <div class="flex items-center justify-between gap-2 border-b border-darkborderc p-2.5 sm:p-3 shrink-0 bg-darkbg select-none">
            <div class="flex items-center gap-2.5 min-w-0">
                <div class="flex h-8 w-8 sm:h-9 sm:w-9 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shrink-0">
                    <TableIcon class="h-4 w-4 sm:h-5 sm:w-5" />
                </div>
                <div class="min-w-0">
                    <h2 class="text-sm sm:text-base font-bold truncate text-textcolor">{language.postgresDbExplorer}</h2>
                    <p class="hidden sm:block text-xs text-textcolor2 truncate">{language.postgresDbExplorerDescription}</p>
                </div>
            </div>

            <div class="flex items-center gap-2 shrink-0">
                {#if configEnabled !== null}
                    <span class="rounded-full px-2.5 py-0.5 text-[11px] font-medium {configEnabled ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-darkbutton text-textcolor2'}">
                        {configEnabled ? language.postgresStatusEnabled : language.postgresStatusDisabled}
                    </span>
                {/if}
                <Button size="sm" disabled={busy} onclick={refreshTables}>
                    <span class="hidden sm:inline">{language.postgresDbExplorerRefresh}</span>
                    <RefreshCwIcon size={14} class="sm:hidden {busy ? 'animate-spin' : ''}" />
                </Button>
                <button class="cursor-pointer p-1.5 text-textcolor2 hover:text-green-500 rounded-lg hover:bg-darkbutton transition-colors" onclick={close}>
                    <XIcon size={18} />
                </button>
            </div>
        </div>

        <!-- 4-Tab Navigation Bar -->
        <DbExplorerTabNav
            {currentTab}
            tableCount={tables.length}
            revisionCount={revisions.length}
            botCount={botStats.length}
            onSelectTab={(tab) => {
                currentTab = tab
            }}
        />

        <!-- Main Content Area: Zero-waste flex for Tables tab, scroll for others -->
        {#if currentTab === 'tables'}
            <main class="flex-1 flex flex-col min-h-0 overflow-hidden">
                {#if error}
                    <div class="m-3 rounded-xl border border-draculared/50 bg-draculared/10 p-3 text-xs text-draculared">
                        {error}
                    </div>
                {/if}

                {#if configEnabled === null}
                    <div class="flex flex-1 items-center justify-center text-sm text-textcolor2">
                        <RefreshCwIcon size={20} class="animate-spin mr-2 text-blue-400" />
                        <span>{language.postgresStatusLoading}</span>
                    </div>
                {:else if !configEnabled}
                    <!-- 데이터베이스 비활성화 시 설정 탭 유도 배너 -->
                    <div class="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 sm:p-8 text-center max-w-2xl mx-auto my-auto">
                        <div class="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/20 text-amber-300 mb-4">
                            <SettingsIcon size={28} />
                        </div>
                        <h3 class="text-base sm:text-lg font-bold text-textcolor">{language.dbExplorerDisabledBanner}</h3>
                        <p class="mt-1.5 text-xs sm:text-sm text-textcolor2">{language.dbExplorerDisabledDesc}</p>
                        <div class="mt-6 flex justify-center">
                            <Button className="bg-selected hover:opacity-90 font-medium px-5 py-2" onclick={() => currentTab = 'config'}>
                                {language.dbExplorerGoToConfig}
                            </Button>
                        </div>
                    </div>
                {:else}
                    <DbTableExplorerTab
                        {tables}
                        {configEnabled}
                        onRefreshAll={refreshTables}
                        onGoToConfig={() => currentTab = 'config'}
                        loadTableData={(table, options) => getNodeStorage().postgres.getDbTableData(table, options)}
                    />
                {/if}
            </main>
        {:else}
            <main class="flex-1 overflow-y-auto p-3 sm:p-5 min-h-0 scrollbar-thin">
                {#if error}
                    <div class="mb-4 rounded-xl border border-draculared/50 bg-draculared/10 p-3.5 text-sm text-draculared">
                        {error}
                    </div>
                {/if}

                <!-- TAB 2: CONFIG (데이터베이스 설정) -->
                {#if currentTab === 'config'}
                    <DbConfigTab onConfigChanged={refreshTables} />
                {/if}

                <!-- TAB 3: STATS (통계 대시보드) -->
                {#if currentTab === 'stats'}
                    <DbStatsTab
                        {botStats}
                        {tokenUsage}
                        {overallStats}
                        {thumbnailUrls}
                        onLoadThumbnail={loadThumbnail}
                    />
                {/if}

                <!-- TAB 4: HISTORY (리비전 히스토리) -->
                {#if currentTab === 'history'}
                    <DbHistoryTab
                        {revisions}
                        onRevisionRestored={refreshTables}
                    />
                {/if}
            </main>
        {/if}
    </div>
</div>
