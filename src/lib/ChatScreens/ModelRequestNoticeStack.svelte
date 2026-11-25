<script lang="ts">
    import { onDestroy } from 'svelte'
    import { modelRequestNotices } from '../../ts/process/request/modelRequestNotices'
    import ModelRequestNoticeCard from './ModelRequestNoticeCard.svelte'

    let now = $state(Date.now())
    let ticker: ReturnType<typeof setInterval> | undefined

    $effect(() => {
        const pending = $modelRequestNotices.some((n) => n.endedAt === undefined)
        if (pending && !ticker) {
            now = Date.now()
            ticker = setInterval(() => (now = Date.now()), 100)
        } else if (!pending && ticker) {
            clearInterval(ticker)
            ticker = undefined
        }
    })
    onDestroy(() => clearInterval(ticker))
</script>

{#each $modelRequestNotices as notice (notice.id)}
    <ModelRequestNoticeCard {notice} {now} />
{/each}
