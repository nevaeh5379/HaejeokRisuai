<script lang="ts">
    import { language } from '../../lang'

    interface Props {
        title: string
        complete: boolean
        failed?: boolean
        tokens: number | null
        totalSeconds: number
        generationSeconds: number | null
        tokensPerSecond: number | null
        testId?: string
    }

    let { title, complete, failed = false, tokens, totalSeconds, generationSeconds, tokensPerSecond, testId }: Props = $props()

    function formatSeconds(seconds: number) {
        return `${seconds.toFixed(1)}${language.generationStatsSeconds}`
    }

    function formatSpeed(value: number | null) {
        if (value === null) return '– t/s'
        return `${Math.round(value).toLocaleString()} t/s`
    }
</script>

<aside
    class="pointer-events-none min-w-44 max-w-full rounded-lg border border-darkborderc bg-darkbg/95 px-3 py-2 text-sm text-textcolor shadow-lg backdrop-blur-sm"
    role="status"
    aria-live="polite"
    data-testid={testId}
>
    <div class="truncate font-medium" {title}>{title}</div>
    <div class="mt-1 text-textcolor2" class:text-draculared={failed}>
        {failed ? language.error : complete ? language.generationStatsComplete : language.generationStatsGenerating}
        · {tokens === null ? '…' : tokens.toLocaleString()} {language.tokens}
    </div>
    <div class="mt-0.5 whitespace-nowrap text-textcolor/90">
        {formatSeconds(totalSeconds)}{#if generationSeconds !== null} ({formatSeconds(generationSeconds)}){/if} · {formatSpeed(tokensPerSecond)}
    </div>
</aside>
