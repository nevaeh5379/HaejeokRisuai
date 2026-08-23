<script lang="ts">
    import type { AvatarShape } from 'src/ts/logexporter/types'

    interface Props {
        avatarSrc?: string
        name: string
        isUser: boolean
        showAvatar?: boolean
        size?: number
        radius?: string | number
        border?: boolean
        borderColor?: string
        shadow?: string
        isForExport?: boolean
    }

    let {
        avatarSrc,
        name,
        isUser,
        showAvatar = true,
        size = 44,
        radius = '50%',
        border = true,
        borderColor = '#7aa2f7',
        shadow = 'none',
        isForExport = false,
    }: Props = $props()

    const initial = $derived(
        isUser ? 'U' : (name?.trim()?.charAt(0)?.toUpperCase() ?? '?')
    )

    const shapeStyle = $derived.by(() => {
        const r = typeof radius === 'number' ? `${radius}px` : radius
        return `width:${size}px;height:${size}px;min-width:${size}px;border-radius:${r};box-shadow:${shadow};${border ? `border:1px solid ${borderColor};` : ''}`
    })
</script>

{#if showAvatar}
    {#if avatarSrc}
        {#if isForExport}
            <img src={avatarSrc} alt="{name} avatar" data-log-exporter-avatar="true" style="{shapeStyle}object-fit:cover;display:block;" />
        {:else}
            <div role="img" aria-label="{name} avatar" data-log-exporter-avatar="true" style="{shapeStyle}background-image:url('{avatarSrc}');background-size:cover;background-position:center;background-repeat:no-repeat;"></div>
        {/if}
    {:else}
        <div role="img" aria-label="{name} avatar" data-log-exporter-avatar="true" style="{shapeStyle}background-color:#3a3f4a;display:flex;align-items:center;justify-content:center;user-select:none;overflow:hidden;">
            <span style="color:#c0c5cf;font-weight:600;font-size:1.1em;line-height:1;text-transform:uppercase;">{initial}</span>
        </div>
    {/if}
{/if}
