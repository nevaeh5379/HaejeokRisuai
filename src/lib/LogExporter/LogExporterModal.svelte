<script lang="ts">
    import { X, Pencil, FileText, ChevronLeft, ChevronRight, Image as ImageIcon, MoreHorizontal, Copy, FileCode, Download, Upload, Trash2, CheckSquare, Square, RefreshCw, ZoomIn, ZoomOut, Maximize, Settings } from '@lucide/svelte'
    import { fade } from 'svelte/transition'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import LogContainer from './LogContainer.svelte'
    import SettingsPanel from './SettingsPanel.svelte'
    import ReplaceTab from './ReplaceTab.svelte'
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

    // ── Responsive ───────────────────────────────────────────────────────
    let windowWidth = $state(typeof window !== 'undefined' ? window.innerWidth : 1280)
    const isMobile = $derived(windowWidth < 1024)

    // ── Core state ───────────────────────────────────────────────────────
    let isLoading = $state(true)
    let loadError = $state('')
    let charId = $state('')
    let settings = $state<LogExporterSettings>(mergeWithDefaults(undefined))
    let excludedParticipants = $state<string[]>([])
    let allMessages = $state<LogMessageData[]>([])
    let charInfo = $state<LogExportData['charInfo']>({ name: '', chatName: '', avatarUrl: '' })

    let selectedIndices = $state<Set<number>>(new Set())
    let lastSelectedIndex = $state<number | null>(null)
    let isSettingsOpen = $state(true)
    let isMobilePanelOpen = $state(false)
    let activeTab = $state<'style' | 'export' | 'replace' | 'advanced'>('style')

    let progress = $state({ active: false, message: '', current: 0, total: 0 })
    let moreMenuOpen = $state(false)

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
        activeTab = 'style'
        isSettingsOpen = window.innerWidth >= 1024
        isMobilePanelOpen = false
        fitMode = true
        previewScale = 1
        progress = { active: false, message: '', current: 0, total: 0 }
        moreMenuOpen = false
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

    function selectAll() { selectedIndices = new Set(visibleMessages.map((_, i) => i)) ; moreMenuOpen = false }
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
        const available = Math.max(1, viewportEl.clientWidth - 24)
        previewScale = Math.min(1, Math.max(0.15, available / viewWidth))
        fitMode = true
    }
    function changeScale(delta: number) {
        fitMode = false
        previewScale = Math.min(2, Math.max(0.15, Math.round((previewScale + delta) * 10) / 10))
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
        }, 400)
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
                if (!ok) console.error('[logexporter] Clipboard copy failed')
            } else {
                await saveAsFile(exportFilename('html'), result.content)
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
</script>

<svelte:window bind:innerWidth={windowWidth} onkeydown={handleKeydown} />

{#if logExporterStore.isOpen}
    <div class="fixed inset-0 z-50 flex flex-col bg-bgcolor text-textcolor" transition:fade={{ duration: 120 }}>
        <!-- Top bar -->
        <div class="flex items-center gap-3 px-4 py-3 border-b border-darkborderc bg-darkbg shrink-0">
            <div class="w-7 h-7 rounded-md bg-darkbutton border border-darkborderc flex items-center justify-center">
                <FileText size={15} />
            </div>
            <span class="text-sm font-semibold">로그 내보내기</span>
            <span class="text-xs text-textcolor2 truncate">{charInfo.name}{charInfo.chatName ? ` · ${charInfo.chatName}` : ''}</span>
            <div class="flex-1"></div>

            <button
                type="button"
                class="p-2 rounded-md border border-darkborderc hover:bg-darkbutton transition-colors"
                class:border-borderc={settings.isEditable}
                onclick={() => setSetting('isEditable', !settings.isEditable)}
                title="편집 모드"
            >
                <Pencil size={14} class={settings.isEditable ? '' : 'opacity-60'} />
            </button>
            <button type="button" id="log-exporter-close" class="p-2 rounded-md border border-darkborderc hover:bg-darkbutton transition-colors" onclick={close} title="닫기 (Esc)">
                <X size={15} />
            </button>
        </div>

        <!-- Body -->
        <div class="flex flex-1 overflow-hidden relative">
            {#if isLoading}
                <div class="flex-1 flex items-center justify-center">
                    <div class="animate-spin w-8 h-8 border-2 border-selected border-t-transparent rounded-full"></div>
                </div>
            {:else if loadError}
                <div class="flex-1 flex items-center justify-center px-8 text-center text-textcolor2">{loadError}</div>
            {:else}
                <!-- Desktop settings sidebar -->
                {#if !isMobile}
                    <div
                        class="flex flex-col h-full border-r border-darkborderc bg-darkbg shrink-0 overflow-hidden transition-all duration-200"
                        style="width:{isSettingsOpen ? '430px' : '0px'};"
                    >
                        <div class="h-full w-[430px] flex flex-col overflow-hidden">
                            {#if activeTab === 'replace'}
                                <ReplaceTab {settings} onChange={setSetting} />
                            {:else}
                                <SettingsPanel
                                    bind:activeTab
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
                            {/if}
                        </div>
                    </div>
                {/if}

                <!-- Preview column -->
                <div class="flex flex-col flex-1 overflow-hidden relative min-w-0">
                    <!-- Sidebar toggle handle -->
                    {#if !isMobile}
                        <button
                            type="button"
                            class="absolute left-0 top-1/2 -translate-y-1/2 z-20 w-[18px] h-12 flex items-center justify-center bg-darkbg border border-l-0 border-darkborderc text-textcolor2 shadow-md"
                            style="border-radius:0 8px 8px 0;"
                            onclick={() => (isSettingsOpen = !isSettingsOpen)}
                            title={isSettingsOpen ? '설정 접기' : '설정 펼치기'}
                        >
                            {#if isSettingsOpen}<ChevronLeft size={14}/>{:else}<ChevronRight size={14}/>{/if}
                        </button>
                    {/if}

                    <!-- Preview toolbar -->
                    <div class="flex items-center gap-2 px-3 py-2 border-b border-darkborderc bg-darkbg shrink-0 text-xs">
                        <SelectInput value={settings.format} size="sm" onchange={(e) => setSetting('format', e.currentTarget.value as ExportFormat)}>
                            {#each EXPORT_FORMAT_OPTIONS as opt (opt.value)}
                                <option value={opt.value}>{opt.label}</option>
                            {/each}
                        </SelectInput>
                        {#if isMobile}
                            <button type="button" class="p-1.5 rounded border border-darkborderc hover:bg-darkbutton" onclick={() => (isMobilePanelOpen = true)} title="설정">
                                <Settings size={13}/>
                            </button>
                        {/if}
                        <div class="flex-1"></div>
                        {#if isBasicFormat}
                            <button class="p-1.5 rounded border border-darkborderc hover:bg-darkbutton" onclick={() => changeScale(-0.1)} title="축소"><ZoomOut size={13}/></button>
                            <span class="tabular-nums w-10 text-center text-textcolor2">{Math.round(previewScale * 100)}%</span>
                            <button class="p-1.5 rounded border border-darkborderc hover:bg-darkbutton" onclick={() => changeScale(0.1)} title="확대"><ZoomIn size={13}/></button>
                            <button class="p-1.5 rounded border border-darkborderc hover:bg-darkbutton" onclick={() => { fitMode = true; fitToViewport() }} title="맞춤"><Maximize size={13}/></button>
                        {/if}
                    </div>

                    <!-- Scaled preview -->
                    <div bind:this={viewportEl} class="flex-1 overflow-auto p-6 relative" style="background:{backgroundColor};">
                        {#if isBasicFormat}
                            <div bind:this={documentEl} class="mx-auto origin-top" style="width:{viewWidth}px;transform:scale({previewScale});margin-bottom:{Math.max(0, documentHeight * (previewScale - 1))}px;">
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
                        {:else if settings.format === 'html'}
                            <div class="mx-auto w-full h-full bg-black/20 rounded-lg overflow-hidden border border-darkborderc">
                                {#if formatPreviewPending && !formatPreview}
                                    <div class="flex items-center justify-center h-full"><div class="animate-spin w-6 h-6 border-2 border-selected border-t-transparent rounded-full"></div></div>
                                {:else}
                                    <iframe title="HTML 미리보기" class="w-full h-full border-0 bg-white" srcdoc={formatPreview}></iframe>
                                {/if}
                            </div>
                        {:else}
                            <pre class="whitespace-pre-wrap break-words mx-auto p-5 rounded-lg border border-darkborderc bg-darkbg text-textcolor font-mono text-sm" style="max-width:800px;">{formatPreview}</pre>
                        {/if}
                    </div>

                    <!-- Action bar -->
                    <div class="shrink-0 border-t border-darkborderc bg-darkbg px-4 py-3 flex items-center gap-2 relative">
                        <Button size="sm" onclick={() => void handleSaveImage()} disabled={progress.active}>
                            <div class="flex items-center gap-2"><ImageIcon size={15}/> 이미지 저장</div>
                        </Button>
                        <div class="relative">
                            <button class="p-2 rounded-md border border-darkborderc hover:bg-darkbutton" onclick={() => (moreMenuOpen = !moreMenuOpen)} title="더보기">
                                <MoreHorizontal size={16}/>
                            </button>
                            {#if moreMenuOpen}
                                <div class="absolute bottom-full mb-2 left-0 z-30 min-w-[180px] rounded-md border border-darkborderc bg-darkbg shadow-xl py-1" transition:fade={{ duration: 80 }}>
                                    <button class="w-full text-left px-3 py-2 text-sm hover:bg-darkbutton flex items-center gap-2" onclick={() => void exportViaHtml('copy')}><Copy size={14}/> HTML 복사</button>
                                    <button class="w-full text-left px-3 py-2 text-sm hover:bg-darkbutton flex items-center gap-2" onclick={() => void exportViaHtml('save')}><FileCode size={14}/> HTML 저장</button>
                                    <div class="my-1 border-t border-darkborderc"></div>
                                    <button class="w-full text-left px-3 py-2 text-sm hover:bg-darkbutton flex items-center gap-2" onclick={() => void handleBackup()}><Download size={14}/> JSON 백업</button>
                                    <button class="w-full text-left px-3 py-2 text-sm hover:bg-darkbutton flex items-center gap-2" onclick={handleRestore}><Upload size={14}/> JSON 복원</button>
                                    {#if settings.isEditable}
                                        <div class="my-1 border-t border-darkborderc"></div>
                                        <button class="w-full text-left px-3 py-2 text-sm hover:bg-darkbutton flex items-center gap-2" onclick={selectAll}><CheckSquare size={14}/> 전체 선택</button>
                                        <button class="w-full text-left px-3 py-2 text-sm hover:bg-darkbutton flex items-center gap-2" onclick={deselectAll}><Square size={14}/> 전체 해제</button>
                                        <button class="w-full text-left px-3 py-2 text-sm hover:bg-darkbutton flex items-center gap-2" onclick={invertSelection}><RefreshCw size={14}/> 선택 반전</button>
                                    {/if}
                                </div>
                            {/if}
                        </div>

                        <div class="flex-1"></div>

                        {#if settings.isEditable}
                            <div class="w-px h-5 bg-darkborderc mx-1"></div>
                            <Button size="sm" styled="danger" disabled={!hasSelection} onclick={deleteSelected}>
                                <div class="flex items-center gap-2"><Trash2 size={15}/> 삭제 ({selectedIndices.size})</div>
                            </Button>
                        {/if}
                    </div>

                    <!-- Progress overlay -->
                    {#if progress.active}
                        <div class="absolute inset-0 z-40 flex items-center justify-center bg-black/50">
                            <div class="rounded-xl border border-darkborderc bg-darkbg px-8 py-6 flex flex-col items-center gap-3 min-w-[280px]">
                                <div class="animate-spin w-7 h-7 border-2 border-selected border-t-transparent rounded-full"></div>
                                <div class="text-sm text-center">{progress.message}</div>
                                {#if progress.total > 1}
                                    <div class="w-full h-1.5 rounded bg-darkbutton overflow-hidden">
                                        <div class="h-full bg-selected transition-all" style="width:{progress.total > 0 ? Math.min(100, (progress.current / progress.total) * 100) : 0}%"></div>
                                    </div>
                                {/if}
                            </div>
                        </div>
                    {/if}

                    <!-- Mobile settings overlay -->
                    {#if isMobile && isMobilePanelOpen}
                        <div class="absolute inset-0 z-40 bg-bgcolor flex flex-col" transition:fade={{ duration: 120 }}>
                            <div class="flex items-center justify-between px-4 py-3 border-b border-darkborderc shrink-0">
                                <span class="text-sm font-semibold">설정</span>
                                <button type="button" class="p-2 rounded-md border border-darkborderc hover:bg-darkbutton" onclick={() => (isMobilePanelOpen = false)}>
                                    <X size={15}/>
                                </button>
                            </div>
                            <div class="flex-1 overflow-hidden">
                                {#if activeTab === 'replace'}
                                    <ReplaceTab {settings} onChange={setSetting} />
                                {:else}
                                    <SettingsPanel
                                        bind:activeTab
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
                                {/if}
                            </div>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    </div>
{/if}
