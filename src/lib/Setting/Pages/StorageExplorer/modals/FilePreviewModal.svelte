<script lang="ts">
    import { CopyIcon, XIcon } from '@lucide/svelte'
    import { language } from 'src/lang'

    interface Props {
        assetKey: string | null
        imageUrl: string | null
        onClose: () => void
    }

    const {
        assetKey,
        imageUrl,
        onClose
    }: Props = $props()

    let copied = $state(false)

    async function copyKey() {
        if (!assetKey) return
        try {
            await navigator.clipboard.writeText(assetKey)
            copied = true
            setTimeout(() => copied = false, 1500)
        } catch {
            // ignore
        }
    }
</script>

{#if assetKey}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="fixed inset-0 z-70 flex items-center justify-center bg-black/80 p-3 sm:p-4 backdrop-blur-md animate-in fade-in duration-150"
        onclick={onClose}
    >
        <div
            class="relative flex max-h-[92vh] max-w-[95vw] sm:max-w-[85vw] flex-col overflow-hidden rounded-2xl border border-darkborderc bg-darkbg p-2.5 sm:p-3 shadow-2xl"
            onclick={(e) => e.stopPropagation()}
        >
            <button
                type="button"
                class="absolute right-4 top-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/70 text-white hover:bg-black/90 transition-colors cursor-pointer"
                onclick={onClose}
                aria-label="Close"
            >
                <XIcon class="h-4 w-4" />
            </button>

            <div class="flex flex-1 items-center justify-center min-h-[160px] overflow-hidden">
                {#if imageUrl}
                    <img
                        src={imageUrl}
                        alt={assetKey}
                        class="max-h-[75vh] max-w-[85vw] object-contain rounded-lg shadow-inner"
                    />
                {:else}
                    <div class="p-12 text-center text-sm text-textcolor2">
                        {language.storageLoadingPreview}
                    </div>
                {/if}
            </div>

            <div class="mt-2.5 flex items-center justify-center gap-2 border-t border-darkborderc/50 pt-2 px-2">
                <span class="max-w-[70vw] truncate font-mono text-xs text-textcolor2" title={assetKey}>
                    {assetKey}
                </span>
                <button
                    type="button"
                    class="p-1 text-textcolor2 hover:text-textcolor transition-colors cursor-pointer"
                    onclick={copyKey}
                    title={copied ? 'Copied!' : 'Copy Key'}
                >
                    <CopyIcon class="h-3.5 w-3.5 {copied ? 'text-green-400' : ''}" />
                </button>
            </div>
        </div>
    </div>
{/if}
