<script lang="ts">
    import { processMessageHtml, getCachedProcessedHtml, setCachedProcessedHtml } from 'src/ts/logexporter/messageRenderer'
    import type {
        ColorPalette,
        LogExporterSettings,
        LogMessageData,
        MessageDisplayOptions,
    } from 'src/ts/logexporter/types'

    interface Props extends MessageDisplayOptions {
        message: LogMessageData
        color: ColorPalette
        settings: LogExporterSettings
        allowHtmlRendering?: boolean
        onRendered?: () => void
        index: number
        isEditable?: boolean
        /** Fires while typing in editable mode */
        onEditInput?: (index: number, html: string) => void
    }

    let {
        message,
        color,
        settings,
        allowHtmlRendering = false,
        onRendered,
        index,
        isEditable = false,
        onEditInput,
    }: Props = $props()

    let html = $state('')
    let contentEl: HTMLDivElement | null = $state(null)

    const signature = $derived(JSON.stringify({
        key: message.key,
        embed: settings.embedImages,
        color: color.background + color.quoteBg + color.thoughtBg,
        rules: settings.replacementRules,
        scale: settings.imageScale ?? 100,
        align: settings.imageAlign,
        style: settings.imageStyle,
        crop: [settings.imageCropActive, settings.imageCropAspectRatio, settings.imageCropVAlign, settings.imageCropHAlign, settings.imageCropHeight],
        htmlRendering: allowHtmlRendering,
    }))

    $effect(() => {
        const sig = signature
        const cached = getCachedProcessedHtml(sig)
        if (cached !== undefined) {
            if (html !== cached) html = cached
            onRendered?.()
            return
        }
        let cancelled = false
        processMessageHtml({
            html: message.html,
            embedImages: settings.embedImages,
            color,
            replacementRules: settings.replacementRules,
            allowHtmlRendering,
            imageScale: settings.imageScale,
            imageAlign: settings.imageAlign,
            imageStyle: settings.imageStyle,
            imageCropActive: settings.imageCropActive,
            imageCropAspectRatio: settings.imageCropAspectRatio,
            imageCropVAlign: settings.imageCropVAlign,
            imageCropHAlign: settings.imageCropHAlign,
            imageCropHeight: settings.imageCropHeight,
        }).then((result) => {
            if (cancelled) return
            setCachedProcessedHtml(sig, result)
            html = result
            onRendered?.()
        }).catch((e) => {
            console.error('[logexporter] Message processing failed:', e)
            if (!cancelled) {
                html = message.html
                onRendered?.()
            }
        })
        return () => {
            cancelled = true
        }
    })

    // Sync processed html into the DOM node (skips node currently being edited)
    $effect(() => {
        if (contentEl && !isEditable && contentEl.innerHTML !== html) {
            contentEl.innerHTML = html
        }
    })

    function handleInput() {
        if (isEditable && contentEl) {
            onEditInput?.(index, contentEl.innerHTML)
        }
    }
</script>

<div
    bind:this={contentEl}
    class="log-message-content"
    contenteditable={isEditable}
    oninput={handleInput}
></div>
