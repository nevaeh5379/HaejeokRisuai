import SwiftUI

/// Theme colors resolved from the selected color scheme preset,
/// mirroring the web version's colorscheme system.
struct RisuTheme {
    var background: Color
    var backgroundPanel: Color
    var surface: Color
    var surfaceHover: Color
    var border: Color
    var text: Color
    var textDim: Color
    var accent: Color
    var accentText: Color
    var danger: Color

    static func theme(_ kind: ColorThemeKind) -> RisuTheme {
        switch kind {
        case .dark:
            return RisuTheme(
                background: Color(hex: 0x1B1B1E),
                backgroundPanel: Color(hex: 0x232327),
                surface: Color(hex: 0x2C2C31),
                surfaceHover: Color(hex: 0x37373D),
                border: Color(hex: 0x3D3D44),
                text: Color(hex: 0xF2F2F4),
                textDim: Color(hex: 0x9C9CA6),
                accent: Color(hex: 0x7A6FF0),
                accentText: .white,
                danger: Color(hex: 0xE5484D)
            )
        case .light:
            return RisuTheme(
                background: Color(hex: 0xF7F6F3),
                backgroundPanel: Color(hex: 0xFFFFFF),
                surface: Color(hex: 0xEFEEEA),
                surfaceHover: Color(hex: 0xE4E2DC),
                border: Color(hex: 0xD8D6CE),
                text: Color(hex: 0x26241F),
                textDim: Color(hex: 0x77746B),
                accent: Color(hex: 0x5B54D9),
                accentText: .white,
                danger: Color(hex: 0xD93A3F)
            )
        case .midnight:
            return RisuTheme(
                background: Color(hex: 0x10151F),
                backgroundPanel: Color(hex: 0x161D2B),
                surface: Color(hex: 0x1D2637),
                surfaceHover: Color(hex: 0x253047),
                border: Color(hex: 0x2C3952),
                text: Color(hex: 0xE8EDF7),
                textDim: Color(hex: 0x8792A8),
                accent: Color(hex: 0x4F8DF7),
                accentText: .white,
                danger: Color(hex: 0xE5484D)
            )
        case .sakura:
            return RisuTheme(
                background: Color(hex: 0x241A20),
                backgroundPanel: Color(hex: 0x2D2128),
                surface: Color(hex: 0x382932),
                surfaceHover: Color(hex: 0x45323D),
                border: Color(hex: 0x50394A),
                text: Color(hex: 0xFBEFF5),
                textDim: Color(hex: 0xC09AAE),
                accent: Color(hex: 0xF27DA8),
                accentText: .white,
                danger: Color(hex: 0xE5484D)
            )
        case .ocean:
            return RisuTheme(
                background: Color(hex: 0x0D1B22),
                backgroundPanel: Color(hex: 0x12242D),
                surface: Color(hex: 0x17303B),
                surfaceHover: Color(hex: 0x1D3D4A),
                border: Color(hex: 0x234957),
                text: Color(hex: 0xEAF7FB),
                textDim: Color(hex: 0x84AEBB),
                accent: Color(hex: 0x2EC5D3),
                accentText: Color(hex: 0x062126),
                danger: Color(hex: 0xE5484D)
            )
        case .forest:
            return RisuTheme(
                background: Color(hex: 0x131B14),
                backgroundPanel: Color(hex: 0x19241B),
                surface: Color(hex: 0x20301F),
                surfaceHover: Color(hex: 0x293D28),
                border: Color(hex: 0x30492E),
                text: Color(hex: 0xEEF7EA),
                textDim: Color(hex: 0x93AC90),
                accent: Color(hex: 0x67B85B),
                accentText: Color(hex: 0x10230E),
                danger: Color(hex: 0xE5484D)
            )
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1
        )
    }
}

/// Environment-injected theme.
private struct RisuThemeKey: EnvironmentKey {
    static let defaultValue: RisuTheme = RisuTheme.theme(.dark)
}

extension EnvironmentValues {
    var risuTheme: RisuTheme {
        get { self[RisuThemeKey.self] }
        set { self[RisuThemeKey.self] = newValue }
    }
}
