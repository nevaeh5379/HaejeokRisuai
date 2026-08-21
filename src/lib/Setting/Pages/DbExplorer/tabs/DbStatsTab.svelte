<script lang="ts">
    import {
        BotIcon,
        ClockIcon,
        CpuIcon,
        DatabaseIcon,
        LayersIcon,
        MessageSquareIcon,
        MessagesSquareIcon,
        SearchIcon,
        SparklesIcon,
        UserIcon,
        UsersIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import type {
        BotChatStats,
        BotStatsSortType,
        DbOverallStats,
        ModelStatsSortType
    } from '../types'
    import type { NodePostgresTokenUsage } from 'src/ts/storage/nodePostgresStorage'

    interface Props {
        botStats: BotChatStats[]
        tokenUsage: NodePostgresTokenUsage[]
        overallStats: DbOverallStats
        thumbnailUrls: Map<string, string>
        onLoadThumbnail: (key: string) => void
    }

    const {
        botStats,
        tokenUsage,
        overallStats,
        thumbnailUrls,
        onLoadThumbnail
    }: Props = $props()

    let activeSubTab = $state<'bots' | 'models' | 'resources'>('bots')

    // 봇 통계 필터 및 정렬
    let botSearch = $state('')
    let botSort = $state<BotStatsSortType>('messages_desc')

    // 모델 토큰 통계 필터 및 정렬
    let modelSearch = $state('')
    let modelSort = $state<ModelStatsSortType>('tokens_desc')

    function formatRelativeDate(timestamp: number | null | undefined): string {
        if (!timestamp || timestamp <= 0) return '—'
        try {
            const date = new Date(timestamp)
            const now = new Date()
            const diffMs = now.getTime() - date.getTime()
            const diffSec = Math.floor(diffMs / 1000)
            const diffMin = Math.floor(diffSec / 60)
            const diffHour = Math.floor(diffMin / 60)
            const diffDay = Math.floor(diffHour / 24)

            if (diffSec < 60) return '방금 전'
            if (diffMin < 60) return `${diffMin}분 전`
            if (diffHour < 24) return `${diffHour}시간 전`
            if (diffDay < 30) return `${diffDay}일 전`
            return date.toLocaleDateString()
        } catch {
            return '—'
        }
    }

    function formatFullDate(timestamp: number | null | undefined): string {
        if (!timestamp || timestamp <= 0) return ''
        return new Date(timestamp).toLocaleString()
    }

    const filteredBots = $derived.by(() => {
        let list = [...botStats]
        if (botSearch.trim()) {
            const q = botSearch.trim().toLowerCase()
            list = list.filter((b) => b.name.toLowerCase().includes(q))
        }
        if (botSort === 'messages_desc') {
            list.sort((a, b) => b.totalMessages - a.totalMessages)
        } else if (botSort === 'sessions_desc') {
            list.sort((a, b) => b.totalSessions - a.totalSessions)
        } else if (botSort === 'recent_desc') {
            list.sort((a, b) => (b.lastActiveDate ?? 0) - (a.lastActiveDate ?? 0))
        } else if (botSort === 'name_asc') {
            list.sort((a, b) => a.name.localeCompare(b.name))
        }
        return list
    })

    const filteredModels = $derived.by(() => {
        let list = [...tokenUsage]
        if (modelSearch.trim()) {
            const q = modelSearch.trim().toLowerCase()
            list = list.filter((m) => m.model.toLowerCase().includes(q))
        }
        if (modelSort === 'tokens_desc') {
            list.sort((a, b) => (b.totalInputTokens + b.totalOutputTokens) - (a.totalInputTokens + a.totalOutputTokens))
        } else if (modelSort === 'requests_desc') {
            list.sort((a, b) => b.messageCount - a.messageCount)
        } else if (modelSort === 'name_asc') {
            list.sort((a, b) => a.model.localeCompare(b.model))
        }
        return list
    })

    const maxModelTokens = $derived.by(() => {
        if (tokenUsage.length === 0) return 1
        return Math.max(...tokenUsage.map((m) => m.totalInputTokens + m.totalOutputTokens), 1)
    })

    const maxBotMessages = $derived.by(() => {
        if (botStats.length === 0) return 1
        return Math.max(...botStats.map((b) => b.totalMessages), 1)
    })

    $effect(() => {
        for (const b of botStats) {
            if (b.avatarKey && !thumbnailUrls.has(b.avatarKey)) {
                onLoadThumbnail(b.avatarKey)
            }
        }
    })
</script>

<div class="space-y-6">
    <!-- ── 1. 상단 핵심 KPI 요약 카드 ── -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <!-- 총 메시지 수 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                <MessageSquareIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbStatsTotalMessages}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {overallStats.totalMessages.toLocaleString()}
                </p>
            </div>
        </div>

        <!-- 총 봇/캐릭터 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
                <BotIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbStatsTotalCharacters}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {overallStats.totalCharacters.toLocaleString()}
                </p>
            </div>
        </div>

        <!-- 총 채팅 세션 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <MessagesSquareIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbStatsTotalSessions}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {overallStats.totalSessions.toLocaleString()}
                </p>
            </div>
        </div>

        <!-- 총 소모 토큰 -->
        <div class="flex items-center gap-3.5 rounded-xl border border-darkborderc bg-darkbg p-3.5 sm:p-4 shadow-xs">
            <div class="flex h-10 w-10 sm:h-11 sm:w-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <SparklesIcon class="h-5 w-5 sm:h-6 sm:w-6" />
            </div>
            <div class="min-w-0">
                <p class="text-[11px] sm:text-xs text-textcolor2 truncate">{language.dbStatsTotalTokens}</p>
                <p class="text-base sm:text-xl font-bold font-mono text-textcolor truncate">
                    {overallStats.totalTokens.toLocaleString()}
                </p>
            </div>
        </div>
    </div>

    <!-- ── 2. 서브 탭 네비게이션 ── -->
    <div class="flex items-center gap-2 border-b border-darkborderc pb-1 overflow-x-auto select-none">
        <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors cursor-pointer {activeSubTab === 'bots' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => activeSubTab = 'bots'}
        >
            <BotIcon class="h-4 w-4 shrink-0" />
            <span>{language.dbStatsBotAnalytics}</span>
            <span class="rounded-full bg-darkbutton/80 px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{botStats.length}</span>
        </button>

        <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors cursor-pointer {activeSubTab === 'models' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => activeSubTab = 'models'}
        >
            <CpuIcon class="h-4 w-4 shrink-0" />
            <span>{language.dbStatsModelTokenUsage}</span>
            <span class="rounded-full bg-darkbutton/80 px-1.5 py-0.2 text-[10px] sm:text-[11px] font-mono">{tokenUsage.length}</span>
        </button>

        <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors cursor-pointer {activeSubTab === 'resources' ? 'bg-selected text-textcolor shadow-xs' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => activeSubTab = 'resources'}
        >
            <DatabaseIcon class="h-4 w-4 shrink-0" />
            <span>{language.dbStatsDbOverview}</span>
        </button>
    </div>

    <!-- ── 3. SUB-TAB 1: 봇별 대화 활동 분석 ── -->
    {#if activeSubTab === 'bots'}
        <div class="space-y-4">
            <!-- Toolbar -->
            <div class="flex flex-wrap items-center justify-between gap-2.5">
                <!-- Search Box -->
                <div class="relative w-full sm:w-64">
                    <div class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2">
                        <SearchIcon size={14} />
                    </div>
                    <TextInput
                        bind:value={botSearch}
                        size="sm"
                        fullwidth={true}
                        placeholder={language.dbStatsSearchBots}
                        className="pl-8 pr-7 text-xs"
                    />
                    {#if botSearch}
                        <button
                            class="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-textcolor2 hover:text-green-500"
                            onclick={() => botSearch = ''}
                        >
                            <XIcon size={14} />
                        </button>
                    {/if}
                </div>

                <!-- Sort Selector -->
                <div class="flex items-center gap-2">
                    <span class="text-xs text-textcolor2">{language.storageSort}:</span>
                    <SelectInput
                        bind:value={botSort}
                        size="sm"
                        className="text-xs py-1"
                    >
                        <option value="messages_desc">{language.dbStatsSortMessagesDesc}</option>
                        <option value="sessions_desc">{language.dbStatsSortSessionsDesc}</option>
                        <option value="recent_desc">{language.dbStatsSortRecentDesc}</option>
                        <option value="name_asc">{language.dbStatsSortNameAsc}</option>
                    </SelectInput>
                </div>
            </div>

            <!-- Bot Stats Grid -->
            {#if filteredBots.length === 0}
                <div class="rounded-xl border border-darkborderc bg-darkbg/40 p-12 text-center text-xs text-textcolor2">
                    {language.dbStatsNoData}
                </div>
            {:else}
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {#each filteredBots as bot (bot.id)}
                        {@const avatarSrc = (bot.image?.startsWith('data:') || bot.image?.startsWith('http')) ? bot.image : (bot.avatarKey ? thumbnailUrls.get(bot.avatarKey) : null)}
                        {@const volumeShare = overallStats.totalMessages > 0 ? ((bot.totalMessages / overallStats.totalMessages) * 100).toFixed(1) : '0'}
                        {@const avgPerSession = bot.avgMessagesPerSession ?? (bot.totalSessions > 0 ? (bot.totalMessages / bot.totalSessions).toFixed(1) : '0')}

                        <div class="flex flex-col justify-between rounded-xl border border-darkborderc bg-darkbg p-4 shadow-xs transition-all hover:border-darkborderc/80">
                            <!-- Top Info: Avatar + Name + Badges + Last Active -->
                            <div>
                                <div class="flex items-start gap-3 min-w-0">
                                    <div class="relative h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-darkborderc/60 bg-bgcolor">
                                        {#if avatarSrc}
                                            <img src={avatarSrc} alt={bot.name} class="h-full w-full object-cover" />
                                        {:else}
                                            <div class="flex h-full w-full items-center justify-center bg-bgcolor text-textcolor2">
                                                {#if bot.isGroup}
                                                    <UsersIcon size={20} class="opacity-50 text-indigo-400" />
                                                {:else}
                                                    <BotIcon size={20} class="opacity-50 text-blue-400" />
                                                {/if}
                                            </div>
                                        {/if}
                                    </div>

                                    <div class="min-w-0 flex-1">
                                        <div class="flex items-center justify-between gap-1">
                                            <div class="flex items-center gap-1.5 min-w-0">
                                                <h4 class="font-semibold text-sm text-textcolor truncate" title={bot.name}>
                                                    {bot.name || 'Unnamed Bot'}
                                                </h4>
                                                {#if bot.isGroup}
                                                    <span class="rounded bg-indigo-500/20 px-1.5 py-0.2 text-[10px] font-medium text-indigo-300 border border-indigo-500/30 shrink-0">
                                                        {language.group}
                                                    </span>
                                                {/if}
                                            </div>
                                            {#if bot.lastActiveDate}
                                                <span
                                                    class="flex items-center gap-1 text-[10px] sm:text-[11px] text-textcolor2 font-mono shrink-0"
                                                    title="{language.dbStatsLastActive}: {formatFullDate(bot.lastActiveDate)}"
                                                >
                                                    <ClockIcon size={11} class="text-textcolor2/70" />
                                                    {formatRelativeDate(bot.lastActiveDate)}
                                                </span>
                                            {/if}
                                        </div>

                                        <!-- Message and Session Counts & Depth -->
                                        <div class="mt-1 flex flex-wrap items-center gap-2 text-xs font-mono text-textcolor2">
                                            <span>
                                                <strong class="text-textcolor">{bot.totalSessions.toLocaleString()}</strong> {language.dbStatsSessionsCount}
                                            </span>
                                            <span>·</span>
                                            <span>
                                                <strong class="text-textcolor">{bot.totalMessages.toLocaleString()}</strong> {language.dbStatsMessagesCount}
                                            </span>
                                            {#if bot.totalSessions > 0}
                                                <span class="rounded bg-darkbutton px-1.5 py-0.2 text-[10px] text-textcolor2">
                                                    {avgPerSession} {language.dbStatsAvgMsgPerSession}
                                                </span>
                                            {/if}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <!-- Footer: Longest Session & Total Chat Share -->
                            <div class="mt-3 pt-2.5 border-t border-darkborderc/30 flex items-center justify-between text-[11px] text-textcolor2">
                                <span class="truncate">
                                    {language.dbStatsLongestSession}: <strong class="font-mono font-medium text-textcolor">{bot.longestSessionMessages.toLocaleString()}</strong>
                                </span>
                                {#if overallStats.totalMessages > 0}
                                    <span class="font-mono text-[10px] text-textcolor2 shrink-0 ml-2">
                                        {language.dbStatsActivityShare} <strong class="text-textcolor">{volumeShare}%</strong>
                                    </span>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- ── 4. SUB-TAB 2: AI 모델별 토큰 사용량 분석 ── -->
    {#if activeSubTab === 'models'}
        <div class="space-y-4">
            <!-- Toolbar -->
            <div class="flex flex-wrap items-center justify-between gap-2.5">
                <!-- Search Box -->
                <div class="relative w-full sm:w-64">
                    <div class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-textcolor2">
                        <SearchIcon size={14} />
                    </div>
                    <TextInput
                        bind:value={modelSearch}
                        size="sm"
                        fullwidth={true}
                        placeholder={language.dbStatsSearchModels}
                        className="pl-8 pr-7 text-xs"
                    />
                    {#if modelSearch}
                        <button
                            class="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer text-textcolor2 hover:text-green-500"
                            onclick={() => modelSearch = ''}
                        >
                            <XIcon size={14} />
                        </button>
                    {/if}
                </div>

                <!-- Sort Selector -->
                <div class="flex items-center gap-2">
                    <span class="text-xs text-textcolor2">{language.storageSort}:</span>
                    <SelectInput
                        bind:value={modelSort}
                        size="sm"
                        className="text-xs py-1"
                    >
                        <option value="tokens_desc">{language.dbStatsSortTokensDesc}</option>
                        <option value="requests_desc">{language.dbStatsSortRequestsDesc}</option>
                        <option value="name_asc">{language.dbStatsSortNameAsc}</option>
                    </SelectInput>
                </div>
            </div>

            <!-- Model Usage List -->
            {#if filteredModels.length === 0}
                <div class="rounded-xl border border-darkborderc bg-darkbg/40 p-12 text-center text-xs text-textcolor2">
                    {language.dbStatsNoData}
                </div>
            {:else}
                <div class="space-y-3">
                    {#each filteredModels as usage (usage.model)}
                        {@const totalTokens = usage.totalInputTokens + usage.totalOutputTokens}
                        {@const barWidth = Math.max(Math.round((totalTokens / maxModelTokens) * 100), 2)}

                        <div class="rounded-xl border border-darkborderc bg-darkbg p-4 shadow-xs transition-all hover:border-darkborderc/80">
                            <div class="flex flex-wrap items-center justify-between gap-2">
                                <div class="flex items-center gap-2.5 min-w-0">
                                    <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
                                        <CpuIcon class="h-4 w-4" />
                                    </div>
                                    <div class="min-w-0">
                                        <h4 class="font-semibold text-sm text-textcolor truncate" title={usage.model}>
                                            {usage.model}
                                        </h4>
                                        <p class="text-xs text-textcolor2 font-mono">
                                            {usage.messageCount.toLocaleString()} {language.dbStatsRequests}
                                        </p>
                                    </div>
                                </div>

                                <div class="text-right font-mono text-xs">
                                    <div class="font-bold text-textcolor text-sm sm:text-base">
                                        {totalTokens.toLocaleString()} <span class="text-xs font-normal text-textcolor2">{language.dbStatsTotalTokensCount}</span>
                                    </div>
                                    <div class="text-[11px] text-textcolor2 flex items-center gap-2 justify-end">
                                        <span>IN: <strong class="text-textcolor">{usage.totalInputTokens.toLocaleString()}</strong></span>
                                        <span>·</span>
                                        <span>OUT: <strong class="text-textcolor">{usage.totalOutputTokens.toLocaleString()}</strong></span>
                                    </div>
                                </div>
                            </div>

                            <!-- Relative Volume Progress Bar -->
                            <div class="mt-3 h-2 w-full overflow-hidden rounded-full bg-darkborderc/50">
                                <div
                                    class="h-full bg-sky-500 rounded-full transition-all duration-300"
                                    style="width: {barWidth}%"
                                ></div>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}

    <!-- ── 5. SUB-TAB 3: 데이터베이스 자원 현황 ── -->
    {#if activeSubTab === 'resources'}
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <!-- 총 캐릭터 -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 shadow-xs">
                <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
                        <BotIcon size={20} />
                    </div>
                    <div>
                        <p class="text-xs text-textcolor2">{language.dbStatsTotalCharacters}</p>
                        <p class="text-lg font-bold font-mono text-textcolor">{overallStats.totalCharacters.toLocaleString()}</p>
                    </div>
                </div>
            </div>

            <!-- 총 모듈 -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 shadow-xs">
                <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                        <LayersIcon size={20} />
                    </div>
                    <div>
                        <p class="text-xs text-textcolor2">{language.dbStatsTotalModules}</p>
                        <p class="text-lg font-bold font-mono text-textcolor">{overallStats.totalModules.toLocaleString()}</p>
                    </div>
                </div>
            </div>

            <!-- 총 로어북 -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 shadow-xs">
                <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <DatabaseIcon size={20} />
                    </div>
                    <div>
                        <p class="text-xs text-textcolor2">{language.dbStatsTotalLorebooks}</p>
                        <p class="text-lg font-bold font-mono text-textcolor">{overallStats.totalLorebooks.toLocaleString()}</p>
                    </div>
                </div>
            </div>

            <!-- 총 테이블 수 -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 shadow-xs">
                <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                        <DatabaseIcon size={20} />
                    </div>
                    <div>
                        <p class="text-xs text-textcolor2">{language.dbStatsTotalTables}</p>
                        <p class="text-lg font-bold font-mono text-textcolor">{overallStats.totalTables.toLocaleString()}</p>
                    </div>
                </div>
            </div>

            <!-- 총 레코드 수 -->
            <div class="rounded-xl border border-darkborderc bg-darkbg p-4 shadow-xs">
                <div class="flex items-center gap-3">
                    <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                        <MessageSquareIcon size={20} />
                    </div>
                    <div>
                        <p class="text-xs text-textcolor2">{language.dbStatsTotalRows}</p>
                        <p class="text-lg font-bold font-mono text-textcolor">{overallStats.totalRows.toLocaleString()}</p>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</div>
