<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import { language } from '../../lang'
    import { createDeferredTokenCalculator } from '../../ts/deferredTokenCalculator'
    import { calculateChatGenerationMetrics, chatGenerationStats, getChatGenerationStats } from '../../ts/process/chat/generationStats'
    import { settingsStore } from '../../ts/stores/domain/settingsStore.svelte'
    import { modelRequestNoticeHosts, modelRequestNotices } from '../../ts/process/request/modelRequestNotices'
    import GenerationToastCard from './GenerationToastCard.svelte'
    import ModelRequestNoticeStack from './ModelRequestNoticeStack.svelte'

    interface Props {
        selectedChar: number
        selectedChat: number
    }

    let { selectedChar, selectedChat }: Props = $props()
    let now = $state(Date.now())
    let outputTokens = $state<number | null>(null)
    let activeId = $state('')

    const tokenCalculator = createDeferredTokenCalculator({
        calculate: async (text) => {
            const { tokenize } = await import('../../ts/tokenizer')
            return tokenize(text)
        },
        apply: ({ output }) => {
            outputTokens = output
        },
        debounceMs: 250,
    })

    let visibleStats = $derived(
        getChatGenerationStats($chatGenerationStats, selectedChar, selectedChat)
    )

    let position = $derived(settingsStore.state.generationStatsPosition ?? 'bottom-right')

    let positionClass = $derived.by(() => {
        switch (position) {
            case 'bottom-left':
                return 'bottom-20 left-4'
            case 'top-left':
                return 'top-16 left-4'
            case 'top-right':
                return 'top-16 right-4'
            case 'bottom-right':
            default:
                return 'bottom-20 right-4'
        }
    })

    onMount(() => {
        const timer = setInterval(() => {
            if (visibleStats?.phase === 'generating') now = Date.now()
        }, 100)
        return () => clearInterval(timer)
    })

    onDestroy(() => {
        tokenCalculator.dispose()
    })

    $effect(() => {
        const stats = visibleStats
        if (stats?.generationId !== activeId) {
            activeId = stats?.generationId ?? ''
            outputTokens = null
        }
        tokenCalculator.update({ output: stats?.outputText ?? null })
    })
    let metrics = $derived(visibleStats
        ? calculateChatGenerationMetrics(visibleStats, outputTokens, now)
        : null)

    $effect(() => {
        if (position === 'off') return
        modelRequestNoticeHosts.update((count) => count + 1)
        return () => modelRequestNoticeHosts.update((count) => count - 1)
    })
</script>

{#if position !== 'off' && ((visibleStats && metrics) || $modelRequestNotices.length > 0)}
    <div
        class="pointer-events-none absolute {positionClass} z-40 flex max-w-[min(16rem,calc(100%-2rem))] flex-col items-stretch gap-2"
        data-position={position}
    >
        <ModelRequestNoticeStack />
        {#if visibleStats && metrics}
            <GenerationToastCard
                title={`${language.mainModel}: ${visibleStats.model || language.model}`}
                complete={visibleStats.phase === 'complete'}
                tokens={outputTokens}
                totalSeconds={metrics.totalSeconds}
                generationSeconds={metrics.generationSeconds}
                tokensPerSecond={metrics.tokensPerSecond}
                testId="generation-stats-float"
            />
        {/if}
    </div>
{/if}
