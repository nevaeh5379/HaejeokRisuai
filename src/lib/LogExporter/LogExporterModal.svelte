<script lang="ts">
    import {
        X,
        Pencil,
        FileText,
        ChevronLeft,
        ChevronRight,
        Image as ImageIcon,
        MoreHorizontal,
        MoreVertical,
        Copy,
        FileCode,
        Download,
        Upload,
        Trash2,
        CheckSquare,
        Square,
        RefreshCw,
        ZoomIn,
        ZoomOut,
        Maximize,
        RotateCcw,
        Eye,
        Palette,
        ArrowLeftRight,
        FileOutput,
        SlidersHorizontal,
        Check,
    } from '@lucide/svelte'
    import { fade } from 'svelte/transition'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import LogContainer from './LogContainer.svelte'
    import SettingsPanel from './SettingsPanel.svelte'
    import { logExporterStore } from 'src/ts/logexporter/store.svelte'
    import { collectLogData } from 'src/ts/logexporter/chatData.svelte'
    import { loadCharSettings, saveCharSettings, mergeWithDefaults } from 'src/ts/logexporter/settings.svelte'
    import { resolveEffectiveColor, EXPORT_FORMAT_OPTIONS } from 'src/ts/logexporter/constants'
    import { saveAsImage } from 'src/ts/logexporter/imageService'
    import { generateExport } from 'src/ts/logexporter/htmlGenerator'
    import { copyToClipboard, saveAsFile, sanitizeFilename } from 'src/ts/logexporter/fileService'
    import { clearBatchCache, clearImageUrlCache } from 'src/ts/logexporter/messageRenderer'
    import type {
        ColorPalette,
        ExportFormat,
        LogExportData,
        LogExporterSettings,
        LogMessageData,
    } from 'src/ts/logexporter/types'
    import type { character, groupChat } from '../../ts/storage/database/schema';// ── Responsive ───────────────────────────────────────────────────────
    let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280)
    const isMobile = $derived(windowWidth < 1024)

    // ── Core state ───────────────────────────────────────────────────────
    let isLoading = $state(true)
    let loadError = $state('')
    let charId = $state('')
    let currentChar = $state<character | groupChat | undefined>(undefined)
    let settings = $state<LogExporterSettings>(mergeWithDefaults(undefined))
    let excludedParticipants = $state<string[]>([])
    let allMessages = $state<LogMessageData[]>([])
    let charInfo = $state<LogExportData['charInfo']>({ name: '', chatName: '', avatarUrl: '' })

    let selectedIndices = $state<Set<number>>(new Set())
    let lastSelectedIndex = $state<number | null>(null)
    let isSettingsOpen = $state(true)

    // Tab state
    let activeDesktopTab = $state<'style' | 'replace' | 'export' | 'advanced'>('style')
    let activeMobileTab = $state<'preview' | 'style' | 'replace' | 'export' | 'advanced'>('preview')

    let progress = $state({ active: false, message: '', current: 0, total: 0 })
    let moreMenuOpen = $state(false)
    let copySuccess = $state(false)

    // Preview scaling
    let previewScale = $state(1)
    let fitMode = $state(true)
    let viewportEl: HTMLDivElement | null = $state(null)
    let documentEl: HTMLDivElement | null = $state(null)
    let documentHeight = $state(0)

    const palette: ColorPalette = $derived(resolveEffectiveColor(settings.theme, settings.color))
    const backgroundColor = $derived(palette.background)
    const viewWidth = $derived(settings.previewWidth || 800)
    const fontSize = $derived(settings.previewFontSize || 16)

    const visibleMessages: LogMessageData[] = $derived(
        allMessages.filter((m) => !excludedParticipants.includes(m.name))
    )
    const viewData: LogExportData = $derived({
        charInfo,
        messages: visibleMessages,
        participants: new Set(visibleMessages.map((m) => m.name)),
        characterId: charId,
        character: currentChar,
    })
    const hasSelection = $derived(selectedIndices.size > 0)
    const isBasicFormat = $derived(settings.format === 'basic')

    // HTML / markdown / text preview content
    let formatPreview = $state('')
    let formatPreviewPending = $state(false)

    // ── Data loading ─────────────────────────────────────────────────────
    async function loadData() {
        isLoading = true
        loadError = ''
        try {
            clearBatchCache()
            clearImageUrlCache()
            const options = logExporterStore.options
            const data = await collectLogData({
                startIndex: options.startIndex,
                endIndex: options.endIndex,
                singleMessage: options.singleMessage,
            })
            charInfo = data.charInfo
            allMessages = data.messages
            currentChar = data.character

            charId = data.characterId ?? ''
            const saved = await loadCharSettings(charId)
            settings = mergeWithDefaults(saved)
            fitToViewport()
        } catch (e) {
            if ((e as Error).message !== 'cancelled') {
                loadError = (e as Error).message || String(e)
            }
        } finally {
            isLoading = false
        }
    }

    $effect(() => {
        if (!logExporterStore.isOpen) return
        windowWidth = window.innerWidth
        resetViewState()
        void loadData()
    })

    function resetViewState() {
        selectedIndices = new Set()
        lastSelectedIndex = null
        activeDesktopTab = 'style'
        activeMobileTab = 'preview'
        isSettingsOpen = window.innerWidth >= 1024
        fitMode = true
        previewScale = 1
        progress = { active: false, message: '', current: 0, total: 0 }
        moreMenuOpen = false
        copySuccess = false
        formatPreview = ''
    }

    // ── Progress helpers ─────────────────────────────────────────────────
    function startProgress(message: string, total = 1) {
        progress = { active: true, message, current: 0, total }
        moreMenuOpen = false
    }
    function updateProgress(update: { current?: number; message?: string }) {
        progress = {
            ...progress,
            current: update.current ?? progress.current,
            message: update.message ?? progress.message,
        }
    }
    function endProgress() {
        progress = { ...progress, active: false }
    }

    // ── Setting changes with debounced persistence ───────────────────────
    let saveTimer: ReturnType<typeof setTimeout> | undefined
    function setSetting<K extends keyof LogExporterSettings>(key: K, value: LogExporterSettings[K]) {
        settings = { ...settings, [key]: value }
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => {
            if (charId) void saveCharSettings(charId, settings)
        }, 500)
    }

    // ── Selection ────────────────────────────────────────────────────────
    function handleSelect(index: number, e: MouseEvent) {
        const next = new Set(selectedIndices)
        if (e.shiftKey && lastSelectedIndex !== null) {
            const [a, b] = [lastSelectedIndex, index].sort((x, y) => x - y)
            for (let i = a; i <= b; i++) next.add(i)
        } else if (next.has(index)) {
            next.delete(index)
        } else {
            next.add(index)
        }
        selectedIndices = next
        lastSelectedIndex = index
    }

    function selectAll() { selectedIndices = new Set(visibleMessages.map((_, i) => i)); moreMenuOpen = false }
    function deselectAll() { selectedIndices = new Set(); moreMenuOpen = false }
    function invertSelection() {
        const next = new Set<number>()
        visibleMessages.forEach((_, i) => { if (!selectedIndices.has(i)) next.add(i) })
        selectedIndices = next
        moreMenuOpen = false
    }
    function deleteSelected() {
        const doomed = new Set(
            visibleMessages.filter((m, i) => selectedIndices.has(i))
        )
        allMessages = allMessages.filter((m) => !doomed.has(m))
        selectedIndices = new Set()
        clearBatchCache()
    }

    // ── Fit / zoom ───────────────────────────────────────────────────────
    function fitToViewport() {
        if (!viewportEl) return
        const padding = isMobile ? 16 : 48
        const available = Math.max(1, viewportEl.clientWidth - padding)
        previewScale = Math.min(1, Math.max(0.15, available / viewWidth))
        fitMode = true
    }
    function changeScale(delta: number) {
        fitMode = false
        previewScale = Math.min(2, Math.max(0.15, Math.round((previewScale + delta) * 10) / 10))
    }
    function resetScale() {
        fitMode = false
        previewScale = 1
    }

    $effect(() => {
        if (!viewportEl) return
        const observer = new ResizeObserver(() => {
            if (fitMode && isBasicFormat) fitToViewport()
            if (documentEl) documentHeight = documentEl.offsetHeight
        })
        observer.observe(viewportEl)
        return () => observer.disconnect()
    })
    $effect(() => {
        void previewScale
        if (documentEl) documentHeight = documentEl.offsetHeight
    })

    // ── HTML / markdown / text preview generation ────────────────────────
    $effect(() => {
        if (isBasicFormat || !logExporterStore.isOpen || isLoading || loadError) return
        let cancelled = false
        formatPreviewPending = true
        const timer = setTimeout(async () => {
            try {
                const result = await generateExport(viewData, settings, palette)
                if (!cancelled) formatPreview = result.content
            } catch (e) {
                console.error('[logexporter] Format preview failed:', e)
            } finally {
                if (!cancelled) formatPreviewPending = false
            }
        }, 350)
        return () => {
            cancelled = true
            clearTimeout(timer)
        }
    })

    // ── Export actions ───────────────────────────────────────────────────
    function exportFilename(ext: string): string {
        return `Risu_Log_${sanitizeFilename(charInfo.name)}_${sanitizeFilename(charInfo.chatName)}.${ext}`
    }

    async function handleSaveImage() {
        try {
            await saveAsImage(viewData, settings, palette, settings.imageFormat, {
                onProgressStart: startProgress,
                onProgressUpdate: updateProgress,
                onProgressEnd: endProgress,
            })
        } catch (e) {
            console.error(e)
            endProgress()
        }
    }

    function triggerCopyFeedback() {
        copySuccess = true
        setTimeout(() => { copySuccess = false }, 2000)
    }

    async function exportViaHtml(action: 'copy' | 'save') {
        try {
            startProgress('HTML 생성 중...', 1)
            const result = await generateExport(
                viewData,
                { ...settings, format: 'html' },
                palette,
            )
            endProgress()
            if (action === 'copy') {
                const ok = await copyToClipboard(result.content)
                if (ok) triggerCopyFeedback()
            } else {
                await saveAsFile(exportFilename('html'), result.content)
            }
        } catch (e) {
            console.error(e)
            endProgress()
        }
    }

    async function handleExportTextOrMarkdown(action: 'copy' | 'save') {
        try {
            startProgress('내보내기 생성 중...', 1)
            const result = await generateExport(viewData, settings, palette)
            endProgress()
            if (action === 'copy') {
                const ok = await copyToClipboard(result.content)
                if (ok) triggerCopyFeedback()
            } else {
                await saveAsFile(exportFilename(result.extension), result.content)
            }
        } catch (e) {
            console.error(e)
            endProgress()
        }
    }

    async function handleBackup() {
        try {
            const payload = JSON.stringify({ type: 'risuLogExporter', ver: 1, settings, messages: allMessages })
            await saveAsFile(`Risu_Log_Backup_${sanitizeFilename(charInfo.name)}.json`, payload)
        } catch (e) {
            console.error(e)
        }
        moreMenuOpen = false
    }

    function handleRestore() {
        moreMenuOpen = false
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'
        input.onchange = async () => {
            const file = input.files?.[0]
            if (!file) return
            try {
                const parsed = JSON.parse(await file.text())
                if (parsed.type === 'risuLogExporter') {
                    settings = mergeWithDefaults(parsed.settings)
                    if (Array.isArray(parsed.messages)) {
                        clearBatchCache()
                        allMessages = parsed.messages
                    }
                    charId = ''
                }
            } catch (e) {
                console.error('[logexporter] Restore failed:', e)
            }
        }
        input.click()
    }

    function close() {
        if (saveTimer) clearTimeout(saveTimer)
        if (charId) void saveCharSettings(charId, settings)
        logExporterStore.close()
    }

    function handleKeydown(e: KeyboardEvent) {
        if (!logExporterStore.isOpen) return
        if (e.key === 'Escape') close()
    }

    const mobileNavTabs = $derived([
        { id: 'preview' as const, label: '미리보기', icon: Eye },
        { id: 'style' as const, label: '스타일', icon: Palette },
        { id: 'replace' as const, label: '치환', icon: ArrowLeftRight, badge: settings.replacementRules?.length || 0 },
        { id: 'export' as const, label: '내보내기', icon: FileOutput },
        { id: 'advanced' as const, label: '고급', icon: SlidersHorizontal },
    ])
</script>

<svelte:window bind:innerWidth={windowWidth} onkeydown={handleKeydown} />

{#if logExporterStore.isOpen}
    <!-- Backdrop -->
    <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-xs select-none"
        class:p-0={isMobile}
        class:p-4={!isMobile}
        class:lg:p-6={!isMobile}
        transition:fade={{ duration: 120 }}
    >
        <!-- Modal Window Container -->
        <div
            class="flex flex-col bg-bgcolor text-textcolor overflow-hidden transition-all duration-200"
            class:w-full={isMobile}
            class:h-full={isMobile}
            class:rounded-none={isMobile}
            class:border-0={isMobile}
            class:w-[95vw]={!isMobile}
            class:max-w-[1600px]={!isMobile}
            class:h-[92vh]={!isMobile}
            class:max-h-[1020px]={!isMobile}
            class:rounded-2xl={!isMobile}
            class:border={!isMobile}
            class:border-darkborderc={!isMobile}
            class:shadow-2xl={!isMobile}
        >
            <!-- ═══════════════════════════════════════════════════════════════════ -->
            <!-- MOBILE HEADER (Mobile only)                                         -->
            <!-- ═══════════════════════════════════════════════════════════════════ -->
            {#if isMobile}
                <div class="flex items-center gap-3 px-4 py-3 border-b border-darkborderc bg-darkbg shrink-0 shadow-xs">
                    <button
                        type="button"
                        class="w-9 h-9 rounded-xl bg-darkbutton hover:bg-darkborderc border border-darkborderc flex items-center justify-center text-textcolor transition active:scale-95 shrink-0"
                        onclick={close}
                        aria-label="뒤로가기"
                    >
                        <ChevronLeft size={20} />
                    </button>
                    {#if charInfo.avatarUrl}
                        <img src={charInfo.avatarUrl} alt={charInfo.name} class="w-9 h-9 rounded-xl object-cover border border-darkborderc shadow-xs shrink-0" />
                    {/if}
                    <div class="flex flex-col min-w-0 flex-1">
                        <span class="text-sm font-bold text-textcolor truncate">로그 내보내기</span>
                        <span class="text-[11px] text-textcolor2 truncate">
                            {charInfo.name}{charInfo.chatName ? ` · ${charInfo.chatName}` : ''}
                        </span>
                    </div>
                    <button
                        type="button"
                        class="p-2 rounded-xl border transition-colors active:scale-95 {settings.isEditable ? 'bg-selected text-white border-selected shadow-xs' : 'bg-darkbutton text-textcolor2 hover:text-textcolor border-darkborderc'}"
                        onclick={() => setSetting('isEditable', !settings.isEditable)}
                        title="메시지 편집"
                        aria-label="메시지 편집"
                    >
                        <Pencil size={16} />
                    </button>
                </div>

                <!-- Mobile Sub-Header Navigation Tabs -->
                <div class="flex items-center border-b border-darkborderc bg-darkbg p-1.5 gap-1 overflow-x-auto no-scrollbar shrink-0">
                    {#each mobileNavTabs as tab (tab.id)}
                        <button
                            type="button"
                            class="flex-1 flex items-center justify-center gap-1.5 py-2 px-2.5 rounded-lg text-xs font-semibold transition-all shrink-0 relative {activeMobileTab === tab.id ? 'bg-selected text-white shadow-xs' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton/80 bg-darkbutton/40'}"
                            onclick={() => (activeMobileTab = tab.id)}
                        >
                            <tab.icon size={14} />
                            <span>{tab.label}</span>
                            {#if tab.badge && tab.badge > 0}
                                <span class="text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums {activeMobileTab === tab.id ? 'bg-white text-selected' : 'bg-selected/25 text-selected'}">
                                    {tab.badge}
                                </span>
                            {/if}
                        </button>
                    {/each}
                </div>
            {/if}

            <!-- ═══════════════════════════════════════════════════════════════════ -->
            <!-- BODY (SIDEBAR + FULL-HEIGHT PREVIEW CANVAS)                        -->
            <!-- ═══════════════════════════════════════════════════════════════════ -->
            <div class="flex flex-1 overflow-hidden relative">
                {#if isLoading}
                    <!-- Loading state -->
                    <div class="flex-1 flex flex-col items-center justify-center gap-3">
                        <div class="animate-spin w-9 h-9 border-3 border-selected border-t-transparent rounded-full shadow-lg"></div>
                        <span class="text-xs text-textcolor font-medium">로그 데이터를 준비하고 있습니다...</span>
                    </div>
                {:else if loadError}
                    <!-- Error state -->
                    <div class="flex-1 flex flex-col items-center justify-center px-8 text-center gap-2">
                        <span class="text-sm font-semibold text-red-400">데이터를 불러오는 중 오류가 발생했습니다</span>
                        <span class="text-xs text-textcolor2 max-w-md">{loadError}</span>
                        <Button size="sm" onclick={loadData} className="mt-2">다시 시도</Button>
                    </div>
                {:else}
                    <!-- ── DESKTOP SIDEBAR ── -->
                    {#if !isMobile}
                        <div
                            class="flex flex-col h-full border-r border-darkborderc bg-bgcolor shrink-0 overflow-hidden transition-all duration-200 relative"
                            style="width:{isSettingsOpen ? '440px' : '0px'};"
                        >
                            <div class="h-full w-[440px] flex flex-col overflow-hidden">
                                <!-- Sidebar Header (Character / Chat Info) -->
                                <div class="flex items-center gap-3 px-4 py-3 border-b border-darkborderc bg-darkbg shrink-0">
                                    {#if charInfo.avatarUrl}
                                        <img src={charInfo.avatarUrl} alt={charInfo.name} class="w-9 h-9 rounded-xl object-cover border border-darkborderc shadow-xs shrink-0" />
                                    {:else}
                                        <div class="w-9 h-9 rounded-xl bg-selected/20 border border-selected/40 flex items-center justify-center text-selected font-bold text-sm shadow-xs shrink-0">
                                            {charInfo.name ? charInfo.name.slice(0, 1).toUpperCase() : '🤖'}
                                        </div>
                                    {/if}
                                    <div class="flex flex-col min-w-0 flex-1">
                                        <div class="flex items-center gap-2">
                                            <span class="text-sm font-bold text-textcolor truncate">로그 내보내기</span>
                                            {#if allMessages.length > 0}
                                                <span class="text-[11px] px-2 py-0.2 rounded-full bg-selected/20 text-textcolor border border-selected/40 font-bold tabular-nums shrink-0">
                                                    {allMessages.length}
                                                </span>
                                            {/if}
                                        </div>
                                        <span class="text-[11px] text-textcolor2 truncate">{charInfo.name}{charInfo.chatName ? ` · ${charInfo.chatName}` : ''}</span>
                                    </div>
                                </div>

                                <!-- Settings Panel -->
                                <div class="flex-1 overflow-hidden">
                                    <SettingsPanel
                                        bind:activeTab={activeDesktopTab}
                                        {settings}
                                        onChange={setSetting}
                                        participants={[...viewData.participants]}
                                        {excludedParticipants}
                                        onToggleParticipant={(name, excluded) => {
                                            excludedParticipants = excluded
                                                ? [...excludedParticipants, name]
                                                : excludedParticipants.filter((n) => n !== name)
                                        }}
                                    />
                                </div>
                            </div>
                        </div>
                    {/if}

                    <!-- ── PREVIEW & CANVAS COLUMN (OR MOBILE VIEW) ── -->
                    <div
                        class="flex flex-col flex-1 overflow-hidden relative min-w-0 bg-bgcolor"
                        class:hidden={isMobile && activeMobileTab !== 'preview'}
                    >
                        <!-- Desktop Sidebar Toggle Button -->
                        {#if !isMobile}
                            <button
                                type="button"
                                class="absolute left-0 top-1/2 -translate-y-1/2 z-30 w-5 h-12 flex items-center justify-center bg-darkbg border border-l-0 border-darkborderc text-textcolor hover:text-selected hover:bg-darkbutton transition-all shadow-md active:scale-95"
                                style="border-radius:0 8px 8px 0;"
                                onclick={() => (isSettingsOpen = !isSettingsOpen)}
                                title={isSettingsOpen ? '설정 사이드바 접기' : '설정 사이드바 펼치기'}
                                aria-label={isSettingsOpen ? '설정 접기' : '설정 펼치기'}
                            >
                                {#if isSettingsOpen}
                                    <ChevronLeft size={15} />
                                {:else}
                                    <ChevronRight size={15} />
                                {/if}
                            </button>
                        {/if}

                        <!-- ═══════════════════════════════════════════════════════════ -->
                        <!-- FLOATING TOP CONTROLS OVER PREVIEW                        -->
                        <!-- ═══════════════════════════════════════════════════════════ -->
                        <div class="pointer-events-none absolute top-4 left-4 right-4 z-20 flex items-center justify-between gap-2">
                            <!-- Left: Floating Format Selector -->
                            <div class="pointer-events-auto">
                                <SelectInput
                                    value={settings.format}
                                    size="sm"
                                    className="bg-darkbg/90 backdrop-blur-md border border-darkborderc rounded-xl shadow-lg text-textcolor font-bold text-xs"
                                    onchange={(e) => setSetting('format', e.currentTarget.value as ExportFormat)}
                                >
                                    {#each EXPORT_FORMAT_OPTIONS as opt (opt.value)}
                                        <option value={opt.value}>{opt.label}</option>
                                    {/each}
                                </SelectInput>
                            </div>

                            <!-- Right: Floating Zoom + Edit + Close Buttons -->
                            <div class="pointer-events-auto flex items-center gap-2">
                                {#if isBasicFormat}
                                    <!-- Floating Zoom Controls -->
                                    <div class="flex items-center gap-1 bg-darkbg/90 backdrop-blur-md border border-darkborderc rounded-xl p-1 shadow-lg">
                                        <button
                                            type="button"
                                            class="p-1.5 rounded-lg hover:bg-darkbutton text-textcolor hover:text-selected transition-colors active:scale-95"
                                            onclick={() => changeScale(-0.1)}
                                            title="축소"
                                            aria-label="축소"
                                        >
                                            <ZoomOut size={14} />
                                        </button>
                                        <span class="tabular-nums px-1 text-[11px] font-bold text-textcolor min-w-9 text-center">
                                            {Math.round(previewScale * 100)}%
                                        </span>
                                        <button
                                            type="button"
                                            class="p-1.5 rounded-lg hover:bg-darkbutton text-textcolor hover:text-selected transition-colors active:scale-95"
                                            onclick={() => changeScale(0.1)}
                                            title="확대"
                                            aria-label="확대"
                                        >
                                            <ZoomIn size={14} />
                                        </button>
                                        <div class="w-px h-3.5 bg-darkborderc mx-0.5"></div>
                                        <button
                                            type="button"
                                            class="p-1.5 rounded-lg hover:bg-darkbutton text-textcolor hover:text-selected transition-colors active:scale-95"
                                            onclick={() => { fitMode = true; fitToViewport() }}
                                            title="화면 너비 맞춤"
                                            aria-label="화면 맞춤"
                                        >
                                            <Maximize size={14} />
                                        </button>
                                        <button
                                            type="button"
                                            class="p-1.5 rounded-lg hover:bg-darkbutton text-textcolor hover:text-selected transition-colors active:scale-95"
                                            onclick={resetScale}
                                            title="100% 원래 크기"
                                            aria-label="원래 크기"
                                        >
                                            <RotateCcw size={14} />
                                        </button>
                                    </div>
                                {/if}

                                <!-- Floating Edit Mode Toggle -->
                                <button
                                    type="button"
                                    class="h-9 w-9 rounded-xl border border-darkborderc bg-darkbg/90 backdrop-blur-md shadow-lg flex items-center justify-center transition active:scale-95 {settings.isEditable ? 'bg-selected text-white border-selected ring-2 ring-selected/50' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
                                    onclick={() => setSetting('isEditable', !settings.isEditable)}
                                    title={settings.isEditable ? '메시지 편집 모드 켜짐 (클릭하여 끄기)' : '메시지 편집 모드'}
                                    aria-label="메시지 편집"
                                    aria-pressed={settings.isEditable}
                                >
                                    <Pencil size={15} />
                                </button>

                                {#if !isMobile}
                                    <!-- Floating Close Button -->
                                    <button
                                        type="button"
                                        id="log-exporter-close"
                                        class="h-9 w-9 rounded-xl border border-darkborderc bg-darkbg/90 backdrop-blur-md shadow-lg flex items-center justify-center text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition active:scale-95"
                                        onclick={close}
                                        title="닫기 (Esc)"
                                        aria-label="닫기"
                                    >
                                        <X size={16} />
                                    </button>
                                {/if}
                            </div>
                        </div>

                        <!-- ═══════════════════════════════════════════════════════════ -->
                        <!-- CANVAS WORKSPACE (FULL HEIGHT)                             -->
                        <!-- ═══════════════════════════════════════════════════════════ -->
                        <div
                            bind:this={viewportEl}
                            class="flex-1 overflow-auto relative flex flex-col pt-18 pb-20 px-6"
                            style="background:{backgroundColor};"
                        >
                            {#if isBasicFormat}
                                {#key viewData}
                                    <div
                                        bind:this={documentEl}
                                        class="mx-auto origin-top transition-transform"
                                        style="width:{viewWidth}px;transform:scale({previewScale});margin-bottom:{Math.max(0, documentHeight * (previewScale - 1))}px;"
                                    >
                                        <LogContainer
                                            data={viewData}
                                            {settings}
                                            selectedThemeKey={settings.theme}
                                            selectedColorKey={settings.color}
                                            fontSize={fontSize}
                                            containerWidth={viewWidth}
                                            selectedIndices={selectedIndices}
                                            onMessageSelect={handleSelect}
                                            onMessageDelete={(i) => {
                                                const target = visibleMessages[i]
                                                if (target) allMessages = allMessages.filter((m) => m !== target)
                                                clearBatchCache()
                                            }}
                                        />
                                    </div>
                                {/key}
                            {:else if settings.format === 'html'}
                                <div class="mx-auto w-full h-full bg-black/20 rounded-xl overflow-hidden border border-darkborderc shadow-inner">
                                    {#if formatPreviewPending && !formatPreview}
                                        <div class="flex items-center justify-center h-full">
                                            <div class="animate-spin w-7 h-7 border-2 border-selected border-t-transparent rounded-full"></div>
                                        </div>
                                    {:else}
                                        <iframe title="HTML 미리보기" class="w-full h-full border-0 bg-white" srcdoc={formatPreview}></iframe>
                                    {/if}
                                </div>
                            {:else}
                                <div class="flex-1 overflow-auto max-w-4xl w-full mx-auto">
                                    <pre class="whitespace-pre-wrap break-words p-5 rounded-xl border border-darkborderc bg-darkbg/90 text-textcolor font-mono text-xs leading-relaxed shadow-sm">{formatPreview}</pre>
                                </div>
                            {/if}
                        </div>

                        <!-- ═══════════════════════════════════════════════════════════ -->
                        <!-- FLOATING BOTTOM ACTIONS OVER PREVIEW                       -->
                        <!-- ═══════════════════════════════════════════════════════════ -->
                        <div class="pointer-events-none absolute bottom-5 left-5 right-5 z-20 flex items-center justify-start gap-2">
                            <div class="pointer-events-auto flex items-center gap-2">
                                {#if settings.isEditable && hasSelection}
                                    <!-- Edit Mode Selection Actions Bar -->
                                    <div class="flex items-center gap-2 bg-darkbg/95 backdrop-blur-md border border-darkborderc rounded-2xl p-2 shadow-2xl">
                                        <span class="text-xs font-bold px-2.5 py-1 rounded-xl bg-selected/20 text-textcolor border border-selected/40 tabular-nums whitespace-nowrap">
                                            {selectedIndices.size}개 선택됨
                                        </span>
                                        <button
                                            type="button"
                                            class="h-8 px-2.5 rounded-lg border border-darkborderc bg-darkbutton hover:bg-darkborderc text-xs font-medium text-textcolor transition flex items-center active:scale-95"
                                            onclick={selectAll}
                                        >
                                            전체 선택
                                        </button>
                                        <button
                                            type="button"
                                            class="h-8 px-2.5 rounded-lg border border-darkborderc bg-darkbutton hover:bg-darkborderc text-xs font-medium text-textcolor transition flex items-center active:scale-95"
                                            onclick={deselectAll}
                                        >
                                            전체 해제
                                        </button>
                                        <button
                                            type="button"
                                            class="h-8 px-2.5 rounded-lg border border-darkborderc bg-darkbutton hover:bg-darkborderc text-xs font-medium text-textcolor transition flex items-center active:scale-95"
                                            onclick={invertSelection}
                                        >
                                            선택 반전
                                        </button>
                                        <Button size="sm" styled="danger" className="h-8 px-3 rounded-lg flex items-center gap-1.5" onclick={deleteSelected}>
                                            <Trash2 size={14} />
                                            <span>선택 삭제 ({selectedIndices.size})</span>
                                        </Button>
                                    </div>
                                {:else}
                                    <!-- Direct Floating Buttons without outer container wrapper -->
                                    {#if isBasicFormat}
                                        <Button size="sm" className="h-9 px-4 rounded-xl flex items-center gap-2 font-bold shadow-lg" onclick={() => void handleSaveImage()} disabled={progress.active}>
                                            <ImageIcon size={15} />
                                            <span>저장</span>
                                        </Button>
                                    {:else if settings.format === 'html'}
                                        <Button size="sm" className="h-9 px-4 rounded-xl flex items-center gap-2 font-bold shadow-lg" onclick={() => void exportViaHtml('save')} disabled={progress.active}>
                                            <FileCode size={15} />
                                            <span>저장</span>
                                        </Button>
                                        <Button size="sm" styled="outlined" className="h-9 px-3 rounded-xl bg-darkbg/90 backdrop-blur-md border border-darkborderc shadow-lg flex items-center gap-2" onclick={() => void exportViaHtml('copy')} disabled={progress.active}>
                                            {#if copySuccess}
                                                <Check size={15} class="text-green-400" />
                                                <span class="text-green-400 font-medium">복사됨!</span>
                                            {:else}
                                                <Copy size={15} />
                                                <span>HTML 복사</span>
                                            {/if}
                                        </Button>
                                    {:else}
                                        <Button size="sm" className="h-9 px-4 rounded-xl flex items-center gap-2 font-bold shadow-lg" onclick={() => void handleExportTextOrMarkdown('save')} disabled={progress.active}>
                                            <Download size={15} />
                                            <span>저장</span>
                                        </Button>
                                        <Button size="sm" styled="outlined" className="h-9 px-3 rounded-xl bg-darkbg/90 backdrop-blur-md border border-darkborderc shadow-lg flex items-center gap-2" onclick={() => void handleExportTextOrMarkdown('copy')} disabled={progress.active}>
                                            {#if copySuccess}
                                                <Check size={15} class="text-green-400" />
                                                <span class="text-green-400 font-medium">복사됨!</span>
                                            {:else}
                                                <Copy size={15} />
                                                <span>클립보드 복사</span>
                                            {/if}
                                        </Button>
                                    {/if}

                                    <!-- More menu dropdown -->
                                    <div class="relative flex items-center">
                                        <Button
                                            size="sm"
                                            styled="outlined"
                                            className="h-9 w-9 !p-0 rounded-xl bg-darkbg/90 backdrop-blur-md border border-darkborderc shadow-lg flex items-center justify-center text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition active:scale-95"
                                            onclick={() => (moreMenuOpen = !moreMenuOpen)}
                                        >
                                            <MoreHorizontal size={15} />
                                        </Button>

                                        {#if moreMenuOpen}
                                            <div
                                                class="absolute bottom-full mb-2.5 left-0 z-30 min-w-48 rounded-xl border border-darkborderc bg-darkbg shadow-2xl p-1 text-xs space-y-0.5"
                                                transition:fade={{ duration: 80 }}
                                            >
                                                <button
                                                    type="button"
                                                    class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor transition-colors active:scale-98"
                                                    onclick={() => { moreMenuOpen = false; void exportViaHtml('copy') }}
                                                >
                                                    <Copy size={14} class="text-textcolor2" />
                                                    <span>HTML 클립보드 복사</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor transition-colors active:scale-98"
                                                    onclick={() => { moreMenuOpen = false; void exportViaHtml('save') }}
                                                    disabled={progress.active}
                                                >
                                                    <FileCode size={14} class="text-textcolor2" />
                                                    <span>HTML 파일로 저장</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor transition-colors active:scale-98"
                                                    onclick={() => { moreMenuOpen = false; void handleExportTextOrMarkdown('save') }}
                                                    disabled={progress.active}
                                                >
                                                    <Download size={14} class="text-textcolor2" />
                                                    <span>{settings.format === 'markdown' ? 'Markdown' : '텍스트'} 파일 저장</span>
                                                </button>
                                                <div class="border-t border-darkborderc/60 my-1"></div>
                                                <button
                                                    type="button"
                                                    class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor transition-colors active:scale-98"
                                                    onclick={() => { moreMenuOpen = false; void handleBackup() }}
                                                >
                                                    <Download size={14} class="text-textcolor2" />
                                                    <span>JSON 백업 내보내기</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor transition-colors active:scale-98"
                                                    onclick={() => { moreMenuOpen = false; handleRestore() }}
                                                >
                                                    <Upload size={14} class="text-textcolor2" />
                                                    <span>JSON 백업 복원하기</span>
                                                </button>
                                                {#if settings.isEditable}
                                                    <div class="border-t border-darkborderc/60 my-1"></div>
                                                    <button type="button" class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor" onclick={() => { moreMenuOpen = false; selectAll() }}>
                                                        <CheckSquare size={14} class="text-textcolor2" /> 전체 선택
                                                    </button>
                                                    <button type="button" class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor" onclick={() => { moreMenuOpen = false; deselectAll() }}>
                                                        <Square size={14} class="text-textcolor2" /> 전체 해제
                                                    </button>
                                                    <button type="button" class="w-full text-left px-3 py-2 rounded-lg hover:bg-darkbutton flex items-center gap-2.5 text-textcolor" onclick={() => { moreMenuOpen = false; invertSelection() }}>
                                                        <RefreshCw size={14} class="text-textcolor2" /> 선택 반전
                                                    </button>
                                                {/if}
                                            </div>
                                        {/if}
                                    </div>
                                {/if}
                            </div>
                        </div>
                    </div>

                    <!-- ── MOBILE SETTINGS TABS (Mobile only when not in preview) ── -->
                    {#if isMobile && activeMobileTab !== 'preview'}
                        <div class="flex-1 flex flex-col overflow-hidden bg-bgcolor">
                            <div class="flex-1 overflow-hidden">
                                <SettingsPanel
                                    bind:activeTab={activeMobileTab}
                                    showTabBar={false}
                                    {settings}
                                    onChange={setSetting}
                                    participants={[...viewData.participants]}
                                    {excludedParticipants}
                                    onToggleParticipant={(name, excluded) => {
                                        excludedParticipants = excluded
                                            ? [...excludedParticipants, name]
                                            : excludedParticipants.filter((n) => n !== name)
                                    }}
                                />
                            </div>

                            <!-- Mobile Settings Bottom Bar -->
                            <div class="shrink-0 border-t border-darkborderc bg-darkbg/95 p-3 flex items-center gap-2">
                                <Button
                                    size="md"
                                    className="flex-1 font-medium"
                                    onclick={() => (activeMobileTab = 'preview')}
                                >
                                    <div class="flex items-center justify-center gap-2">
                                        <Eye size={16} />
                                        미리보기 확인
                                    </div>
                                </Button>
                                <Button
                                    size="md"
                                    styled="outlined"
                                    onclick={() => {
                                        if (isBasicFormat) void handleSaveImage()
                                        else if (settings.format === 'html') void exportViaHtml('save')
                                        else void handleExportTextOrMarkdown('save')
                                    }}
                                >
                                    <div class="flex items-center justify-center gap-1.5">
                                        <Download size={16} />
                                        내보내기
                                    </div>
                                </Button>
                            </div>
                        </div>
                    {/if}
                {/if}
            </div>
        </div>

        <!-- ═══════════════════════════════════════════════════════════════════ -->
        <!-- PROGRESS MODAL OVERLAY                                             -->
        <!-- ═══════════════════════════════════════════════════════════════════ -->
        {#if progress.active}
            <div class="fixed inset-0 z-60 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4" transition:fade={{ duration: 100 }}>
                <div class="rounded-2xl border border-darkborderc bg-darkbg p-6 flex flex-col items-center gap-4 min-w-72 max-w-sm shadow-2xl">
                    <div class="animate-spin w-8 h-8 border-3 border-selected border-t-transparent rounded-full"></div>
                    <div class="text-sm font-semibold text-textcolor text-center">{progress.message}</div>
                    {#if progress.total > 1}
                        <div class="w-full space-y-1.5">
                            <div class="w-full h-2 rounded-full bg-darkbutton overflow-hidden border border-darkborderc">
                                <div
                                    class="h-full bg-selected transition-all duration-200"
                                    style="width:{progress.total > 0 ? Math.min(100, (progress.current / progress.total) * 100) : 0}%"
                                ></div>
                            </div>
                            <div class="flex justify-between text-[11px] text-textcolor2 tabular-nums">
                                <span>{progress.current} / {progress.total}</span>
                                <span>{Math.round((progress.current / progress.total) * 100)}%</span>
                            </div>
                        </div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
{/if}
