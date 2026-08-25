import QtQuick

pragma Singleton

QtObject {
    id: root

    // Palette & Colors based on current theme setting
    property string currentTheme: typeof appConfig !== "undefined" && appConfig ? appConfig.theme : "dracula"

    // Primary Colors from RisuAI colorscheme.ts
    readonly property color bgcolor: {
        switch (currentTheme) {
            case "dark": return "#1a1a1a";
            case "light": return "#ffffff";
            case "cherry": return "#450a0a";
            case "galaxy": return "#0f172a";
            case "nature": return "#1b4332";
            case "ocean": return "#0b1f2a";
            case "aurora": return "#10201c";
            case "twilight": return "#171324";
            case "realblack": return "#000000";
            case "dracula":
            default: return "#282a36";
        }
    }

    readonly property color darkbg: {
        switch (currentTheme) {
            case "dark": return "#141414";
            case "light": return "#f0f0f0";
            case "cherry": return "#7f1d1d";
            case "galaxy": return "#1f2a48";
            case "nature": return "#2d6a4f";
            case "ocean": return "#08202b";
            case "aurora": return "#152a24";
            case "twilight": return "#201936";
            case "realblack": return "#000000";
            case "dracula":
            default: return "#21222c";
        }
    }

    readonly property color borderc: {
        switch (currentTheme) {
            case "dark": return "#525252";
            case "light": return "#0f172a";
            case "cherry": return "#ea580c";
            case "galaxy": return "#8be9fd";
            case "nature": return "#a8dadc";
            case "ocean": return "#38bdf8";
            case "aurora": return "#5eead4";
            case "twilight": return "#c084fc";
            case "realblack": return "#6272a4";
            case "dracula":
            default: return "#6272a4";
        }
    }

    readonly property color selected: {
        switch (currentTheme) {
            case "dark": return "#3d3d3d";
            case "light": return "#e0e0e0";
            case "cherry": return "#d97706";
            case "galaxy": return "#457b9d";
            case "nature": return "#4d908e";
            case "ocean": return "#164e63";
            case "aurora": return "#315c52";
            case "twilight": return "#3b2a5a";
            case "realblack": return "#44475a";
            case "dracula":
            default: return "#44475a";
        }
    }

    readonly property color draculared: {
        switch (currentTheme) {
            case "ocean":
            case "aurora": return "#fb7185";
            case "twilight": return "#f43f5e";
            default: return "#ff5555";
        }
    }

    readonly property color textcolor: {
        switch (currentTheme) {
            case "light": return "#0f172a";
            case "ocean": return "#e6f6fb";
            case "aurora": return "#ecfdf5";
            case "twilight": return "#f8f5ff";
            case "dark": return "#f5f5f5";
            case "dracula":
            case "cherry":
            case "galaxy":
            case "nature":
            case "realblack":
            default: return "#f8f8f2";
        }
    }

    readonly property color textcolor2: {
        switch (currentTheme) {
            case "light": return "#64748b";
            case "dark": return "#a3a3a3";
            case "cherry": return "#fca5a5";
            case "galaxy": return "#8be9fd";
            case "nature": return "#4d908e";
            case "ocean": return "#8fc7d5";
            case "aurora": return "#a7f3d0";
            case "twilight": return "#c4b5fd";
            case "realblack":
            case "dracula":
            default: return "#64748b";
        }
    }

    readonly property color darkborderc: {
        switch (currentTheme) {
            case "light": return "#d1d5db";
            case "dark": return "#404040";
            case "cherry": return "#92400e";
            case "galaxy": return "#457b9d";
            case "nature": return "#457b9d";
            case "ocean": return "#155e75";
            case "aurora": return "#2f6f63";
            case "twilight": return "#4c3575";
            case "realblack":
            case "dracula":
            default: return "#4b5563";
        }
    }

    readonly property color darkbutton: {
        switch (currentTheme) {
            case "light": return "#e5e7eb";
            case "dark": return "#2e2e2e";
            case "cherry": return "#b45309";
            case "galaxy": return "#1f2a48";
            case "nature": return "#2d6a4f";
            case "ocean": return "#0f3a4a";
            case "aurora": return "#21443c";
            case "twilight": return "#2e2348";
            case "realblack":
            case "dracula":
            default: return "#374151";
        }
    }

    // Hover helper colors
    readonly property color darkbuttonHover: {
        switch (currentTheme) {
            case "light": return "#d1d5db";
            case "dark": return "#3a3a3a";
            default: return "#4b5563";
        }
    }

    readonly property color selectedHover: {
        switch (currentTheme) {
            case "light": return "#cbd5e1";
            case "dark": return "#505050";
            default: return "#6272a4";
        }
    }

    // Standard RisuAI Blue Action Accent (Tailwind blue-500)
    readonly property color primary: "#3b82f6"
    readonly property color primaryHover: "#2563eb"
    readonly property color primaryActive: "#1d4ed8"
    readonly property color primaryLight: "#60a5fa"

    // RisuAI Standard Text Theme Colors
    readonly property color fontStandard: (currentTheme === "light") ? "#0f172a" : "#fafafa"
    readonly property color fontBold: (currentTheme === "light") ? "#0f172a" : "#fafafa"
    readonly property color fontItalic: "#8c8d93"
    readonly property color fontItalicBold: "#8c8d93"
    readonly property color fontQuote1: "#8be9fd"
    readonly property color fontQuote2: "#ffb86c"

    // Semantic colors
    readonly property color success: "#50fa7b"
    readonly property color warning: "#f1fa8c"
    readonly property color danger: "#ff5555"
    readonly property color info: "#8be9fd"

    // Sizing & Radii
    readonly property int baseFontSize: typeof appConfig !== "undefined" && appConfig ? appConfig.fontSize : 15
    readonly property int fontTiny: 11
    readonly property int fontSmall: 13
    readonly property int fontNormal: baseFontSize
    readonly property int fontRegular: baseFontSize
    readonly property int fontMedium: baseFontSize + 2
    readonly property int fontLarge: baseFontSize + 5
    readonly property int fontTitle: baseFontSize + 10

    readonly property string fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans KR', Arial, sans-serif"
    readonly property string monoFontFamily: "'Fira Code', 'JetBrains Mono', 'Consolas', monospace"

    readonly property int radiusSmall: 4
    readonly property int radiusMedium: 8
    readonly property int radiusLarge: 12
    readonly property int radiusXLarge: 16
    readonly property int radiusFull: 9999

    // Animation timings
    readonly property int animFast: 120
    readonly property int animNormal: 200
    readonly property int animSlow: 300

    // Shared cache of measured WebEngine message heights keyed by message id.
    // Recreated ListView delegates seed their height from here so scrolling
    // never shifts the layout while Chromium re-measures the content.
    property var mdHeightCache: ({})
}
