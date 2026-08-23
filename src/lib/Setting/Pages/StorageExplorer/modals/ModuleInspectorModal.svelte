<script lang="ts">
    import {
        CopyIcon,
        LayersIcon,
        PackageIcon,
        XIcon
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import { formatBytes, isImageFile } from '../utils'
    import type { ModuleStorageInfo } from '../types'

    interface Props {
        module: ModuleStorageInfo
        thumbnailUrls: Map<string, string>
        onLoadThumbnail: (key: string) => void
        onOpenPreview: (key: string) => void
        onClose: () => void
    }

    const {
        module,
        thumbnailUrls,
        onLoadThumbnail,
        onOpenPreview,
        onClose
    }: Props = $props()

    let copiedKey = $state<string | null>(null)

    async function copyKey(key: string) {
        try {
            await navigator.clipboard.writeText(key)
            copiedKey = key
            setTimeout(() => {
                if (copiedKey === key) copiedKey = null
            }, 1500)
        } catch {
            // ignore
        }
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4 backdrop-blur-xs animate-in fade-in duration-200"
    onclick={onClose}
>
    <div
        class="flex max-h-[90vh] sm:max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-t-2xl sm:rounded-2xl border border-darkborderc bg-darkbg text-textcolor shadow-2xl"
        onclick={(e) => e.stopPropagation()}
    >
        <!-- Modal Header -->
        <div class="flex items-center justify-between border-b border-darkborderc px-4 sm:px-5 py-3.5">
            <div class="flex items-center gap-3 min-w-0">
                <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-darkborderc bg-darkbutton text-violet-400">
                    <PackageIcon class="h-5 w-5" />
                </div>
                <div class="min-w-0">
                    <h3 class="truncate text-sm sm:text-base font-bold">{module.name}</h3>
                    <div class="flex items-center gap-2 text-xs text-textcolor2">
                        <span>{module.totalAssets} {language.storageAssets}</span>
                        <span>·</span>
                        <span class="font-semibold text-textcolor">{formatBytes(module.totalSizeBytes)}</span>
                    </div>
                </div>
            </div>
            <button
                type="button"
                class="rounded-lg p-1.5 text-textcolor2 hover:bg-darkborderc/50 hover:text-textcolor transition-colors cursor-pointer"
                onclick={onClose}
                aria-label="Close"
            >
                <XIcon class="h-5 w-5" />
            </button>
        </div>

        <!-- Modal Body -->
        <div class="flex-1 overflow-y-auto p-3 sm:p-5">
            {#if module.assets.length === 0}
                <div class="py-12 text-center text-sm text-textcolor2">{language.storageNoAssetsFound}</div>
            {:else}
                <div class="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {#each module.assets as asset (asset.key)}
                        <div class="flex items-center gap-3 rounded-xl border border-darkborderc bg-bgcolor/40 p-2.5 transition-colors hover:border-darkborderc/80">
                            <button
                                type="button"
                                class="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-darkborderc bg-darkbutton transition-opacity hover:opacity-80 cursor-pointer"
                                onclick={() => onOpenPreview(asset.key)}
                                title={language.storagePreview}
                            >
                                {#if isImageFile(asset.key)}
                                    {@const _ = onLoadThumbnail(asset.key)}
                                    {#if thumbnailUrls.has(asset.key)}
                                        <img src={thumbnailUrls.get(asset.key)} alt="" class="h-full w-full object-cover" />
                                    {:else}
                                        <div class="flex h-full w-full items-center justify-center text-xs text-textcolor2">img</div>
                                    {/if}
                                {:else}
                                    <LayersIcon class="h-5 w-5 text-textcolor2" />
                                {/if}
                            </button>
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center justify-between gap-1">
                                    <span class="rounded-md bg-darkbutton px-1.5 py-0.5 text-[10px] font-medium text-textcolor2">
                                        {asset.type === 'moduleIcon' ? language.storageModuleIcon : language.storageModuleAsset}
                                    </span>
                                    <span class="text-xs font-semibold text-textcolor">{formatBytes(asset.size)}</span>
                                </div>
                                <h5 class="mt-1 truncate text-xs font-medium text-textcolor" title={asset.label}>{asset.label}</h5>
                                <div class="mt-0.5 flex items-center justify-between gap-1">
                                    <span class="truncate font-mono text-[10px] text-textcolor2/70" title={asset.key}>{asset.key}</span>
                                    <button
                                        type="button"
                                        class="shrink-0 p-0.5 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                                        onclick={() => copyKey(asset.key)}
                                        title={copiedKey === asset.key ? 'Copied!' : 'Copy Key'}
                                    >
                                        <CopyIcon class="h-3 w-3 {copiedKey === asset.key ? 'text-green-400' : ''}" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    {/each}
                </div>
            {/if}
        </div>

        <div class="flex justify-end border-t border-darkborderc bg-darkbg/50 px-4 sm:px-5 py-3">
            <Button onclick={onClose}>{language.storageClose}</Button>
        </div>
    </div>
</div>
