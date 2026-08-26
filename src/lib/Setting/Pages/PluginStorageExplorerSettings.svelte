<script lang="ts">
    import { onMount } from 'svelte'
    import {
        CopyIcon,
        DatabaseIcon,
        CircleQuestionMarkIcon,
        PlusIcon,
        RefreshCwIcon,
        SaveIcon,
        SearchIcon,
        Trash2Icon,
        XIcon
    } from '@lucide/svelte'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import { language } from 'src/lang'
    import { alertNormal } from 'src/ts/alert'
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte'

    interface Props {
        close?: () => void
    }

    const { close = () => {} }: Props = $props()
    let keys = $state<string[]>([])
    let selectedKey = $state('')
    let keyDraft = $state('')
    let newKey = $state('')
    let search = $state('')
    let editor = $state('')
    let loadedValue = $state<any>(undefined)
    let busy = $state(false)
    let saving = $state(false)
    let error = $state('')
    let dirty = $state(false)

    const filteredKeys = $derived.by(() => {
        const query = search.trim().toLowerCase()
        if (!query) return keys
        return keys.filter((key) => key.toLowerCase().includes(query))
    })

    const valueType = $derived.by(() => {
        if (loadedValue === null) return 'null'
        if (Array.isArray(loadedValue)) return 'array'
        return typeof loadedValue
    })

    const valueBytes = $derived.by(() => {
        try {
            return new TextEncoder().encode(JSON.stringify(loadedValue) ?? '').byteLength
        } catch {
            return 0
        }
    })

    function formatBytes(bytes: number) {
        if (bytes < 1024) return `${bytes} B`
        const units = ['KB', 'MB', 'GB']
        let value = bytes / 1024
        for (const unit of units) {
            if (value < 1024 || unit === 'GB') return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`
            value /= 1024
        }
        return `${bytes} B`
    }

    function serialize(value: any) {
        const json = JSON.stringify(value, null, 2)
        return json === undefined ? 'null' : json
    }

    function refreshKeys() {
        keys = settingsStore.getPluginCustomStorageKeys().slice().sort((a, b) => a.localeCompare(b))
        if (selectedKey && !keys.includes(selectedKey)) {
            selectedKey = ''
            keyDraft = ''
            editor = ''
            loadedValue = undefined
            dirty = false
        }
    }

    async function selectKey(key: string) {
        if (busy || key === selectedKey) return
        busy = true
        error = ''
        try {
            const value = await settingsStore.loadPluginCustomStorageKey(key)
            selectedKey = key
            keyDraft = key
            loadedValue = value
            editor = serialize(value)
            dirty = false
        } catch (err) {
            error = `${err}`
        } finally {
            busy = false
        }
    }

    async function createKey() {
        const key = newKey.trim()
        if (!key) return
        if (settingsStore.hasPluginCustomStorageKey(key)) {
            error = language.pluginStorageExplorerDuplicateKey
            return
        }
        error = ''
        settingsStore.setPluginCustomStorageKey(key, {})
        await settingsStore.flush()
        newKey = ''
        refreshKeys()
        await selectKey(key)
    }

    async function saveValue() {
        if (!selectedKey) return
        saving = true
        error = ''
        try {
            const parsed = JSON.parse(editor)
            settingsStore.setPluginCustomStorageKey(selectedKey, parsed)
            await settingsStore.flush()
            loadedValue = parsed
            editor = serialize(parsed)
            dirty = false
        } catch (err) {
            error = err instanceof SyntaxError
                ? language.pluginStorageExplorerInvalidJson
                : `${err}`
        } finally {
            saving = false
        }
    }

    async function renameKey() {
        const nextKey = keyDraft.trim()
        if (!selectedKey || !nextKey || nextKey === selectedKey) return
        if (settingsStore.hasPluginCustomStorageKey(nextKey)) {
            error = language.pluginStorageExplorerDuplicateKey
            return
        }
        saving = true
        error = ''
        try {
            const parsed = JSON.parse(editor)
            settingsStore.setPluginCustomStorageKey(nextKey, parsed)
            settingsStore.removePluginCustomStorageKey(selectedKey)
            await settingsStore.flush()
            selectedKey = nextKey
            keyDraft = nextKey
            loadedValue = parsed
            dirty = false
            refreshKeys()        } catch (err) {
            error = err instanceof SyntaxError
                ? language.pluginStorageExplorerInvalidJson
                : `${err}`
        } finally {
            saving = false
        }
    }

    async function deleteSelected() {
        if (!selectedKey) return
        if (!window.confirm(language.pluginStorageExplorerDeleteConfirm.replace('{key}', selectedKey))) return
        settingsStore.removePluginCustomStorageKey(selectedKey)
        await settingsStore.flush()
        refreshKeys()
    }

    async function clearAll() {
        if (keys.length === 0) return
        if (!window.confirm(language.pluginStorageExplorerClearConfirm)) return
        settingsStore.clearPluginCustomStorage()
        await settingsStore.flush()
        refreshKeys()
    }

    async function copyValue() {
        if (!selectedKey) return
        await navigator.clipboard.writeText(editor)
    }

    function prettyPrint() {
        try {
            editor = JSON.stringify(JSON.parse(editor), null, 2)
            dirty = true
            error = ''
        } catch {
            error = language.pluginStorageExplorerInvalidJson
        }
    }
    onMount(() => {
        refreshKeys()
        if (keys.length > 0) void selectKey(keys[0])
    })
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && close()} />

<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-3 md:p-5 lg:p-6"
    onclick={close}
    role="presentation"
>
    <div
        class="flex h-full w-full sm:h-[94vh] sm:max-h-[980px] sm:max-w-6xl md:max-w-7xl lg:max-w-[110rem] flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-darkborderc bg-bgcolor text-textcolor shadow-2xl"
        onclick={(event) => event.stopPropagation()}
        role="presentation"
    >
        <header class="flex items-center justify-between gap-2 border-b border-darkborderc p-2.5 sm:p-3 shrink-0 bg-darkbg select-none">
            <div class="flex items-center gap-2.5 min-w-0">
                <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20 shrink-0">
                    <DatabaseIcon class="h-5 w-5" />
                </div>
                <div class="min-w-0 flex items-center gap-1.5">
                    <h2 class="text-sm sm:text-base font-bold truncate">{language.pluginStorageExplorer}</h2>
                    <button
                        type="button"
                        class="shrink-0 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer p-0.5"
                        title={language.pluginStorageExplorerDescription}
                        onclick={() => alertNormal(language.pluginStorageExplorerDescription)}
                        aria-label={language.showHelp}
                    >
                        <CircleQuestionMarkIcon size={14} />
                    </button>
                </div>
            </div>            <div class="flex items-center gap-2 shrink-0">
                <span class="hidden sm:inline rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-violet-500/15 text-violet-300 border border-violet-500/25">
                    {keys.length} {language.pluginStorageExplorerKeys}
                </span>
                <Button size="sm" disabled={busy || saving} onclick={refreshKeys}>
                    <RefreshCwIcon size={14} />
                    <span class="hidden sm:inline">{language.postgresDbExplorerRefresh}</span>
                </Button>
                <button class="cursor-pointer p-1.5 text-textcolor2 hover:text-green-500 rounded-lg hover:bg-darkbutton transition-colors" onclick={close} aria-label="Close">
                    <XIcon size={18} />
                </button>
            </div>
        </header>

        {#if error}
            <div class="mx-3 mt-3 rounded-xl border border-draculared/50 bg-draculared/10 p-3 text-xs text-draculared shrink-0">
                {error}
            </div>
        {/if}

        <main class="flex flex-1 min-h-0 overflow-hidden flex-col md:flex-row">
            <aside class="w-full md:w-80 md:shrink-0 border-b md:border-b-0 md:border-r border-darkborderc bg-darkbg/50 flex flex-col min-h-0 max-h-[42%] md:max-h-none">
                <div class="p-3 border-b border-darkborderc flex flex-col gap-2">
                    <div class="relative">
                        <SearchIcon size={15} class="absolute left-3 top-1/2 -translate-y-1/2 text-textcolor2" />
                        <input bind:value={search} class="w-full rounded-lg border border-darkborderc bg-bgcolor py-2 pl-9 pr-3 text-sm outline-none focus:border-violet-500" placeholder={language.pluginStorageExplorerSearch} />
                    </div>                    <div class="flex gap-2">
                        <input bind:value={newKey} onkeydown={(event) => event.key === 'Enter' && createKey()} class="min-w-0 flex-1 rounded-lg border border-darkborderc bg-bgcolor px-3 py-2 text-sm outline-none focus:border-violet-500" placeholder={language.pluginStorageExplorerNewKey} />
                        <Button size="sm" disabled={!newKey.trim() || saving} onclick={createKey}>
                            <PlusIcon size={14} />
                        </Button>
                    </div>
                </div>

                <div class="flex-1 overflow-y-auto min-h-0 p-2">
                    {#if filteredKeys.length === 0}
                        <div class="px-3 py-8 text-center text-xs text-textcolor2">
                            {keys.length === 0 ? language.pluginStorageExplorerEmpty : language.pluginStorageExplorerNoMatches}
                        </div>
                    {:else}
                        {#each filteredKeys as key}
                            <button
                                class="w-full rounded-lg px-3 py-2.5 text-left text-sm transition-colors flex items-center gap-2 {selectedKey === key ? 'bg-violet-500/15 text-textcolor border border-violet-500/25' : 'hover:bg-darkbutton text-textcolor2 border border-transparent'}"
                                onclick={() => selectKey(key)}
                            >
                                <DatabaseIcon size={14} class="shrink-0" />
                                <span class="truncate font-mono text-xs">{key}</span>
                            </button>
                        {/each}
                    {/if}
                </div>

                <div class="p-3 border-t border-darkborderc">
                    <button class="w-full flex items-center justify-center gap-2 rounded-lg border border-draculared/40 px-3 py-2 text-xs text-draculared hover:bg-draculared/10 disabled:opacity-40" disabled={keys.length === 0 || saving} onclick={clearAll}>
                        <Trash2Icon size={14} />
                        {language.pluginStorageExplorerClearAll}
                    </button>
                </div>
            </aside>
            <section class="flex flex-1 min-w-0 min-h-0 flex-col">
                {#if busy}
                    <div class="flex flex-1 items-center justify-center text-sm text-textcolor2">
                        <RefreshCwIcon size={20} class="animate-spin mr-2 text-violet-400" />
                        {language.postgresDbExplorerLoading}
                    </div>
                {:else if selectedKey}
                    <div class="border-b border-darkborderc p-3 flex flex-col gap-3 bg-darkbg/30">
                        <div class="flex flex-col sm:flex-row gap-2 sm:items-center">
                            <input
                                bind:value={keyDraft}
                                class="min-w-0 flex-1 rounded-lg border border-darkborderc bg-bgcolor px-3 py-2 font-mono text-xs outline-none focus:border-violet-500"
                            />
                            <Button size="sm" disabled={saving || !keyDraft.trim() || keyDraft.trim() === selectedKey} onclick={renameKey}>
                                {language.pluginStorageExplorerRename}
                            </Button>
                        </div>
                        <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-textcolor2">
                            <span>{valueType} · {formatBytes(valueBytes)}</span>
                            {#if dirty}<span class="text-amber-300">{language.pluginStorageExplorerUnsaved}</span>{/if}
                        </div>
                    </div>
                    <div class="flex-1 min-h-0 p-3">
                        <textarea
                            bind:value={editor}
                            oninput={() => dirty = true}
                            spellcheck="false"
                            class="h-full w-full resize-none rounded-xl border border-darkborderc bg-darkbg p-3 font-mono text-xs sm:text-sm leading-5 text-textcolor outline-none focus:border-violet-500"
                        ></textarea>
                    </div>

                    <div class="border-t border-darkborderc p-3 flex flex-wrap items-center justify-between gap-2 bg-darkbg/30">
                        <span class="text-[11px] text-textcolor2">{language.pluginStorageExplorerJsonHint}</span>
                        <div class="flex flex-wrap items-center justify-end gap-2">
                            <Button size="sm" onclick={copyValue} disabled={saving}>
                                <CopyIcon size={14} />
                                {language.pluginStorageExplorerCopy}
                            </Button>
                            <Button size="sm" onclick={prettyPrint} disabled={saving}>
                                {language.pluginStorageExplorerFormat}
                            </Button>
                            <button class="flex items-center gap-1.5 rounded-lg border border-draculared/40 px-3 py-1.5 text-xs text-draculared hover:bg-draculared/10 disabled:opacity-40" disabled={saving} onclick={deleteSelected}>
                                <Trash2Icon size={14} />
                                {language.pluginStorageExplorerDelete}
                            </button>                            <Button size="sm" onclick={saveValue} disabled={saving || !dirty}>
                                <SaveIcon size={14} />
                                {saving ? language.pluginStorageExplorerSaving : language.pluginStorageExplorerSave}
                            </Button>
                        </div>
                    </div>
                {:else}
                    <div class="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-textcolor2">
                        <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
                            <DatabaseIcon size={26} />
                        </div>
                        <div>
                            <p class="text-sm font-medium text-textcolor">{language.pluginStorageExplorerSelectKey}</p>
                            <p class="mt-1 text-xs">{language.pluginStorageExplorerJsonHint}</p>
                        </div>
                    </div>
                {/if}
            </section>
        </main>
    </div>
</div>