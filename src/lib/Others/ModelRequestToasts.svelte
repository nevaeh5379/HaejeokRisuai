<script lang="ts">
    import ModelRequestNoticeStack from '../ChatScreens/ModelRequestNoticeStack.svelte';
    import { modelRequestNoticeHosts, modelRequestNotices } from 'src/ts/process/request/modelRequestNotices';
</script>

{#if $modelRequestNoticeHosts === 0 && $modelRequestNotices.length > 0}
    <div class="pointer-events-none fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[10000] flex max-w-[min(16rem,calc(100%-2rem))] flex-col items-stretch gap-2">
        <ModelRequestNoticeStack />
    </div>
{/if}
