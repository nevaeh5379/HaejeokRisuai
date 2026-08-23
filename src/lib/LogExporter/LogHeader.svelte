<script lang="ts">
    import { imageUrlToDataUrl } from 'src/ts/logexporter/messageRenderer'
    import type {
        CharInfo,
        ColorPalette,
        HeaderLayout,
        LogExporterSettings,
        ThemeKey,
    } from 'src/ts/logexporter/types'

    interface Props {
        charInfo: CharInfo
        color: ColorPalette
        settings: LogExporterSettings
        themeKey?: ThemeKey
        layout?: HeaderLayout
        isForExport?: boolean
    }

    let { charInfo, color, settings, themeKey = 'basic', layout = 'default', isForExport = false }: Props = $props()

    const tags = $derived(
        (settings.headerTags ?? '')
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
    )

    // Resolved avatar/banner data URLs for self-contained exports
    let avatarSrc = $state('')
    let bannerSrc = $state('')
    $effect(() => {
        let cancelled = false
        const avatarUrl = charInfo.avatarUrl
        if (avatarUrl && (settings.embedImages || !avatarUrl.startsWith('data:'))) {
            imageUrlToDataUrl(avatarUrl).then((u) => { if (!cancelled) avatarSrc = u })
        } else {
            avatarSrc = avatarUrl ?? ''
        }
        const banner = settings.headerBannerUrl || avatarUrl || ''
        if (banner) {
            imageUrlToDataUrl(banner).then((u) => { if (!cancelled) bannerSrc = u })
        } else {
            bannerSrc = ''
        }
        return () => { cancelled = true }
    })

    const effectiveLayout = $derived.by(() => {
        if (themeKey === 'smart') return 'smart'
        if (themeKey === 'simple') return 'simple'
        if (themeKey === 'modern') return 'modern'
        if (themeKey === 'log') return 'log'
        return layout
    })

    function tagStyle(variant: string): string {
        const textColor = color.textSecondary ?? color.text
        switch (variant) {
            case 'modern':
                return `font-size:0.72em;color:${color.textSecondary};background-color:rgba(0,0,0,0.2);padding:2px 8px;border-radius:4px;border:1px solid ${color.border};`
            case 'smart':
                return `font-size:0.72em;color:${color.nameColor};background:${color.quoteBg};padding:3px 9px;border-radius:6px;font-weight:600;`
            case 'banner':
                return `background:rgba(0,0,0,0.4);color:#fff;padding:4px 10px;border-radius:100px;font-size:0.78em;border:1px solid rgba(255,255,255,0.2);`
            case 'cover':
                return `font-size:0.72em;padding:2px 7px;border-radius:4px;border:1px solid ${color.border};color:${color.textSecondary};opacity:0.8;`
            case 'compact':
                return `background:${color.cardBg};color:${textColor};padding:2px 8px;border-radius:100px;font-size:0.72em;border:1px solid ${color.border};`
            default:
                return `background:${color.cardBg};color:${textColor};padding:3px 10px;border-radius:100px;font-size:0.78em;border:1px solid ${color.border};`
        }
    }

    const showIcon = $derived(settings.showHeaderIcon !== false)
</script>

{#snippet headerTags(variant: string)}
    {#if tags.length > 0}
        {#if variant === 'simple'}
            <div style="font-size:0.82em;color:{color.textSecondary ?? color.text};">{tags.join(' · ')}</div>
        {:else}
            <div style="display:flex;gap:{variant === 'default' ? '6px' : '5px'};flex-wrap:wrap;margin-top:{variant === 'default' ? '0.8em' : variant === 'compact' ? '0.6em' : variant === 'smart' ? '6px' : '0'};justify-content:{variant === 'cover' ? 'flex-end' : variant === 'default' || variant === 'compact' ? 'center' : 'flex-start'};">
                {#each tags as tag}
                    <span style={tagStyle(variant)}>{tag}</span>
                {/each}
            </div>
        {/if}
    {/if}
{/snippet}

{#if effectiveLayout === 'log'}
    <!-- IDE / terminal style header -->
    <header style="margin-bottom:2em;padding:1.5em;background:#1e1e1e;color:#cccccc;font-family:Consolas, Monaco, monospace;font-size:0.9em;border-left:4px solid {color.nameColor || '#569cd6'};line-height:1.6;">
        <div style="margin-bottom:0.5em;"><span style="color:#569cd6;">&gt; TARGET_ID:</span> <span style="color:#ce9178;">"{charInfo.name}"</span></div>
        <div style="margin-bottom:0.5em;"><span style="color:#569cd6;">&gt; CONTEXT:</span> <span style="color:#ce9178;">"{charInfo.chatName}"</span></div>
        <div style="margin-bottom:0.5em;"><span style="color:#569cd6;">&gt; DATE:</span> <span style="color:#b5cea8;">{new Date().toISOString().slice(0, 10)}</span></div>
        {#if tags.length > 0}
            <div style="margin-bottom:0.5em;"><span style="color:#569cd6;">&gt; TAGS:</span> [{tags.map((t) => `'${t}'`).join(', ')}]</div>
        {/if}
        <div style="margin-top:1em;border-top:1px dashed #444444;padding-top:0.5em;color:#6a9955;">// Recording started...</div>
    </header>
{:else if effectiveLayout === 'simple'}
    <header style="padding-bottom:0.8em;margin-bottom:1.6em;border-bottom:1px solid {color.border};display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:baseline;gap:10px;">
            <h1 style="margin:0;font-size:1.4em;font-weight:700;color:{color.nameColor};">{charInfo.name}</h1>
            <span style="font-size:0.88em;color:{color.textSecondary ?? color.text};">{charInfo.chatName}</span>
        </div>
        {@render headerTags('simple')}
    </header>
{:else if effectiveLayout === 'modern'}
    <header style="display:flex;align-items:center;gap:20px;padding:20px;margin-bottom:2em;background-color:{color.cardBg};border-radius:12px;border:1px solid {color.border};box-shadow:{color.shadow};">
        {#if showIcon}
            <div style="position:relative;flex-shrink:0;">
                <img src={avatarSrc || charInfo.avatarUrl} alt="{charInfo.name} avatar" data-log-exporter-avatar="true" style="width:72px;height:72px;border-radius:12px;object-fit:cover;display:block;border:1px solid {color.border};" />
                <div aria-hidden="true" style="position:absolute;bottom:-3px;right:-3px;width:14px;height:14px;border-radius:50%;background-color:#22c55e;border:3px solid {color.cardBg};"></div>
            </div>
        {/if}
        <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px;flex-wrap:wrap;">
                <h1 style="margin:0;font-size:1.5em;color:{color.nameColor};font-weight:700;letter-spacing:-0.02em;">{charInfo.name}</h1>
                {@render headerTags('modern')}
            </div>
            <p style="margin:0;color:{color.text};opacity:0.75;font-size:0.9em;line-height:1.5;">{charInfo.chatName}</p>
        </div>
    </header>
{:else if effectiveLayout === 'smart'}
    <header style="padding:20px 0 32px;display:flex;justify-content:center;">
        <div style="display:flex;align-items:center;gap:20px;padding:20px 28px;background:{color.cardBg};backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);border-radius:20px;border:1px solid {color.border};box-shadow:0 8px 32px rgba(0,0,0,0.2);max-width:90%;min-width:280px;">
            {#if showIcon}
                <div style="position:relative;flex-shrink:0;">
                    <div aria-hidden="true" style="position:absolute;top:10%;left:10%;right:10%;bottom:10%;background:{color.nameColor};filter:blur(16px);opacity:0.3;border-radius:50%;z-index:0;"></div>
                    <img src={avatarSrc || charInfo.avatarUrl} alt="{charInfo.name} avatar" data-log-exporter-avatar="true" style="position:relative;z-index:1;width:76px;height:76px;border-radius:18px;object-fit:cover;display:block;box-shadow:0 4px 12px rgba(0,0,0,0.1);" />
                </div>
            {/if}
            <div style="display:flex;flex-direction:column;gap:3px;min-width:0;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <h1 style="margin:0;font-size:1.6em;color:{color.text};font-weight:700;letter-spacing:-0.01em;line-height:1.2;">{charInfo.name}</h1>
                    <span aria-hidden="true" style="width:5px;height:5px;border-radius:50%;background:{color.nameColor};opacity:0.7;"></span>
                </div>
                <p style="margin:0;color:{color.textSecondary ?? color.text};font-size:0.9em;font-weight:500;">{charInfo.chatName}</p>
                {@render headerTags('smart')}
            </div>
        </div>
    </header>
{:else if effectiveLayout === 'compact'}
    <header style="padding-bottom:0.8em;margin-bottom:1.2em;border-bottom:1px solid {color.border};">
        <div style="display:flex;align-items:center;justify-content:center;gap:12px;">
            {#if showIcon}
                <img src={avatarSrc || charInfo.avatarUrl} alt="{charInfo.name} avatar" data-log-exporter-avatar="true" style="width:44px;height:44px;border-radius:50%;object-fit:cover;box-shadow:{color.shadow};" />
            {/if}
            <div style="text-align:left;">
                <h1 style="color:{color.nameColor};margin:0;font-size:1.3em;font-weight:700;">{charInfo.name}</h1>
                <p style="color:{color.textSecondary ?? color.text};opacity:0.7;margin:0;font-size:0.8em;">{charInfo.chatName}</p>
            </div>
        </div>
        {@render headerTags('compact')}
    </header>
{:else if effectiveLayout === 'banner'}
    <header style="position:relative;display:flex;align-items:center;gap:18px;padding:20px;margin-bottom:1.5em;border-radius:10px;color:#fff;overflow:hidden;">
        <div style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:1;transform:scale(1.05);">
            {#if isForExport && bannerSrc}
                <img src={bannerSrc} alt="" style="width:100%;height:100%;object-fit:cover;object-position:center {settings.headerBannerAlign}%;filter:{settings.headerBannerBlur ? 'blur(2px) brightness(0.55)' : 'brightness(0.65)'};" />
            {:else}
                <div style="width:100%;height:100%;object-fit:cover;object-position:center {settings.headerBannerAlign}%;filter:{settings.headerBannerBlur ? 'blur(2px) brightness(0.55)' : 'brightness(0.65)'};background-image:{bannerSrc ? `url('${bannerSrc}')` : `linear-gradient(135deg, ${color.cardBg}, ${color.background})`};background-size:cover;background-position:center {settings.headerBannerAlign}%;"></div>
            {/if}
        </div>
        <div style="position:relative;z-index:2;display:flex;align-items:center;gap:18px;width:100%;">
            {#if showIcon}
                <img src={avatarSrc || charInfo.avatarUrl} alt="{charInfo.name} avatar" data-log-exporter-avatar="true" style="width:82px;height:82px;border-radius:50%;object-fit:cover;box-shadow:0 2px 10px rgba(0,0,0,0.4);flex-shrink:0;" />
            {/if}
            <div style="text-align:left;">
                <h1 style="color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.8);margin:0 0 0.2em 0;font-size:1.8em;font-weight:700;">{charInfo.name}</h1>
                <p style="opacity:0.85;margin:0 0 0.8em 0;font-size:0.95em;">{charInfo.chatName}</p>
                {@render headerTags('banner')}
            </div>
        </div>
    </header>
{:else if effectiveLayout === 'cover'}
    <header style="margin-bottom:3em;position:relative;background-color:{color.background};">
        <div style="height:240px;width:100%;position:relative;overflow:hidden;background-color:#333;">
            <div style="position:absolute;top:0;left:0;right:0;bottom:0;background-image:{bannerSrc ? `url('${bannerSrc}')` : 'none'};background-size:cover;background-position:center {settings.headerBannerAlign}%;filter:{settings.headerBannerBlur ? 'blur(6px)' : 'none'};opacity:0.9;{settings.headerBannerBlur ? 'transform:scale(1.05);' : ''}"></div>
            <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:linear-gradient(to bottom, transparent 50%, rgba(0,0,0,0.6) 100%);"></div>
        </div>
        <div style="max-width:900px;margin:0 auto;position:relative;padding:0 28px;display:flex;align-items:flex-end;gap:20px;margin-top:-44px;">
            {#if showIcon}
                <div style="flex-shrink:0;position:relative;">
                    <img src={avatarSrc || charInfo.avatarUrl} alt="{charInfo.name} avatar" data-log-exporter-avatar="true" style="width:140px;height:140px;border-radius:14px;object-fit:cover;border:4px solid {color.background};box-shadow:0 4px 12px rgba(0,0,0,0.2);background-color:{color.cardBg};display:block;" />
                </div>
            {/if}
            <div style="flex:1;padding-bottom:14px;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;">
                <div style="position:relative;">
                    <h1 style="margin:0;font-size:2em;font-weight:800;color:{color.text};text-shadow:0 2px 8px rgba(0,0,0,0.3);line-height:1;position:relative;z-index:1;">
                        {charInfo.name}
                        <span aria-hidden="true" style="position:absolute;bottom:2px;left:0;width:100%;height:6px;background:{color.nameColor};opacity:0.25;z-index:-1;border-radius:3px;"></span>
                    </h1>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;">
                    {#if charInfo.chatName}
                        <p style="margin:0;font-size:0.9em;color:{color.text};font-weight:600;background:{color.cardBg};padding:3px 10px;border-radius:100px;border:1px solid {color.border};">{charInfo.chatName}</p>
                    {/if}
                    {@render headerTags('cover')}
                </div>
            </div>
        </div>
    </header>
{:else}
    <!-- Default centered header -->
    <header style="text-align:center;padding-bottom:1.2em;margin-bottom:1.8em;border-bottom:1px solid {color.border};">
        {#if showIcon}
            <img src={avatarSrc || charInfo.avatarUrl} alt="{charInfo.name} avatar" data-log-exporter-avatar="true" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin:0 auto 0.8em;display:block;border:2px solid {color.avatarBorder};box-shadow:{color.shadow};" />
        {/if}
        <h1 style="color:{color.nameColor};margin:0 0 0.2em 0;font-size:1.6em;font-weight:700;letter-spacing:-0.01em;">{charInfo.name}</h1>
        <p style="color:{color.textSecondary ?? color.text};opacity:0.8;margin:0;font-size:0.88em;">{charInfo.chatName}</p>
        {@render headerTags('default')}
    </header>
{/if}
