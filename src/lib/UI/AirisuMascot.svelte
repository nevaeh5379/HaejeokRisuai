<script lang="ts">
    import errorImage from '../../etc/airisu/error-disconnected.png'
    import helpImage from '../../etc/airisu/help-guide.png'
    import progressImage from '../../etc/airisu/progress-delivery.png'
    import welcomeImage from '../../etc/airisu/welcome-wave.png'

    export type AirisuMascotVariant = 'error' | 'help' | 'progress' | 'welcome'

    interface Props {
        variant: AirisuMascotVariant
        alt?: string
        className?: string
        decorative?: boolean
        eager?: boolean
    }

    let {
        variant,
        alt = '',
        className = '',
        decorative = false,
        eager = false,
    }: Props = $props()

    const sources: Record<AirisuMascotVariant, string> = {
        error: errorImage,
        help: helpImage,
        progress: progressImage,
        welcome: welcomeImage,
    }

    const defaultAlt: Record<AirisuMascotVariant, string> = {
        error: 'Airisu looking concerned about a disconnected cable',
        help: 'Airisu holding a helpful guidebook',
        progress: 'Airisu carrying a delivery box',
        welcome: 'Airisu waving hello',
    }

    const resolvedAlt = $derived(decorative ? '' : alt || defaultAlt[variant])
</script>

<img
    src={sources[variant]}
    alt={resolvedAlt}
    aria-hidden={decorative ? 'true' : undefined}
    loading={eager ? 'eager' : 'lazy'}
    decoding="async"
    draggable="false"
    class="block max-w-full select-none object-contain {className}"
/>
