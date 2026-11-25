<script lang="ts">
    import { language } from '../../lang'
    import type { ModelRequestNotice } from '../../ts/process/request/modelRequestNotices'
    import GenerationToastCard from './GenerationToastCard.svelte'

    interface Props {
        notice: ModelRequestNotice
        now: number
    }

    let { notice, now }: Props = $props()
    let tokens = $state<number | null>(null)

    $effect(() => {
        const text = notice.outputText
        if (!text) {
            tokens = notice.endedAt === undefined ? null : 0
            return
        }
        let current = true
        void import('../../ts/tokenizer')
            .then(({ tokenize }) => tokenize(text))
            .then((count) => {
                if (current) tokens = count
            })
            .catch(() => {})
        return () => {
            current = false
        }
    })

    let totalSeconds = $derived(Math.max(0, (notice.endedAt ?? now) - notice.startedAt) / 1000)
</script>

<GenerationToastCard
    title={`${notice.mode === 'model' ? language.mainModel : language.submodel}: ${notice.model}`}
    complete={notice.endedAt !== undefined}
    failed={notice.failed}
    {tokens}
    {totalSeconds}
    generationSeconds={null}
    tokensPerSecond={tokens && totalSeconds > 0 ? tokens / totalSeconds : null}
    testId="model-request-toast"
/>
