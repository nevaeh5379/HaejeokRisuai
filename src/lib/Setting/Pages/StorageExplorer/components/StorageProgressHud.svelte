<script lang="ts">
    import { ChevronDownIcon, ChevronUpIcon, Loader2Icon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { NodeS3ProgressEvent } from '../types'

    interface Props {
        activeTask: 'migrate' | 'rollback' | null
        progressData: NodeS3ProgressEvent | null
    }

    const { activeTask, progressData }: Props = $props()

    let minimized = $state(false)
</script>

{#if activeTask && progressData}
    <div
        class="fixed bottom-4 left-4 right-4 z-60 md:left-auto md:right-6 md:w-96 rounded-xl border border-darkborderc bg-darkbg/95 p-3.5 sm:p-4 text-textcolor shadow-2xl backdrop-blur-md transition-all duration-300 animate-in slide-in-from-bottom"
    >
        <!-- Header -->
        <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
                <Loader2Icon class="h-4 w-4 animate-spin text-blue-400 shrink-0" />
                <h5 class="truncate text-xs sm:text-sm font-semibold">
                    {activeTask === 'migrate' ? language.s3MigratingTitle : language.s3RollingBackTitle}
                </h5>
            </div>
            <div class="flex items-center gap-2 shrink-0">
                <span class="text-xs sm:text-sm font-bold text-blue-400">
                    {progressData.percentage}%
                </span>
                <button
                    type="button"
                    class="p-0.5 text-textcolor2 hover:text-textcolor rounded cursor-pointer"
                    onclick={() => minimized = !minimized}
                    aria-label={minimized ? 'Expand' : 'Minimize'}
                >
                    {#if minimized}
                        <ChevronUpIcon class="h-4 w-4" />
                    {:else}
                        <ChevronDownIcon class="h-4 w-4" />
                    {/if}
                </button>
            </div>
        </div>

        <!-- Progress bar track -->
        <div class="mt-2.5 h-2 w-full overflow-hidden rounded-full border border-darkborderc bg-bgcolor/50">
            <div
                class="h-full bg-linear-to-r from-blue-500 via-indigo-500 to-purple-600 transition-[width] duration-150"
                style="width: {progressData.percentage}%"
            ></div>
        </div>

        {#if !minimized}
            <!-- Details -->
            <div class="mt-2.5 flex items-center justify-between text-xs text-textcolor2">
                <div>
                    {progressData.current.toLocaleString()} / {progressData.total.toLocaleString()} {language.storageFiles}
                </div>
                {#if activeTask === 'migrate'}
                    <div>
                        {language.storageUpload}: <span class="font-medium text-textcolor">{progressData.migrated ?? 0}</span> · {language.storageSkip}: <span class="font-medium text-textcolor">{progressData.skipped ?? 0}</span>
                    </div>
                {:else}
                    <div>
                        {language.storageDownload}: <span class="font-medium text-textcolor">{progressData.downloaded ?? 0}</span>
                    </div>
                {/if}
            </div>

            {#if progressData.currentKey}
                <div class="mt-1 truncate text-[11px] text-textcolor2/70 font-mono" title={progressData.currentKey}>
                    {progressData.currentKey}
                </div>
            {/if}
        {/if}
    </div>
{/if}
