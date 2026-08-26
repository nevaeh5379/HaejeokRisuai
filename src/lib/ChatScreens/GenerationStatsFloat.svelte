<script lang="ts">
    import { onDestroy, onMount } from 'svelte'
    import { language } from '../../lang'
    import { createDeferredTokenCalculator } from '../../ts/deferredTokenCalculator'
    import { calculateChatGenerationMetrics, chatGenerationStats, getChatGenerationStats } from '../../ts/process/chatGenerationStats'

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

    function formatSeconds(seconds: number) {
        return `${seconds.toFixed(1)}${language.generationStatsSeconds}`
    }

    function formatSpeed(tokensPerSecond: number | null) {
        if (tokensPerSecond === null) return '– t/s'
        return `${Math.round(tokensPerSecond).toLocaleString()} t/s`
    }
</script>

{#if visibleStats && metrics}
    <aside
        class="pointer-events-none absolute bottom-20 right-4 z-40 min-w-44 max-w-[min(16rem,calc(100%-2rem))] rounded-lg border border-darkborderc bg-darkbg/95 px-3 py-2 text-sm text-textcolor shadow-lg backdrop-blur-sm"
        role="status"
        aria-live="polite"
        data-testid="generation-stats-float"
    >
        <div class="truncate font-medium" title={visibleStats.model}>{visibleStats.model || language.model}</div>
        <div class="mt-1 text-textcolor2">
            {visibleStats.phase === 'complete' ? language.generationStatsComplete : language.generationStatsGenerating}
            · {outputTokens === null ? '…' : outputTokens.toLocaleString()} {language.tokens}
        </div>
        <div class="mt-0.5 whitespace-nowrap text-textcolor/90">
            {formatSeconds(metrics.totalSeconds)} ({formatSeconds(metrics.generationSeconds)}) · {formatSpeed(metrics.tokensPerSecond)}
        </div>
    </aside>
{/if}
