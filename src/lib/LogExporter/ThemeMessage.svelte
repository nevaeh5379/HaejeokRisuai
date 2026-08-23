<script lang="ts">
    import Avatar from './Avatar.svelte'
    import MessageContent from './MessageContent.svelte'
    import type {
        ColorPalette,
        LogExporterSettings,
        LogMessageData,
        ThemeKey,
    } from 'src/ts/logexporter/types'

    interface Props {
        message: LogMessageData
        index: number
        color: ColorPalette
        settings: LogExporterSettings
        themeKey: ThemeKey
        showAvatar?: boolean
        showBubble?: boolean
        isForExport?: boolean
        isForImageExport?: boolean
        isSelected?: boolean
        isEditable?: boolean
        avatarMapMode?: boolean
        onSelect?: (index: number, e: MouseEvent) => void
        onRendered?: () => void
        onDelete?: (index: number) => void
        onEditInput?: (index: number, html: string) => void
    }

    let {
        message,
        index,
        color,
        settings,
        themeKey,
        showAvatar = true,
        showBubble = true,
        isForExport = false,
        isForImageExport = false,
        isSelected = false,
        isEditable = false,
        onSelect,
        onRendered,
        onDelete,
        onEditInput,
    }: Props = $props()

    const isUser = $derived(message.isUser)

    // ── Avatar shape resolution ─────────────────────────────────────────────
    const shapeRadius = $derived.by(() => {
        switch (settings.avatarShape) {
            case 'circle': return '50%'
            case 'square': return '0'
            case 'rounded': return '10px'
            case 'squircle': return '12px'
            default: return null // theme default
        }
    })

    function avatarProps(size: number, radius: string | number, border: boolean, borderColor?: string) {
        const r = shapeRadius !== null && themeKey !== 'log' ? shapeRadius : radius
        const b = settings.avatarShape === 'theme'
            ? border
            : settings.avatarShape !== 'square'
        return {
            size,
            radius: r,
            border: b,
            borderColor: borderColor ?? color.avatarBorder,
            shadow: color.shadow ?? 'none',
        }
    }

    const baseFontSize = $derived(`${settings.previewFontSize || 16}px`)

    function stop(e: MouseEvent) {
        if (isEditable) e.stopPropagation()
    }
</script>

{#if themeKey === 'raw'}
    <!-- Raw: unstyled wrapper, content processed for embedding/replacements -->
    <div class="raw-message-wrapper" data-index={index}>
        <MessageContent {message} {color} {settings} allowHtmlRendering={true} {onRendered} {index} />
    </div>
{:else if themeKey === 'log'}
    <!-- Log: monospace terminal row -->
    <div class="chat-message-container" data-log-message-row={index}
        style="position:relative;display:flex;align-items:flex-start;gap:8px;padding:8px 12px;background:{isUser ? color.cardBgUser : color.cardBg};border:1px solid {color.border};margin-bottom:2px;font-family:'Courier New', SF Mono, Monaco, Inconsolata, Fira Code, Consolas, monospace;font-size:{baseFontSize};">
        <div style="color:{color.textSecondary ?? color.text};font-size:calc({baseFontSize} * 0.88);width:35px;flex-shrink:0;text-align:right;padding-right:8px;border-right:1px solid {color.border};opacity:0.6;">{String(index + 1).padStart(4, '0')}</div>
        <div style="color:{color.nameColor};font-size:calc({baseFontSize} * 0.94);width:15px;flex-shrink:0;text-align:center;font-weight:bold;">{isUser ? '→' : '←'}</div>
        <div style="color:{color.nameColor};font-weight:bold;width:80px;flex-shrink:0;text-overflow:ellipsis;overflow:hidden;white-space:nowrap;font-size:calc({baseFontSize} * 0.94);" title={message.name}>[{message.name.toUpperCase()}]</div>
        <div style="color:{color.text};flex:1;line-height:1.4;word-wrap:break-word;">
            <MessageContent {message} {color} {settings} {onRendered} {index} {isEditable} {onEditInput} />
        </div>
        {#if isEditable && onDelete}
            <button type="button" class="log-delete-msg-btn" title="메시지 삭제" onclick={(e) => { e.stopPropagation(); onDelete(index) }}>&times;</button>
        {/if}
    </div>
{:else if themeKey === 'simple'}
    <!-- Simple: minimal text, user indented with left border -->
    <div class="chat-message-container" data-log-message-row={index}
        style="margin-bottom:1.4em;padding-left:{isUser ? '1.5em' : '0'};padding-right:{isUser ? '0' : '1.5em'};border-left:{isUser ? `2px solid ${color.border}` : 'none'};position:relative;">
        <div style="color:{color.nameColor};font-weight:600;font-size:calc({baseFontSize} * 0.88);margin-bottom:0.2em;opacity:0.7;">{message.name}</div>
        <div onclick={stop} style="color:{color.text};line-height:1.7;font-size:{baseFontSize};">
            <MessageContent {message} {color} {settings} {onRendered} {index} {isEditable} {onEditInput} />
        </div>
        {#if isEditable && onDelete}
            <button type="button" class="log-delete-msg-btn" style="float:{isUser ? 'left' : 'right'};opacity:0.3;" title="메시지 삭제" onclick={(e) => { e.stopPropagation(); onDelete(index) }}>&times;</button>
        {/if}
    </div>
{:else if themeKey === 'modern'}
    <!-- Modern: card with integrated name header bar -->
    <div class="chat-message-container" data-log-message-row={index}
        style="position:relative;display:flex;align-items:flex-start;margin-bottom:16px;gap:14px;flex-direction:{isUser ? 'row-reverse' : 'row'};">
        <div style="position:relative;flex-shrink:0;">
            <Avatar avatarSrc={message.avatarUrl} name={message.name} {isUser} {showAvatar} {...avatarProps(44, 12, true)} isForExport={isForExport || isForImageExport} />
            {#if isEditable && onDelete}
                <button type="button" class="log-delete-msg-btn" style="top:-5px;{isUser ? 'right:auto;left:-5px;' : 'right:-5px;left:auto;'}width:18px;height:18px;" title="메시지 삭제" onclick={(e) => { e.stopPropagation(); onDelete(index) }}>&times;</button>
            {/if}
        </div>
        <div style="flex:1;min-width:0;border-radius:10px;background:{isUser ? color.cardBgUser : color.cardBg};box-shadow:{color.shadow};border:1px solid {color.border};overflow:hidden;">
            <div style="color:{color.nameColor};font-weight:600;font-size:calc({baseFontSize} * 0.88);padding:8px 14px;border-bottom:1px solid {color.border};text-align:{isUser ? 'right' : 'left'};opacity:0.9;display:flex;align-items:center;justify-content:{isUser ? 'flex-end' : 'space-between'};">
                <span>{message.name}</span>
                {#if message.time}
                    <span style="font-size:calc({baseFontSize} * 0.75);opacity:0.6;font-weight:400;margin-left:8px;">{new Date(message.time).toLocaleTimeString()}</span>
                {/if}
            </div>
            <div onclick={stop} style="padding:12px 14px;color:{color.text};line-height:1.75;word-wrap:break-word;font-size:{baseFontSize};">
                <MessageContent {message} {color} {settings} {onRendered} {index} {isEditable} {onEditInput} />
            </div>
        </div>
    </div>
{:else if themeKey === 'smart'}
    <!-- Smart: glassmorphism floating card -->
    <div class="chat-message-container" data-log-message-row={index}
        style="position:relative;display:flex;align-items:flex-start;margin-bottom:20px;gap:4px;padding:0 4px;flex-direction:{isUser ? 'row-reverse' : 'row'};">
        <div style="position:relative;flex-shrink:0;">
            <Avatar avatarSrc={message.avatarUrl} name={message.name} {isUser} {showAvatar} {...avatarProps(40, '50%', false)} isForExport={isForExport || isForImageExport} />
            {#if isEditable && onDelete}
                <button type="button" class="log-delete-msg-btn" style="top:-5px;{isUser ? 'right:auto;left:-5px;' : 'right:-5px;left:auto;'}width:18px;height:18px;" title="메시지 삭제" onclick={(e) => { e.stopPropagation(); onDelete(index) }}>&times;</button>
            {/if}
        </div>
        <div style="display:flex;flex-direction:column;align-items:{isUser ? 'flex-end' : 'flex-start'};max-width:85%;min-width:0;">
            {#if !isUser}
                <span style="color:{color.nameColor};font-weight:600;font-size:calc({baseFontSize} * 0.88);margin-bottom:4px;margin-left:6px;opacity:0.85;letter-spacing:0.01em;">{message.name}</span>
            {/if}
            <div style="border-radius:{isUser ? '16px 4px 16px 16px' : '4px 16px 16px 16px'};background:{isUser ? color.cardBgUser : color.cardBg};box-shadow:0 2px 12px rgba(0,0,0,0.06);overflow:hidden;backdrop-filter:blur(12px) saturate(180%);-webkit-backdrop-filter:blur(12px) saturate(180%);border:1px solid {color.border};">
                <div onclick={stop} style="padding:10px 14px;color:{color.text};line-height:1.7;word-wrap:break-word;overflow-wrap:anywhere;font-size:{baseFontSize};">
                    <MessageContent {message} {color} {settings} {onRendered} {index} {isEditable} {onEditInput} />
                </div>
            </div>
        </div>
    </div>
{:else}
    <!-- Basic / Custom: classic bubble layout -->
    {@const cfg = themeKey === 'custom'
        ? { marginBottom: 28, gap: 12, avatarSize: 48, nameSize: 0.94, nameOpacity: 1, padX: 18, padY: 14, lineHeight: 1.8 }
        : { marginBottom: 24, gap: 14, avatarSize: 44, nameSize: 0.88, nameOpacity: 0.85, padX: 16, padY: 12, lineHeight: 1.75 }}
    <div class="chat-message-container" data-log-message-row={index}
        style="position:relative;display:flex;align-items:flex-start;margin-bottom:{cfg.marginBottom}px;gap:{cfg.gap}px;flex-direction:{isUser ? 'row-reverse' : 'row'};">
        {#if isEditable && onDelete}
            <button type="button" class="log-delete-msg-btn" title="메시지 삭제" onclick={(e) => { e.stopPropagation(); onDelete(index) }}>&times;</button>
        {/if}
        <div style="position:relative;flex-shrink:0;">
            <Avatar avatarSrc={message.avatarUrl} name={message.name} {isUser} {showAvatar} {...avatarProps(cfg.avatarSize, '50%', true)} isForExport={isForExport || isForImageExport} />
        </div>
        <div style="flex:1;min-width:0;">
            <strong style="color:{color.nameColor};font-weight:600;font-size:calc({baseFontSize} * {cfg.nameSize});display:block;margin-bottom:6px;text-align:{isUser ? 'right' : 'left'};opacity:{cfg.nameOpacity};">{message.name}</strong>
            {#if showBubble}
                <div onclick={stop} style="background-color:{isUser ? color.cardBgUser : color.cardBg};border-radius:{isUser ? '16px 4px 16px 16px' : '16px'};padding:{cfg.padY}px {cfg.padX}px;box-shadow:{color.shadow};border:1px solid {color.border};color:{color.text};line-height:{cfg.lineHeight};word-wrap:break-word;position:relative;font-size:{baseFontSize};">
                    <MessageContent {message} {color} {settings} {onRendered} {index} {isEditable} {onEditInput} />
                </div>
            {:else}
                <div onclick={stop} style="color:{color.text};line-height:{cfg.lineHeight};word-wrap:break-word;padding:2px 4px;font-size:{baseFontSize};">
                    <MessageContent {message} {color} {settings} {onRendered} {index} {isEditable} {onEditInput} />
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    .log-delete-msg-btn {
        position: absolute;
        top: -6px;
        left: -6px;
        width: 16px;
        height: 16px;
        font-size: 12px;
        line-height: 14px;
        padding: 0;
        border: none;
        border-radius: 50%;
        background-color: rgba(200, 50, 50, 0.7);
        color: #fff;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 10;
    }
</style>
