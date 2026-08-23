import type {
    ColorPalette,
    ColorKey,
    ThemeInfo,
    ThemeKey,
    OptionDescriptor,
    ExportFormat,
    HeaderLayout,
    ImageAlign,
    ImageCropAspectRatio,
    AvatarPosition,
    AvatarShape,
    ImageFormat,
    ImageStyle,
    SplitImageMode,
    HtmlScaleMode,
} from './types'

// ─── Theme Preset Definitions ────────────────────────────────────────────────

export const THEMES: Record<ThemeKey, ThemeInfo> = {
    basic: {
        name: '기본',
        description: '가장 일반적인 말풍선 디자인입니다. 색상 팔레트를 자유롭게 변경할 수 있습니다.',
    },
    custom: {
        name: '커스텀 (CSS)',
        description: '사용자가 직접 CSS를 작성하여 테마를 꾸밀 수 있습니다.',
    },
    modern: {
        name: '현대',
        description: '카드형 UI와 깔끔한 선으로 구성된 모던한 다크 디자인입니다.',
        color: {
            background: '#16181d',
            cardBg: '#1c1f26',
            cardBgUser: '#262a33',
            text: '#d4d8e0',
            textSecondary: '#8b8f9a',
            nameColor: '#7c9cf0',
            border: '#2a2e38',
            shadow: '0 2px 8px rgba(0,0,0,0.25)',
            avatarBorder: '#7c9cf0',
            quoteBg: 'rgba(124, 156, 240, 0.08)',
            quoteText: '#9bb0f5',
            thoughtBg: 'rgba(180, 160, 230, 0.08)',
            thoughtText: '#c4b0e0',
        },
    },
    smart: {
        name: '스마트',
        description: '세련된 글래스모피즘 효과와 부드러운 곡선을 가진 현대적인 디자인입니다.',
        color: {
            background: '#1a1d24',
            cardBg: 'rgba(36, 40, 48, 0.65)',
            cardBgUser: 'rgba(52, 58, 70, 0.65)',
            text: '#e8ecf2',
            textSecondary: '#a0a8b4',
            nameColor: '#6cb6ff',
            border: 'rgba(180, 190, 205, 0.12)',
            shadow: '0 4px 24px rgba(0, 0, 0, 0.2)',
            avatarBorder: 'transparent',
            quoteBg: 'rgba(108, 182, 255, 0.10)',
            quoteText: '#9bd0ff',
            thoughtBg: 'rgba(180, 140, 220, 0.10)',
            thoughtText: '#d0b0ee',
            soundBg: 'rgba(240, 150, 130, 0.10)',
            soundText: '#f0a082',
            separator: '#2a3040',
        },
    },
    simple: {
        name: '심플',
        description: '이미지와 장식을 최소화하여 텍스트에 집중할 수 있는 간결한 디자인입니다.',
        color: {
            background: '#fafafa',
            cardBg: 'transparent',
            cardBgUser: 'transparent',
            text: '#2d2d2d',
            textSecondary: '#888888',
            nameColor: '#1a1a1a',
            border: '#e0e0e0',
            shadow: 'none',
            avatarBorder: 'none',
            quoteBg: '#f0f0f0',
            quoteText: '#555555',
            thoughtBg: '#f5f5f5',
            thoughtText: '#777777',
        },
    },
    log: {
        name: '로그',
        description: '채팅 로그처럼 보이는 간단한 테마입니다.',
    },
    raw: {
        name: 'Raw',
        description: '원본 HTML 형식으로 렌더링합니다.',
    },
}

// ─── Color Palette Presets ───────────────────────────────────────────────────

export const COLORS: Record<ColorKey, ColorPalette> = {
    dark: {
        name: '다크 (모던)',
        background: '#0d0f14',
        cardBg: '#181b22',
        cardBgUser: '#22262f',
        text: '#e4e6eb',
        textSecondary: '#9499a5',
        nameColor: '#5eabef',
        border: '#252a35',
        quoteBg: 'rgba(94, 171, 239, 0.10)',
        quoteText: '#89c4f4',
        thoughtBg: 'rgba(180, 140, 220, 0.10)',
        thoughtText: '#c98edd',
        soundBg: 'rgba(152, 195, 121, 0.10)',
        soundText: '#98c379',
        shadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
        avatarBorder: '#5eabef',
    },
    classic: {
        name: '클래식',
        background: '#16161e',
        cardBg: '#1f2233',
        cardBgUser: '#2d3148',
        text: '#c0caf5',
        textSecondary: '#7e88b0',
        nameColor: '#7aa2f7',
        border: '#363b54',
        quoteBg: 'rgba(122, 162, 247, 0.10)',
        quoteText: '#a9c7ff',
        thoughtBg: 'rgba(187, 154, 247, 0.10)',
        thoughtText: '#c4b5fd',
        soundBg: 'rgba(158, 206, 106, 0.10)',
        soundText: '#b8e090',
        shadow: '0 2px 6px rgba(0, 0, 0, 0.3)',
        avatarBorder: '#7aa2f7',
    },
    light: {
        name: '라이트',
        background: '#f5f6f8',
        cardBg: '#ffffff',
        cardBgUser: '#eaf2ff',
        text: '#1a1d24',
        textSecondary: '#6b7280',
        nameColor: '#2563eb',
        border: '#e2e5ea',
        quoteBg: 'rgba(37, 99, 235, 0.06)',
        quoteText: '#3b6fd4',
        thoughtBg: 'rgba(100, 116, 139, 0.06)',
        thoughtText: '#475569',
        soundBg: 'rgba(22, 163, 74, 0.06)',
        soundText: '#15803d',
        shadow: '0 1px 3px rgba(0, 0, 0, 0.06)',
        avatarBorder: '#2563eb',
    },
    sepia: {
        name: '세피아',
        background: '#f3ead8',
        cardBg: '#faf3e3',
        cardBgUser: '#f0e0c4',
        text: '#3d3128',
        textSecondary: '#7a6a58',
        nameColor: '#9b5c1f',
        border: '#ddd0b8',
        quoteBg: 'rgba(155, 92, 31, 0.08)',
        quoteText: '#8a4f1a',
        thoughtBg: 'rgba(120, 80, 50, 0.06)',
        thoughtText: '#6b4226',
        soundBg: 'rgba(107, 142, 35, 0.08)',
        soundText: '#556b2f',
        shadow: '0 1px 3px rgba(139, 69, 19, 0.12)',
        avatarBorder: '#a06a2c',
    },
    ocean: {
        name: '오션',
        background: '#0a1628',
        cardBg: '#11203d',
        cardBgUser: '#182d50',
        text: '#d0dcef',
        textSecondary: '#7891b0',
        nameColor: '#5eead4',
        border: '#1e3050',
        quoteBg: 'rgba(94, 234, 212, 0.08)',
        quoteText: '#5eead4',
        thoughtBg: 'rgba(99, 179, 237, 0.08)',
        thoughtText: '#7cc7f0',
        soundBg: 'rgba(248, 113, 113, 0.08)',
        soundText: '#f87171',
        shadow: '0 2px 8px rgba(0, 0, 0, 0.4)',
        avatarBorder: '#5eead4',
    },
    forest: {
        name: '포레스트',
        background: '#121d16',
        cardBg: '#1b2c22',
        cardBgUser: '#243a2c',
        text: '#e0ede4',
        textSecondary: '#90a89a',
        nameColor: '#6ee7a7',
        border: '#2a3f30',
        quoteBg: 'rgba(110, 231, 167, 0.08)',
        quoteText: '#86efac',
        thoughtBg: 'rgba(134, 239, 172, 0.08)',
        thoughtText: '#6ee7a7',
        soundBg: 'rgba(250, 204, 21, 0.08)',
        soundText: '#facc15',
        shadow: '0 2px 6px rgba(0, 0, 0, 0.3)',
        avatarBorder: '#6ee7a7',
    },
    sunset: {
        name: '선셋',
        background: '#1e1539',
        cardBg: '#2d1f54',
        cardBgUser: '#3d2a70',
        text: '#f0e0f5',
        textSecondary: '#b89dd0',
        nameColor: '#f0a8d0',
        border: '#3d2a70',
        quoteBg: 'rgba(240, 168, 208, 0.10)',
        quoteText: '#f0a8d0',
        thoughtBg: 'rgba(250, 204, 196, 0.08)',
        thoughtText: '#fbc8c0',
        soundBg: 'rgba(254, 215, 170, 0.08)',
        soundText: '#fed7aa',
        shadow: '0 2px 8px rgba(30, 21, 57, 0.5)',
        avatarBorder: '#f0a8d0',
    },
    cyberpunk: {
        name: '사이버펑크',
        background: '#080812',
        cardBg: '#11111f',
        cardBgUser: '#1a1a30',
        text: '#e0e0ff',
        textSecondary: '#9090b0',
        nameColor: '#00f0ff',
        border: '#2a2a48',
        quoteBg: 'rgba(255, 0, 255, 0.10)',
        quoteText: '#ff5fff',
        thoughtBg: 'rgba(0, 240, 255, 0.10)',
        thoughtText: '#00f0ff',
        soundBg: 'rgba(255, 255, 0, 0.10)',
        soundText: '#ffff66',
        shadow: '0 0 12px rgba(0, 240, 255, 0.15)',
        avatarBorder: '#00f0ff',
    },
    monochrome: {
        name: '모노크롬',
        background: '#18181b',
        cardBg: '#27272a',
        cardBgUser: '#3f3f46',
        text: '#e4e4e7',
        textSecondary: '#a1a1aa',
        nameColor: '#ffffff',
        border: '#3f3f46',
        quoteBg: 'rgba(255, 255, 255, 0.06)',
        quoteText: '#d4d4d8',
        thoughtBg: 'rgba(228, 228, 231, 0.06)',
        thoughtText: '#c4c4c8',
        soundBg: 'rgba(161, 161, 170, 0.06)',
        soundText: '#a1a1aa',
        shadow: '0 1px 4px rgba(0, 0, 0, 0.4)',
        avatarBorder: '#d4d4d8',
    },
    highcontrast: {
        name: '하이 콘트라스트',
        background: '#000000',
        cardBg: '#0a0a0a',
        cardBgUser: '#161616',
        text: '#ffffff',
        textSecondary: '#c0c0c0',
        nameColor: '#ffffff',
        border: '#2a2a2a',
        quoteBg: 'rgba(255, 255, 255, 0.06)',
        quoteText: '#ffffff',
        thoughtBg: 'rgba(255, 255, 255, 0.06)',
        thoughtText: '#ffffff',
        soundBg: 'rgba(255, 255, 255, 0.06)',
        soundText: '#ffffff',
        shadow: '0 1px 6px rgba(0, 0, 0, 0.9)',
        avatarBorder: '#ffffff',
    },
    darkcontrast: {
        name: '다크 하이 콘트라스트',
        background: '#080b14',
        cardBg: '#141b2a',
        cardBgUser: '#1e2940',
        text: '#ffffff',
        textSecondary: '#a0b8e0',
        nameColor: '#6cb0ff',
        border: '#2a3a5c',
        quoteBg: 'rgba(108, 176, 255, 0.10)',
        quoteText: '#ffffff',
        thoughtBg: 'rgba(120, 160, 255, 0.12)',
        thoughtText: '#ffffff',
        soundBg: 'rgba(255, 200, 120, 0.12)',
        soundText: '#ffd9a0',
        shadow: '0 1px 6px rgba(0, 0, 0, 0.7)',
        avatarBorder: '#6cb0ff',
    },
}

// ─── Default Keys ────────────────────────────────────────────────────────────

export const DEFAULT_THEME_KEY: ThemeKey = 'basic'
export const DEFAULT_COLOR_KEY: ColorKey = 'dark'
export const DEFAULT_HEADER_LAYOUT: HeaderLayout = 'default'

// ─── UI Option Descriptors ───────────────────────────────────────────────────

export const HEADER_LAYOUT_OPTIONS: readonly OptionDescriptor<HeaderLayout>[] = [
    { value: 'default', label: '기본', description: '표준 상단 프로필 및 태그 레이아웃입니다.' },
    { value: 'compact', label: '컴팩트', description: '간결하게 한 줄로 요약된 컴팩트 레이아웃입니다.' },
    { value: 'banner', label: '배너', description: '상단 와이드 배너 이미지가 포함된 레이아웃입니다.' },
    { value: 'smart', label: '스마트', description: '세련된 글래스모피즘 스타일의 스마트 레이아웃입니다.' },
    { value: 'cover', label: '커버', description: '캐릭터 카드를 전면에 배치하는 커버 레이아웃입니다.' },
] as const

export const EXPORT_FORMAT_OPTIONS: readonly OptionDescriptor<ExportFormat>[] = [
    { value: 'basic', label: '기본', description: '대화 말풍선 형태의 기본 프리뷰 및 이미지 내보내기' },
    { value: 'html', label: 'HTML', description: '스타일과 인터랙션이 포함된 단일 독립형 HTML 파일' },
    { value: 'markdown', label: '마크다운', description: '대화 서식이 적용된 마크다운 텍스트 문서' },
    { value: 'text', label: '텍스트', description: '텍스트 전용 일반 로그 파일' },
] as const

export const IMAGE_ALIGN_OPTIONS: readonly OptionDescriptor<ImageAlign>[] = [
    { value: 'left', label: '왼쪽' },
    { value: 'center', label: '중앙' },
    { value: 'right', label: '오른쪽' },
] as const

export const IMAGE_STYLE_OPTIONS: readonly OptionDescriptor<ImageStyle>[] = [
    { value: 'none', label: '없음' },
    { value: 'gallery', label: '갤러리 (클래식 액자)' },
    { value: 'modern', label: '모던 (현대 액자)' },
    { value: 'tape', label: '테이프 (메모)' },
] as const

export const CROP_ASPECT_RATIO_OPTIONS: readonly OptionDescriptor<ImageCropAspectRatio>[] = [
    { value: 'original', label: '원본 비율 (높이 제한 없음)' },
    { value: '1:1', label: '1:1 (정사각형)' },
    { value: '3:4', label: '3:4 (세로형 인물/피규어)' },
    { value: '4:3', label: '4:3 (가로형 표준)' },
    { value: '9:16', label: '9:16 (스마트폰 세로)' },
    { value: '16:9', label: '16:9 (시네마틱 가로)' },
    { value: 'custom', label: '사용자 지정 비율' },
] as const

export const AVATAR_POSITION_OPTIONS: readonly OptionDescriptor<AvatarPosition>[] = [
    { value: 'opposite', label: '말풍선 옆 - 기본' },
    { value: 'left', label: '말풍선 옆 - 항상 좌측' },
    { value: 'right', label: '말풍선 옆 - 항상 우측' },
    { value: 'opposite-top', label: '이름 옆 - 기본' },
    { value: 'top-left', label: '이름 옆 - 항상 좌측' },
    { value: 'top-right', label: '이름 옆 - 항상 우측' },
] as const

export const AVATAR_SHAPE_OPTIONS: readonly OptionDescriptor<AvatarShape>[] = [
    { value: 'theme', label: '테마 기본값' },
    { value: 'circle', label: '동그라미 (Circle)' },
    { value: 'square', label: '네모 (Square)' },
    { value: 'rounded', label: '둥근 네모 (Rounded)' },
    { value: 'squircle', label: '스쿼클 (Squircle)' },
] as const

export const SCALE_MODE_OPTIONS: readonly OptionDescriptor<HtmlScaleMode>[] = [
    { value: 'font', label: '글자만 스케일' },
    { value: 'full', label: 'HTML 전체 스케일 (레이아웃 포함)' },
] as const

export const IMAGE_RESOLUTION_OPTIONS: readonly OptionDescriptor<string>[] = [
    { value: 'auto', label: '자동 (Auto)' },
    { value: '1', label: '1x' },
    { value: '2', label: '2x' },
    { value: '3', label: '3x' },
    { value: '4', label: '4x' },
    { value: '8', label: '8x' },
    { value: '16', label: '16x' },
    { value: '32', label: '32x' },
] as const

export const IMAGE_FORMAT_OPTIONS: readonly OptionDescriptor<ImageFormat>[] = [
    { value: 'png', label: 'PNG' },
    { value: 'jpeg', label: 'JPEG' },
    { value: 'webp', label: 'WebP' },
] as const

export const SPLIT_IMAGE_OPTIONS: readonly OptionDescriptor<SplitImageMode>[] = [
    { value: 'none', label: '분할 안함' },
    { value: 'chunk', label: '청크 단위 (1개 파일로 병합)' },
    { value: 'message', label: '메시지 단위 (여러 파일)' },
] as const

// ─── Palette Resolution ──────────────────────────────────────────────────────

/** Resolves the effective palette for the current theme/color selection. */
export function resolveEffectiveColor(
    themeKey: ThemeKey = 'basic',
    colorKey: ColorKey = 'dark',
    overrideColor?: ColorPalette,
): ColorPalette {
    if (overrideColor) return overrideColor
    const themeInfo = THEMES[themeKey] || THEMES.basic
    if (themeKey === 'basic' || themeKey === 'custom') {
        return COLORS[colorKey] || COLORS.dark
    }
    return themeInfo.color || COLORS.dark
}
