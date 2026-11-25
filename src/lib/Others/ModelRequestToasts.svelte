<script lang="ts">
    import { language } from 'src/lang';
    import { modelRequestNotices } from 'src/ts/process/request/modelRequestNotices';
</script>

<div class="pointer-events-none fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[10000] flex max-w-[calc(100%-2rem)] flex-col items-end gap-1" role="log" aria-live="polite" aria-relevant="additions">
    {#each $modelRequestNotices as notice (notice.id)}
        <div class="max-w-full truncate rounded-md border border-darkborderc bg-darkbg px-3 py-2 text-sm text-textcolor shadow-lg" title={notice.model}>
            {notice.mode === 'model' ? language.mainModel : language.submodel} · {notice.model}
        </div>
    {/each}
</div>
