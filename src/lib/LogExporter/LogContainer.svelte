<script lang="ts">
    import LogHeader from './LogHeader.svelte'
    import LogFooter from './LogFooter.svelte'
    import ThemeMessage from './ThemeMessage.svelte'
    import { resolveEffectiveColor } from 'src/ts/logexporter/constants'
    import { effectiveFontSize } from 'src/ts/logexporter/messageRenderer'
    import type { LogRenderProps } from 'src/ts/logexporter/types'

    let {
        data,
        selectedThemeKey = 'basic',
        selectedColorKey = 'dark',
        color,
        customCss,
        settings,
        fontSize,
        containerWidth,
        selectedIndices,
        onMessageSelect,
        onMessageDelete,
        onMessageEditInput,
        isForImageExport = false,
        isForExport = false,
        onReady,
    }: LogRenderProps = $props()

    const palette = $derived(resolveEffectiveColor(selectedThemeKey, selectedColorKey, color))
    const themeKey = $derived(selectedThemeKey ?? 'basic')
    const messages = $derived(data.messages)
    const isLogTheme = $derived(themeKey === 'log')

    // ── Export readiness tracking ────────────────────────────────────────────
    let renderedCount = $state(0)
    let rootEl: HTMLDivElement | null = $state(null)

    const exportComplete = $derived(isForExport && renderedCount >= messages.length)

    $effect(() => {
        if (exportComplete && rootEl && isForExport) {
            rootEl.setAttribute('data-log-render-complete', 'true')
            onReady?.()
        }
    })

    function handleRendered() {
        if (isForExport || isForImageExport) {
            renderedCount++
        } else {
            onReady?.()
        }
    }

    function handleMessageSelect(index: number, e: MouseEvent) {
        onMessageSelect?.(index, e)
    }

    function containerStyle(): string {
        const baseWidth = containerWidth ? Number(containerWidth) : 900
        const scale = Number(settings.htmlScaleFactor) || 1
        const isFull = settings.htmlScaleMode === 'full'
        const fontPx = effectiveFontSize(fontSize, settings.htmlScaleMode, settings.htmlScaleFactor)
        // In 'full' mode the transform visually scales everything, so compensate
        // the layout width by the factor to keep the document's footprint at the
        // fixed preview width (the scale changes the composition inside the
        // frame, not the frame size itself).
        const widthPx = isFull ? baseWidth / scale : baseWidth
        const scaleRule = isFull
            ? `transform:scale(${scale});transform-origin:top left;--log-scale:${scale}`
            : ''
        return [
            `margin:${isForImageExport ? '0' : '16px auto'}`,
            `width:${widthPx}px`,
            'max-width:none',
            'box-sizing:border-box',
            `font-size:${fontPx}px`,
            `background-color:${palette.background}`,
            `color:${palette.text}`,
            `border-radius:${isLogTheme ? '8px' : '12px'}`,
            isFull ? 'overflow:visible' : 'overflow:hidden',
            `padding:${isLogTheme ? '0' : '24px 32px'}`,
            isLogTheme ? 'border:none' : `border:1px solid ${palette.border}`,
            isLogTheme ? 'box-shadow:none' : `box-shadow:${palette.shadow || 'none'}`,
            scaleRule,
        ].filter(Boolean).join(';')
    }
</script>

{#snippet messageRow(message: (typeof messages)[0], index: number)}
    <div data-log-message-key={message.key}>
        {#if settings.isEditable && !isForExport && !isForImageExport}
            <div
                class="log-select-row"
                style="display:flex;align-items:center;border-radius:4px;{selectedIndices?.has(index) ? 'background-color:rgba(0,123,255,0.2);' : ''}"
                role="button"
                tabindex="0"
                onclick={(e) => handleMessageSelect(index, e)}
                onkeydown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault()
                        handleMessageSelect(index, e as unknown as MouseEvent)
                    }
                }}
            >
                <input type="checkbox" checked={selectedIndices?.has(index)} onclick={(e) => { e.stopPropagation(); handleMessageSelect(index, e as unknown as MouseEvent) }} style="margin:0 10px;cursor:pointer;" />
                <div style="flex:1;min-width:0;">
                    <ThemeMessage
                        {message}
                        {index}
                        color={palette}
                        {settings}
                        themeKey={themeKey}
                        showAvatar={settings.showAvatar}
                        showBubble={settings.showBubble}
                        isSelected={selectedIndices?.has(index)}
                        isEditable={true}
                        onDelete={() => onMessageDelete?.(index)}
                        onEditInput={onMessageEditInput}
                    />
                </div>
            </div>
        {:else}
            <ThemeMessage
                {message}
                {index}
                color={palette}
                {settings}
                themeKey={themeKey}
                showAvatar={settings.showAvatar}
                showBubble={settings.showBubble}
                {isForExport}
                isForImageExport={isForImageExport}
                onRendered={() => handleRendered()}
            />
        {/if}
    </div>
{/snippet}

<div bind:this={rootEl} class="risu-log-container" style={containerStyle()} data-theme={themeKey} role="region" aria-label="Chat Log Container">
    {#if themeKey === 'custom' && customCss}
        {@html `<style>${customCss}</style>`}
    {/if}

    {#if settings.disableAnimations}
        {@html `<style>*, *::before, *::after { animation: none !important; transition: none !important; }</style>`}
    {/if}

    {#if settings.showHeader}
        <LogHeader charInfo={data.charInfo} color={palette} {settings} themeKey={themeKey} layout={settings.headerLayout} {isForExport} />
    {/if}

    <main class="risu-log-messages">
        {#each messages as message, index (message.key)}
            {@render messageRow(message, index)}
        {/each}
    </main>

    {#if settings.showFooter}
        <LogFooter color={palette} {settings} themeKey={themeKey} />
    {/if}
</div>

<style>
    .risu-log-container :global(.log-message-content) {
        outline: none;
    }
    .risu-log-container :global(.log-select-row:hover) {
        background-color: rgba(0, 123, 255, 0.08);
    }
    .risu-log-container :global(.raw-message-wrapper .prose),
    .risu-log-container :global(.raw-message-wrapper .chattext) {
        font-size: 1em !important;
        line-height: inherit;
    }
</style>
