<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import {
        FileIcon,
        HardDriveIcon,
        ImageIcon,
        MusicIcon,
        RefreshCwIcon,
        SearchIcon,
        Trash2Icon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm } from 'src/ts/alert'
    import { forageStorage, getFileSrc } from 'src/ts/globalApi.svelte'

    interface Props {
        close?: () => void
    }

    type FilterType = 'all' | 'image' | 'audio' | 'other'

    const { close = () => {} }: Props = $props()
    let keys = $state<string[]>([])
    let search = $state('')
    let filter = $state<FilterType>('all')
    let page = $state(1)
    let pageSize = $state(100)
    let loading = $state(false)
    let error = $state('')
    let storageUsage = $state<number | null>(null)
    let storageQuota = $state<number | null>(null)
    let previewKey = $state('')
    let previewUrl = $state('')

    const isImage = (key: string) => /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(key)
    const isAudio = (key: string) => /\.(mp3|wav|ogg|flac|aac|m4a|webm)$/i.test(key)

    const filteredKeys = $derived.by(() => {
        const query = search.trim().toLowerCase()
        return keys.filter((key) => {
            if (query && !key.toLowerCase().includes(query)) return false
            if (filter === 'image') return isImage(key)
            if (filter === 'audio') return isAudio(key)
            if (filter === 'other') return !isImage(key) && !isAudio(key)
            return true
        })
    })
    const totalPages = $derived(Math.max(1, Math.ceil(filteredKeys.length / pageSize)))
    const safePage = $derived(Math.min(page, totalPages))
    const pagedKeys = $derived(filteredKeys.slice((safePage - 1) * pageSize, safePage * pageSize))

    function formatBytes(value: number | null): string {
        if (value == null) return '—'
        if (value === 0) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
        return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`
    }

    async function refresh() {
        loading = true
        error = ''
        try {
            await forageStorage.Init()
            keys = (await forageStorage.keys())
                .filter((key) => key.startsWith('assets/'))
                .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            const estimate = await navigator.storage?.estimate?.()
            storageUsage = estimate?.usage ?? null
            storageQuota = estimate?.quota ?? null
        } catch (err) {
            error = `${err}`
            keys = []
        } finally {
            loading = false
        }
    }

    function clearPreview() {
        if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
        previewKey = ''
        previewUrl = ''
    }

    async function openPreview(key: string) {
        clearPreview()
        previewKey = key
        if (!isImage(key) && !isAudio(key)) return
        try {
            previewUrl = await getFileSrc(key, { transient: true })
        } catch (err) {
            error = `${err}`
        }
    }

    async function deleteKey(key: string) {
        if (!(await alertConfirm(`Delete browser asset?\n${key}`))) return
        try {
            await forageStorage.removeItem(key)
            if (previewKey === key) clearPreview()
            await refresh()
        } catch (err) {
            error = `${err}`
        }
    }
    onMount(refresh)
    onDestroy(clearPreview)
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && (previewKey ? clearPreview() : close())} />

<div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-0 sm:p-3 md:p-5"
    onclick={close}
    role="presentation"
>
    <div
        class="flex h-full w-full sm:h-[94vh] sm:max-h-[980px] sm:max-w-6xl flex-col overflow-hidden rounded-none sm:rounded-2xl border-0 sm:border border-darkborderc bg-bgcolor text-textcolor shadow-2xl"
        onclick={(event) => event.stopPropagation()}
        role="presentation"
    >
        <header class="flex items-center justify-between gap-2 border-b border-darkborderc p-3 bg-darkbg shrink-0">
            <div class="flex items-center gap-2.5 min-w-0">
                <div class="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
                    <HardDriveIcon size={19} />
                </div>
                <div class="min-w-0">
                    <h2 class="font-bold truncate">{language.storageExplorer}</h2>
                    <p class="text-xs text-textcolor2 truncate">Browser local asset storage</p>
                </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <span class="hidden sm:inline rounded-full border border-darkborderc bg-darkbutton px-2.5 py-1 text-[11px] text-textcolor2">
                    {formatBytes(storageUsage)} / {formatBytes(storageQuota)}
                </span>
                <button class="rounded-lg p-2 text-textcolor2 hover:bg-darkbutton hover:text-textcolor" disabled={loading} onclick={refresh} title="Refresh">
                    <RefreshCwIcon size={17} class={loading ? 'animate-spin' : ''} />
                </button>
                <button class="rounded-lg p-2 text-textcolor2 hover:bg-darkbutton hover:text-textcolor" onclick={close} title="Close">
                    <XIcon size={18} />
                </button>
            </div>
        </header>

        <div class="flex flex-wrap items-center gap-2 border-b border-darkborderc p-3 shrink-0">
            <div class="relative min-w-[220px] flex-1">
                <SearchIcon class="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-textcolor2" />
                <input
                    bind:value={search}
                    oninput={() => page = 1}
                    placeholder="Search asset keys"
                    class="w-full rounded-lg border border-darkborderc bg-darkbg py-2 pl-9 pr-3 text-sm text-textcolor outline-hidden"
                />
            </div>
            <div class="flex items-center gap-1 rounded-lg border border-darkborderc bg-darkbg p-1 text-xs">
                {#each [['all', 'All'], ['image', 'Images'], ['audio', 'Audio'], ['other', 'Other']] as item}
                    <button
                        class="rounded-md px-2.5 py-1.5 {filter === item[0] ? 'bg-selected text-textcolor' : 'text-textcolor2 hover:text-textcolor'}"
                        onclick={() => {
                            filter = item[0] as FilterType
                            page = 1
                        }}
                    >{item[1]}</button>
                {/each}
            </div>
            <span class="text-xs text-textcolor2">{filteredKeys.length.toLocaleString()} / {keys.length.toLocaleString()}</span>
        </div>

        {#if error}
            <div class="m-3 rounded-lg border border-draculared/50 bg-draculared/10 p-3 text-xs text-draculared">{error}</div>
        {/if}

        <main class="flex-1 min-h-0 overflow-y-auto p-3">
            {#if loading && keys.length === 0}
                <div class="flex h-full items-center justify-center text-textcolor2">
                    <RefreshCwIcon size={18} class="mr-2 animate-spin" /> Loading browser storage…
                </div>
            {:else if filteredKeys.length === 0}
                <div class="flex h-full items-center justify-center text-sm text-textcolor2">No browser assets found.</div>
            {:else}
                <div class="grid grid-cols-1 gap-2 lg:grid-cols-2">
                    {#each pagedKeys as key (key)}
                        <div class="flex items-center gap-3 rounded-xl border border-darkborderc bg-darkbg p-3 hover:bg-darkbutton/40">
                            <button
                                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-darkborderc bg-darkbutton text-textcolor2 hover:text-textcolor"
                                onclick={() => openPreview(key)}
                                title="Preview"
                            >
                                {#if isImage(key)}
                                    <ImageIcon size={18} />
                                {:else if isAudio(key)}
                                    <MusicIcon size={18} />
                                {:else}
                                    <FileIcon size={18} />
                                {/if}
                            </button>
                            <button class="min-w-0 flex-1 text-left" onclick={() => openPreview(key)}>
                                <div class="truncate font-mono text-xs text-textcolor" title={key}>{key}</div>
                                <div class="mt-1 text-[11px] text-textcolor2">
                                    {isImage(key) ? 'Image' : isAudio(key) ? 'Audio' : 'Asset'}
                                </div>
                            </button>
                            <button
                                class="rounded-lg p-2 text-textcolor2 hover:bg-rose-500/20 hover:text-rose-300"
                                onclick={() => deleteKey(key)}
                                title="Delete"
                            >
                                <Trash2Icon size={16} />
                            </button>
                        </div>
                    {/each}
                </div>
                <div class="sticky bottom-0 mt-3 flex items-center justify-between gap-3 rounded-xl border border-darkborderc bg-darkbg/95 p-2.5 text-xs text-textcolor2 backdrop-blur-sm">
                    <select
                        value={pageSize}
                        onchange={(event) => {
                            pageSize = Number((event.currentTarget as HTMLSelectElement).value)
                            page = 1
                        }}
                        class="rounded-md border border-darkborderc bg-bgcolor px-2 py-1 text-textcolor"
                    >
                        <option value={50}>50 / page</option>
                        <option value={100}>100 / page</option>
                        <option value={200}>200 / page</option>
                    </select>
                    <div class="flex items-center gap-2">
                        <button class="rounded-md border border-darkborderc px-2.5 py-1 disabled:opacity-40" disabled={safePage <= 1} onclick={() => page = safePage - 1}>Previous</button>
                        <span>{safePage.toLocaleString()} / {totalPages.toLocaleString()}</span>
                        <button class="rounded-md border border-darkborderc px-2.5 py-1 disabled:opacity-40" disabled={safePage >= totalPages} onclick={() => page = safePage + 1}>Next</button>
                    </div>
                </div>
            {/if}
        </main>
    </div>
</div>

{#if previewKey}
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/75 p-4" onclick={clearPreview} role="presentation">
        <div class="max-h-[90vh] max-w-4xl rounded-2xl border border-darkborderc bg-bgcolor p-4 shadow-2xl" onclick={(event) => event.stopPropagation()} role="presentation">
            <div class="mb-3 flex items-center justify-between gap-3">
                <span class="max-w-[75vw] truncate font-mono text-xs text-textcolor2">{previewKey}</span>
                <button class="rounded-lg p-1.5 text-textcolor2 hover:bg-darkbutton hover:text-textcolor" onclick={clearPreview}><XIcon size={18} /></button>
            </div>
            {#if isImage(previewKey) && previewUrl}
                <img src={previewUrl} alt="" class="max-h-[75vh] max-w-full rounded-lg object-contain" />
            {:else if isAudio(previewKey) && previewUrl}
                <audio src={previewUrl} controls class="w-[min(80vw,640px)]"></audio>
            {:else}
                <div class="flex min-h-32 items-center justify-center text-sm text-textcolor2">Preview is not available for this asset type.</div>
            {/if}
        </div>
    </div>
{/if}
