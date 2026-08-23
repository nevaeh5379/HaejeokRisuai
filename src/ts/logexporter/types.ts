/**
 * Log Exporter — shared types.
 *
 * Native port of the risu-log-plugin type system, redesigned for direct
 * access to RisuAI stores. ArcaLive export types are intentionally omitted.
 */

// ============================================================================
// 1. Theme & Color Palette Definitions
// ============================================================================

export type ThemeKey = 'basic' | 'custom' | 'modern' | 'smart' | 'simple' | 'log' | 'raw'

export type ColorKey =
    | 'dark'
    | 'classic'
    | 'light'
    | 'sepia'
    | 'ocean'
    | 'forest'
    | 'sunset'
    | 'cyberpunk'
    | 'monochrome'
    | 'highcontrast'
    | 'darkcontrast'

export interface ColorPalette {
    name?: string
    background: string
    text: string
    nameColor: string
    border: string
    avatarBorder: string
    shadow: string
    cardBg: string
    cardBgUser: string
    quoteBg?: string
    quoteText?: string
    thoughtBg?: string
    thoughtText?: string
    soundBg?: string
    soundText?: string
    separator?: string
    textSecondary?: string
}

export interface ThemeInfo {
    name: string
    description: string
    color?: ColorPalette
}

// ============================================================================
// 2. Image, Layout & Visual Styling Literal Types
// ============================================================================

export type ImageStyle = 'none' | 'gallery' | 'modern' | 'tape'
export type ImageAlign = 'left' | 'center' | 'right'
export type ImageCropAspectRatio =
    | 'original'
    | '1:1'
    | '3:4'
    | '4:3'
    | '9:16'
    | '16:9'
    | 'custom'
    | (string & {})
export type HeaderLayout = 'default' | 'compact' | 'banner' | 'smart' | 'cover'
export type AvatarPosition = 'left' | 'right' | 'opposite' | 'top-left' | 'top-right' | 'opposite-top'
export type AvatarShape = 'theme' | 'circle' | 'square' | 'rounded' | 'squircle'
export type ExportFormat = 'basic' | 'html' | 'markdown' | 'text'
export type HtmlScaleMode = 'font' | 'full'
export type ImageResolution = number | 'auto'
export type ImageLibrary = 'html-to-image'
export type ImageFormat = 'png' | 'jpeg' | 'webp'
export type SplitImageMode = 'none' | 'chunk' | 'message'
export type CustomFiltersMap = Record<string, boolean>

export interface OptionDescriptor<T extends string | number = string> {
    value: T
    label: string
    description?: string
}

// ============================================================================
// 3. Replacement Rules & Progress Callbacks
// ============================================================================

export interface ReplacementRule {
    id: string
    pattern: string
    replacement: string
    flags?: string
    isRegex?: boolean
    isEnabled?: boolean
}

export interface ProgressUpdatePayload {
    current?: number
    message?: string
}

export interface LogExportProgressCallbacks {
    onProgressStart?: (message: string, total: number) => void
    onProgressUpdate?: (update: ProgressUpdatePayload) => void
    onProgressEnd?: () => void
}

// ============================================================================
// 4. Chat Data Model (native)
// ============================================================================

/** A single rendered log entry ready for theming. */
export interface LogMessageData {
    /** Stable key for virtualization */
    key: string
    role: 'user' | 'char'
    /** Resolved display name of the speaker */
    name: string
    /** Parsed HTML content produced by RisuAI's ParseMarkdown pipeline */
    html: string
    /** Plain text version (tags stripped), used by markdown/text export */
    text: string
    time?: number
    isUser: boolean
    /** Avatar image URL (already resolved to a loadable source) */
    avatarUrl: string
}

export interface CharInfo {
    name: string
    chatName: string
    avatarUrl: string
}

export interface LogExportData {
    charInfo: CharInfo
    messages: LogMessageData[]
    participants: Set<string>
    /** chaId of the source character (settings persistence key) */
    characterId?: string
}

/** Message range selection options (per-message quick actions). */
export interface MessageRangeOptions {
    startIndex?: number
    endIndex?: number
    singleMessage?: number
}

// ============================================================================
// 5. Settings Schema
// ============================================================================

export interface LogExporterSettings extends LogExportProgressCallbacks, MessageDisplayOptions {
    // --- Format & Theming ---
    format: ExportFormat
    theme: ThemeKey
    color: ColorKey
    customCss: string

    // --- Header Options ---
    showHeader: boolean
    showHeaderIcon: boolean
    headerTags: string
    headerLayout: HeaderLayout
    headerBannerUrl: string
    headerBannerBlur: boolean
    headerBannerAlign: number

    // --- Footer Options ---
    showFooter: boolean
    footerLeft: string
    footerCenter: string
    footerRight: string

    // --- Avatar & Bubble Options ---
    showAvatar: boolean
    avatarPosition: AvatarPosition
    avatarShape: AvatarShape
    showBubble: boolean
    expandHover: boolean

    // --- Content & Transformations ---
    embedImages: boolean
    replacementRules: ReplacementRule[]
    disableAnimations: boolean
    rawHtmlView: boolean
    isEditable: boolean
    allowHtmlRendering: boolean
    customFilters: CustomFiltersMap

    // --- HTML Preview & Scaling ---
    htmlScaleMode: HtmlScaleMode
    htmlScaleFactor: number
    previewFontSize: number
    previewWidth: number

    // --- Image Capture & Splitting ---
    imageResolution: ImageResolution
    imageLibrary: ImageLibrary
    imageFormat: ImageFormat
    splitImage: SplitImageMode
    maxImageHeight: number

    // --- Media Conversion ---
    convertWebM: boolean
}

export const DEFAULT_SETTINGS: LogExporterSettings = {
    format: 'basic',
    theme: 'basic',
    color: 'dark',
    customCss: '',
    showHeader: true,
    showHeaderIcon: true,
    headerTags: '',
    headerLayout: 'default',
    headerBannerUrl: '',
    headerBannerBlur: true,
    headerBannerAlign: 50,
    showFooter: true,
    footerLeft: '',
    footerCenter: '',
    footerRight: '',
    showAvatar: true,
    avatarPosition: 'opposite',
    avatarShape: 'theme',
    showBubble: true,
    expandHover: false,
    embedImages: true,
    replacementRules: [],
    disableAnimations: true,
    rawHtmlView: false,
    isEditable: false,
    allowHtmlRendering: false,
    customFilters: {},
    htmlScaleMode: 'font',
    htmlScaleFactor: 1,
    previewFontSize: 16,
    previewWidth: 800,
    imageResolution: 1,
    imageLibrary: 'html-to-image',
    imageFormat: 'png',
    splitImage: 'none',
    maxImageHeight: 10000,
    convertWebM: true,
    imageScale: 100,
    imageAlign: 'left',
    imageStyle: 'none',
    imageCropActive: false,
    imageCropAspectRatio: 'original',
    imageCropVAlign: 50,
    imageCropHAlign: 50,
    imageCropHeight: 1,
}

// ============================================================================
// 6. Component prop contracts (shared between preview and export rendering)
// ============================================================================

export interface MessageDisplayOptions {
    imageScale?: number
    imageAlign?: ImageAlign
    imageStyle?: ImageStyle
    imageCropActive?: boolean
    imageCropAspectRatio?: ImageCropAspectRatio
    imageCropVAlign?: number
    imageCropHAlign?: number
    imageCropHeight?: number
}

export interface LogRenderProps extends MessageDisplayOptions {
    data: LogExportData
    selectedThemeKey?: ThemeKey
    selectedColorKey?: ColorKey
    color?: ColorPalette
    customCss?: string
    settings: LogExporterSettings
    fontSize?: number
    containerWidth?: number
    selectedIndices?: Set<number>
    onMessageSelect?: (index: number, e: MouseEvent) => void
    onMessageDelete?: (index: number) => void
    onMessageEditInput?: (index: number, html: string) => void
    isForImageExport?: boolean
    isForExport?: boolean
    /** Pre-processed HTML per message index (bypasses live processing cache) */
    processedHtmlMap?: Map<string, string>
    /** Callback fired when every message finished rendering in export mode */
    onReady?: () => void
}
