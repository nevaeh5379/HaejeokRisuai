<script lang="ts">
    import { onDestroy } from 'svelte';
    import { language } from 'src/lang';
    import { modelRequestNotices, type ModelRequestNotice } from 'src/ts/process/request/modelRequestNotices';

    let now = $state(Date.now());
    let ticker: ReturnType<typeof setInterval> | undefined;

    $effect(() => {
        const pending = $modelRequestNotices.some((n) => n.endedAt === undefined);
        if (pending && !ticker) {
            now = Date.now();
            ticker = setInterval(() => (now = Date.now()), 100);
        } else if (!pending && ticker) {
            clearInterval(ticker);
            ticker = undefined;
        }
    });
    onDestroy(() => clearInterval(ticker));

    function elapsed(notice: ModelRequestNotice) {
        const ms = (notice.endedAt ?? now) - notice.startedAt;
        return `${(Math.max(ms, 0) / 1000).toFixed(1)}${language.generationStatsSeconds}`;
    }
</script>

<div class="pointer-events-none fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[10000] flex max-w-[calc(100%-2rem)] flex-col items-end gap-1" role="log" aria-live="polite" aria-relevant="additions">
    {#each $modelRequestNotices as notice (notice.id)}
        <div class="flex max-w-full items-center gap-2 rounded-md border border-darkborderc bg-darkbg px-3 py-2 text-sm text-textcolor shadow-lg" title={notice.model}>
            <span class="truncate">{notice.mode === 'model' ? language.mainModel : language.submodel} · {notice.model}</span>
            <span class="shrink-0 tabular-nums" class:text-textcolor2={notice.endedAt === undefined} class:text-draculared={notice.failed}>{elapsed(notice)}</span>
        </div>
    {/each}
</div>
