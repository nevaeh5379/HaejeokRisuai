import type {
    ColorPalette,
    ImageStyle,
    LogExporterSettings,
    ReplacementRule,
    MessageDisplayOptions,
} from './types'

/**
 * Message HTML processing for the Log Exporter.
 * Native port of the plugin's useMessageProcessor pipeline operating on
 * already-parsed HTML strings: image embedding, decorative frames, cropping,
 * formatted blocks and regex replacements.
 */

// ─── Image URL embedding ─────────────────────────────────────────────────────

const dataUrlCache = new Map<string, string>()

/** Converts any image URL into a data URL so exports are self-contained. */
export async function imageUrlToDataUrl(url: string): Promise<string> {
    if (!url || url.startsWith('data:')) return url
    const cached = dataUrlCache.get(url)
    if (cached) return cached
    try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const blob = await res.blob()
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(reader.result as string)
            reader.onerror = reject
            reader.readAsDataURL(blob)
        })
        if (dataUrlCache.size > 300) dataUrlCache.clear()
        dataUrlCache.set(url, dataUrl)
        return dataUrl
    } catch (e) {
        console.warn('[logexporter] Failed to embed image:', url.slice(0, 80), e)
        return url
    }
}

export function clearImageUrlCache(): void {
    dataUrlCache.clear()
}

// ─── Replacement rules ───────────────────────────────────────────────────────

function applyRulesToString(text: string, rules: ReplacementRule[]): string {
    let result = text
    for (const rule of rules) {
        if (rule.isEnabled === false) continue
        if (!rule.pattern) continue
        try {
            if (rule.isRegex) {
                let flags = rule.flags ?? 'g'
                if (!flags.includes('g')) flags += 'g'
                result = result.replace(new RegExp(rule.pattern, flags), rule.replacement)
            } else {
                while (result.includes(rule.pattern)) {
                    result = result.replace(rule.pattern, rule.replacement)
                }
            }
        } catch (e) {
            console.warn('[logexporter] Invalid replacement rule:', rule.pattern, e)
        }
    }
    return result
}

export function applyReplacements(root: HTMLElement, rules?: ReplacementRule[]): void {
    if (!rules || rules.length === 0) return
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    let current = walker.nextNode()
    while (current) {
        textNodes.push(current as Text)
        current = walker.nextNode()
    }
    for (const node of textNodes) {
        const replaced = applyRulesToString(node.textContent ?? '', rules)
        if (replaced !== node.textContent) {
            node.textContent = replaced
        }
    }
}

// ─── Aspect ratio helpers ────────────────────────────────────────────────────

function getAspectRatioCssValue(aspectRatio?: string, customHeight?: number): string {
    switch (aspectRatio) {
        case '1:1': return '1 / 1'
        case '3:4': return '3 / 4'
        case '4:3': return '4 / 3'
        case '9:16': return '9 / 16'
        case '16:9': return '16 / 9'
        case 'custom': return `1 / ${customHeight || 1}`
        default: return ''
    }
}

const PLACEHOLDER_CAPTIONS = new Set([
    'character portrait', 'character-portrait', 'image', 'avatar',
    'user portrait', 'user-portrait', 'attachment', 'file', 'portrait',
])
const FILE_EXTENSION_REGEX = /\.(png|jpe?g|webp|gif|bmp)$/i
const HASH_FILENAME_REGEX = /^[a-f0-9\-_]+$/i

function isCustomCaption(alt: string | null | undefined): boolean {
    if (!alt) return false
    const trimmed = alt.trim()
    if (!trimmed) return false
    const lower = trimmed.toLowerCase()
    if (PLACEHOLDER_CAPTIONS.has(lower)) return false
    if (lower.startsWith('/sw/') || lower.includes('/') || lower.includes('\\')) return false
    if (lower.startsWith('http://') || lower.startsWith('https://')) return false
    if (lower.startsWith('data:') || lower.startsWith('blob:')) return false
    if (FILE_EXTENSION_REGEX.test(lower)) return false
    if (HASH_FILENAME_REGEX.test(lower) && lower.length > 8) return false
    return true
}

// ─── Decorative frames ───────────────────────────────────────────────────────

function applyGalleryFrame(
    wrapper: HTMLElement,
    image: HTMLElement,
    scale: number,
    altText: string,
    isCropped: boolean,
): void {
    const frame = div({
        display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
        backgroundColor: '#181818', border: '12px solid #111111', borderRadius: '2px',
        maxWidth: `${scale}%`, boxSizing: 'border-box',
        boxShadow: '0 25px 50px rgba(0, 0, 0, 0.65)',
    })
    const innerFrame = div({
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        backgroundColor: '#1f1f1f', borderStyle: 'solid', borderWidth: '5px',
        borderTopColor: '#2b2b2b', borderLeftColor: '#252525',
        borderRightColor: '#0a0a0a', borderBottomColor: '#080808',
        padding: '4px', boxSizing: 'border-box', width: '100%',
    })
    const hasCaption = isCustomCaption(altText)
    const mat = div({
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        backgroundColor: '#f5f3eb', padding: hasCaption ? '24px 24px 0' : '24px',
        border: '1px solid #d8d4c7', boxShadow: 'inset 0 3px 8px rgba(0,0,0,0.06)',
        width: '100%', boxSizing: 'border-box',
    })
    const matWindow = div({
        display: 'block', backgroundColor: '#e6e3d8', padding: '3px',
        border: '1px solid #c2bdb0', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.1)',
        width: '100%', boxSizing: 'border-box',
    })

    styleImg(image, { borderRadius: '0', display: 'block', width: '100%', maxWidth: '100%' }, !isCropped, {
        border: '1px solid #a8a499', boxShadow: '0 2px 4px rgba(0,0,0,0.15)', boxSizing: 'border-box',
    })

    wrapper.appendChild(frame)
    frame.appendChild(innerFrame)
    innerFrame.appendChild(mat)
    mat.appendChild(matWindow)
    matWindow.appendChild(image)

    if (hasCaption) {
        const labelContainer = div({
            display: 'flex', justifyContent: 'center', padding: '16px 0',
            width: '0', minWidth: '100%', boxSizing: 'border-box',
        })
        const label = div({
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: '#ffffff', border: '1px solid #d9d9d9', borderRadius: '2px',
            padding: '5px 12px', boxShadow: '0 2px 5px rgba(0,0,0,0.05)', maxWidth: '90%',
            boxSizing: 'border-box',
        })
        const caption = document.createElement('span')
        Object.assign(caption.style, {
            fontSize: '11px', color: '#333333',
            fontFamily: '"Times New Roman", Times, "Georgia", serif',
            fontStyle: 'italic', letterSpacing: '0.04em', textAlign: 'center',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', flex: '1',
        })
        caption.textContent = altText!
        label.appendChild(caption)
        labelContainer.appendChild(label)
        mat.appendChild(labelContainer)
    }
}

function applyModernFrame(
    wrapper: HTMLElement,
    image: HTMLElement,
    scale: number,
    altText: string,
    isCropped: boolean,
): void {
    const hasCaption = isCustomCaption(altText)
    const frame = div({
        display: 'inline-flex', flexDirection: 'column', alignItems: 'center',
        backgroundColor: '#ffffff', padding: hasCaption ? '24px 24px 16px' : '24px',
        border: '1px solid #e2e2e2', maxWidth: `${scale}%`, boxSizing: 'border-box',
        boxShadow: '0 12px 32px rgba(0,0,0,0.1), 0 2px 6px rgba(0,0,0,0.05), inset 0 0 0 1px #fcfcfc',
    })
    styleImg(image, {
        borderRadius: '1px', display: 'block', width: '100%', maxWidth: '100%',
        boxShadow: '0 6px 18px rgba(0,0,0,0.12), 0 1px 4px rgba(0,0,0,0.08)',
        border: '1px solid rgba(0,0,0,0.04)', boxSizing: 'border-box',
    }, !isCropped)

    wrapper.appendChild(frame)
    frame.appendChild(image)

    if (hasCaption) {
        const labelBlock = div({
            marginTop: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center',
            gap: '2px', width: '0', minWidth: '100%', boxSizing: 'border-box',
        })
        const dividerEl = div({ width: '24px', height: '1px', backgroundColor: '#e6e6e6', marginBottom: '6px' })
        const title = document.createElement('span')
        Object.assign(title.style, {
            fontSize: '10px', color: '#222222', fontFamily: 'system-ui, -apple-system, sans-serif',
            fontWeight: '600', letterSpacing: '0.12em', textAlign: 'center',
            overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
            width: '90%', boxSizing: 'border-box',
        })
        title.textContent = altText!.toUpperCase()
        const subtitle = document.createElement('span')
        Object.assign(subtitle.style, {
            fontSize: '7.5px', color: '#999999', fontFamily: 'system-ui, -apple-system, sans-serif',
            letterSpacing: '0.08em', fontWeight: '500',
        })
        subtitle.textContent = 'EXHIBIT COLLECTION'
        labelBlock.append(dividerEl, title, subtitle)
        frame.appendChild(labelBlock)
    }
}

function applyTapeFrame(
    wrapper: HTMLElement,
    image: HTMLElement,
    scale: number,
    isCropped: boolean,
): void {
    const inner = div({
        display: 'inline-block', position: 'relative', backgroundColor: '#fffef0',
        padding: '14px 14px 10px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06)',
        transform: `rotate(${(Math.random() * 6 - 3).toFixed(1)}deg)`,
        maxWidth: `${scale}%`, boxSizing: 'border-box',
    })
    const tape = div({
        position: 'absolute', top: '-10px', left: '50%',
        transform: 'translateX(-50%) rotate(-2deg)', width: '72px', height: '24px',
        backgroundColor: 'rgba(180, 130, 200, 0.45)',
        borderLeft: '1px dashed rgba(255,255,255,0.4)',
        borderRight: '1px dashed rgba(255,255,255,0.4)',
    })
    inner.appendChild(tape)
    styleImg(image, {
        borderRadius: '1px', width: '100%', maxWidth: '100%',
        display: 'block', boxSizing: 'border-box',
    }, !isCropped)
    wrapper.appendChild(inner)
    inner.appendChild(image)
}

function div(style: Partial<CSSStyleDeclaration>): HTMLDivElement {
    const el = document.createElement('div')
    Object.assign(el.style, style)
    return el
}

function styleImg(img: HTMLElement, base: Partial<CSSStyleDeclaration>, autoHeight: boolean, extra?: Partial<CSSStyleDeclaration>): void {
    Object.assign(img.style, base)
    if (autoHeight) img.style.height = 'auto'
    if (extra) Object.assign(img.style, extra)
}

// ─── Image/video processing ──────────────────────────────────────────────────

function processImages(root: HTMLElement, options: MessageDisplayOptions): void {
    const alignValue = options.imageAlign || 'left'
    const styleMode: ImageStyle = options.imageStyle || 'none'
    const scale = options.imageScale && options.imageScale !== 100 ? options.imageScale : 100
    const isCropped = Boolean(options.imageCropActive)

    const images = Array.from(root.querySelectorAll('img'))
    for (const el of images) {
        const img = el as HTMLImageElement
        const parent = img.parentNode
        if (!parent) continue

        const wrapper = document.createElement('div')
        wrapper.className = 'log-exporter-image-wrapper'
        Object.assign(wrapper.style, { textAlign: alignValue, margin: '0.5em 0' })
        parent.insertBefore(wrapper, img)

        let imageToAppend: HTMLElement = img

        if (isCropped) {
            const cropWrapper = document.createElement('div')
            const aspect = getAspectRatioCssValue(options.imageCropAspectRatio, options.imageCropHeight)
            Object.assign(cropWrapper.style, {
                display: 'block', width: '100%', overflow: 'hidden',
                position: 'relative', boxSizing: 'border-box',
            })
            if (aspect) cropWrapper.style.aspectRatio = aspect
            const hPos = options.imageCropHAlign !== undefined ? options.imageCropHAlign : 50
            const vPos = options.imageCropVAlign !== undefined ? options.imageCropVAlign : 50
            img.style.setProperty('width', '100%', 'important')
            img.style.setProperty('height', '100%', 'important')
            img.style.setProperty('object-fit', 'cover', 'important')
            img.style.setProperty('object-position', `${hPos}% ${vPos}%`, 'important')
            img.style.setProperty('display', 'block', 'important')
            img.style.setProperty('max-width', '100%', 'important')
            cropWrapper.appendChild(img)
            imageToAppend = cropWrapper
        } else {
            img.style.maxWidth = `${scale}%`
            img.style.width = `${scale}%`
            img.style.height = 'auto'
            img.style.display = 'inline-block'
            img.style.verticalAlign = 'middle'
        }

        switch (styleMode) {
            case 'gallery':
                applyGalleryFrame(wrapper, imageToAppend, scale, img.alt, isCropped)
                continue
            case 'modern':
                applyModernFrame(wrapper, imageToAppend, scale, img.alt, isCropped)
                continue
            case 'tape':
                applyTapeFrame(wrapper, imageToAppend, scale, isCropped)
                continue
            default:
                break
        }

        if (isCropped) {
            imageToAppend.style.maxWidth = `${scale}%`
            imageToAppend.style.width = `${scale}%`
            imageToAppend.style.display = 'inline-block'
            imageToAppend.style.verticalAlign = 'middle'
        }
        wrapper.appendChild(imageToAppend)
    }
}

function processVideos(root: HTMLElement, imageScale?: number): void {
    if (!imageScale || imageScale === 100) return
    root.querySelectorAll('video').forEach((el) => {
        el.style.maxWidth = `${imageScale}%`
        el.style.width = `${imageScale}%`
        el.style.height = 'auto'
    })
}

function styleCustomBlock(el: Element, bg?: string, textColor?: string, border: string | null = null): void {
    const newBlock = document.createElement('div')
    newBlock.innerHTML = `<div style="padding:0; margin:0;">${el.innerHTML}</div>`
    Object.assign(newBlock.style, {
        padding: '0.75em 1em', margin: '0.75em 0', borderRadius: '4px',
        borderLeft: `3px solid ${border || 'transparent'}`,
        backgroundColor: bg || '', color: textColor || '',
    })
    el.replaceWith(newBlock)
}

function processFormattedBlocks(root: HTMLElement, color: ColorPalette): void {
    root.querySelectorAll('.x-risu-regex-quote-block').forEach((el) =>
        styleCustomBlock(el, color.quoteBg, color.quoteText, color.quoteText || null))
    root.querySelectorAll('.x-risu-regex-thought-block').forEach((el) =>
        styleCustomBlock(el, color.thoughtBg, color.thoughtText))
    root.querySelectorAll('mark[risu-mark^="quote"]').forEach((markEl) => {
        const mark = markEl as HTMLElement
        Object.assign(mark.style, {
            backgroundColor: color.quoteBg || '',
            color: color.quoteText || '',
            padding: '0.1em 0.3em',
            borderRadius: '3px',
            textDecoration: 'none',
        })
    })
}

async function embedImagesInElement(element: HTMLElement, embed: boolean): Promise<void> {
    const mediaElements = Array.from(
        element.querySelectorAll<HTMLElement>('img, [style*="background-image"]'))
    await Promise.all(mediaElements.map(async (el) => {
        if (el.tagName === 'IMG') {
            const img = el as HTMLImageElement
            if (!img.getAttribute('src')) {
                img.remove()
                return
            }
            if (embed && !img.src.startsWith('data:')) {
                img.src = await imageUrlToDataUrl(img.src)
            }
        } else {
            const style = el.getAttribute('style')
            const bgUrl = extractBackgroundImageUrl(style ?? '')
            if (bgUrl && embed && !bgUrl.startsWith('data:')) {
                const converted = await imageUrlToDataUrl(bgUrl)
                el.setAttribute('style', (style ?? '').replace(bgUrl, converted))
            }
        }
    }))
}

export function extractBackgroundImageUrl(styleAttr: string): string | null {
    if (!styleAttr) return null
    const match = styleAttr.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)
    return match ? match[1] : null
}

// ─── Raw HTML mode ───────────────────────────────────────────────────────────

async function processRawHtmlContent(
    html: string,
    embed: boolean,
    rules?: ReplacementRule[],
): Promise<string> {
    const container = document.createElement('div')
    container.innerHTML = html
    container.querySelectorAll('button').forEach((b) => b.remove())
    await embedImagesInElement(container, embed)
    applyReplacements(container, rules)
    return container.innerHTML.trim()
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

export interface ProcessMessageOptions extends MessageDisplayOptions {
    html: string
    embedImages: boolean
    color: ColorPalette
    replacementRules?: ReplacementRule[]
    allowHtmlRendering?: boolean
}

/**
 * Full message processing pipeline. Returns processed HTML ready to inject
 * into themed bubbles or export documents.
 */
export async function processMessageHtml(options: ProcessMessageOptions): Promise<string> {
    const {
        html,
        embedImages,
        color,
        replacementRules,
        allowHtmlRendering,
    } = options

    if (!html) return ''

    if (allowHtmlRendering) {
        return await processRawHtmlContent(html, embedImages, replacementRules)
    }

    const container = document.createElement('div')
    container.innerHTML = html
    container.querySelectorAll('script, button').forEach((el) => el.remove())

    await embedImagesInElement(container, embedImages)
    // background-images become <img> so frames/cropping also apply to them
    const bgElements = Array.from(container.querySelectorAll<HTMLElement>('[style*="background-image"]'))
    for (const el of bgElements) {
        const styleAttr = el.getAttribute('style') ?? ''
        const bgUrl = extractBackgroundImageUrl(styleAttr)
        if (bgUrl) {
            const img = document.createElement('img')
            img.src = embedImages ? await imageUrlToDataUrl(bgUrl) : bgUrl
            el.parentNode?.insertBefore(img, el)
            el.remove()
        }
    }

    processImages(container, options)
    processVideos(container, options.imageScale)
    processFormattedBlocks(container, color)
    applyReplacements(container, replacementRules)

    return container.innerHTML.trim()
}

// ─── Batch cache ─────────────────────────────────────────────────────────────

const batchCache = new Map<string, string>()

export function getCachedProcessedHtml(key: string): string | undefined {
    return batchCache.get(key)
}

export function setCachedProcessedHtml(key: string, html: string): void {
    batchCache.set(key, html)
}

export function clearBatchCache(): void {
    batchCache.clear()
}
