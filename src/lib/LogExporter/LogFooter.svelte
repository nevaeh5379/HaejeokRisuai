<script lang="ts">
    import type { ColorPalette, LogExporterSettings, ThemeKey } from 'src/ts/logexporter/types'

    interface Props {
        color: ColorPalette
        settings: LogExporterSettings
        themeKey?: ThemeKey
    }

    let { color, settings, themeKey = 'basic' }: Props = $props()

    const hasFooter = $derived(
        Boolean(settings.footerLeft || settings.footerCenter || settings.footerRight)
    )
</script>

{#if hasFooter}
    {#if themeKey === 'log'}
        <footer style="margin-top:1.5em;padding:1em;background:#1e1e1e;color:#6a9955;font-family:Consolas, Monaco, monospace;font-size:0.85em;border-top:2px solid #444444;display:flex;justify-content:space-between;gap:1em;">
            <span>{settings.footerLeft}</span>
            <span>// {settings.footerCenter}</span>
            <span>{settings.footerRight}</span>
        </footer>
    {:else if themeKey === 'smart'}
        <footer style="margin-top:1.5em;padding:14px 24px;display:flex;justify-content:space-between;gap:1em;color:{color.textSecondary ?? color.text};font-size:0.82em;">
            <span>{settings.footerLeft}</span>
            <span style="opacity:0.7;">{settings.footerCenter}</span>
            <span>{settings.footerRight}</span>
        </footer>
    {:else if themeKey === 'simple'}
        <footer style="margin-top:2em;padding-top:1em;border-top:1px solid {color.border};display:flex;justify-content:space-between;gap:1em;color:{color.textSecondary ?? color.text};font-size:0.85em;">
            <span>{settings.footerLeft}</span>
            <span>{settings.footerCenter}</span>
            <span>{settings.footerRight}</span>
        </footer>
    {:else if themeKey === 'modern'}
        <footer style="margin-top:1.5em;padding:16px 20px;background-color:{color.cardBg};border-radius:10px;border:1px solid {color.border};display:flex;justify-content:space-between;gap:1em;color:{color.textSecondary ?? color.text};font-size:0.85em;box-shadow:{color.shadow};">
            <span>{settings.footerLeft}</span>
            <span>{settings.footerCenter}</span>
            <span>{settings.footerRight}</span>
        </footer>
    {:else}
        <footer style="margin-top:1.8em;padding-top:1em;border-top:1px solid {color.border};display:flex;justify-content:space-between;gap:1em;color:{color.textSecondary ?? color.text};font-size:0.85em;">
            <span>{settings.footerLeft}</span>
            <span>{settings.footerCenter}</span>
            <span>{settings.footerRight}</span>
        </footer>
    {/if}
{/if}
