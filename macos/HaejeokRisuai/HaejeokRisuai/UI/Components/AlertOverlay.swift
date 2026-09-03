import SwiftUI

/// Floating toast overlay for global alerts.
struct AlertOverlay: View {
    @EnvironmentObject private var alerts: AlertCenter
    @Environment(\.risuTheme) private var theme

    var body: some View {
        Group {
            switch alerts.current {
            case .error(let msg):
                toast(msg, icon: "exclamationmark.triangle.fill", tint: theme.danger) {
                    alerts.dismiss()
                }
            case .info(let msg):
                toast(msg, icon: "info.circle.fill", tint: theme.accent)
            case .success(let msg):
                toast(msg, icon: "checkmark.circle.fill", tint: .green)
            case .none:
                EmptyView()
            }
        }
        .animation(.spring(duration: 0.3), value: alerts.current)
    }

    @ViewBuilder
    private func toast(_ message: String, icon: String, tint: Color, onTap: (() -> Void)? = nil) -> some View {
        Button(action: { onTap?() }) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                Text(message)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(theme.text)
                    .lineLimit(4)
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(theme.backgroundPanel)
                    .shadow(color: .black.opacity(0.25), radius: 10, y: 3)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(theme.border, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .padding(.top, 10)
    }
}
