import SwiftUI

/// Bottom input bar with send/stop and regenerate/swipe controls.
struct ChatInputBar: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    @Binding var text: String
    let isGenerating: Bool
    var inputFocused: FocusState<Bool>.Binding
    var onSend: () -> Void
    var onStop: () -> Void
    var onRegenerate: () -> Void
    var onSwipeLeft: () -> Void
    var onSwipeRight: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            suggestionChips
            HStack(alignment: .bottom, spacing: 10) {
                // Left controls
                VStack(spacing: 4) {
                    if isLastMessageChar {
                        Button(action: onSwipeLeft) {
                            Image(systemName: "chevron.left")
                                .frame(width: 26, height: 22)
                        }
                        .buttonStyle(.plain)
                        .help("Previous variant")
                    }
                }

                TextField("Send a message to \(currentName)...", text: $text, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .font(.system(size: 14))
                    .foregroundStyle(theme.text)
                    .focused(inputFocused)
                    .onKeyPress(.return, phases: .down) { press in
                        if db.settings.sendWithEnter && !press.modifiers.contains(.shift) {
                            Task { @MainActor in
                                sendIfPossible()
                            }
                            return .handled
                        }
                        return .ignored
                    }
                    .padding(.vertical, 8)

                // Right controls
                HStack(spacing: 8) {
                    if isGenerating {
                        Button(action: onStop) {
                            Image(systemName: "stop.fill")
                                .foregroundStyle(theme.danger)
                                .frame(width: 28, height: 24)
                        }
                        .buttonStyle(.plain)
                        .help("Stop generating")
                    } else {
                        if isLastMessageChar {
                            Button(action: onRegenerate) {
                                Image(systemName: "arrow.counterclockwise")
                                    .frame(width: 28, height: 24)
                            }
                            .buttonStyle(.plain)
                            .help("Regenerate last reply")
                            Button(action: onSwipeRight) {
                                Image(systemName: "arrow.right")
                                    .frame(width: 28, height: 24)
                            }
                            .buttonStyle(.plain)
                            .help("Next variant / swipe")
                        }
                        Button(action: sendIfPossible) {
                            Image(systemName: "paperplane.fill")
                                .foregroundStyle(canSend ? theme.accent : theme.textDim.opacity(0.5))
                                .frame(width: 28, height: 24)
                        }
                        .buttonStyle(.plain)
                        .disabled(!canSend)
                        .help("Send (⏎)")
                    }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)

            tokenBar
        }
        .background(theme.backgroundPanel)
        .onAppear { inputFocused.wrappedValue = true }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isGenerating
    }

    private var currentName: String {
        db.selectedCharacter?.nickname?.isEmpty == false
            ? db.selectedCharacter!.nickname!
            : (db.selectedCharacter?.name ?? "AI")
    }

    private var isLastMessageChar: Bool {
        guard let char = db.selectedCharacter else { return false }
        return char.currentChat().messages.last?.role == .char
    }

    private func sendIfPossible() {
        guard canSend else { return }
        onSend()
    }

    /// Clickable suggested follow-ups produced by the auxiliary model.
    @ViewBuilder
    private var suggestionChips: some View {
        if let suggestions = db.selectedCharacter?.currentChat().suggestMessages, !suggestions.isEmpty, !isGenerating {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(suggestions.enumerated()), id: \.offset) { _, suggestion in
                        Button {
                            text = suggestion
                            inputFocused.wrappedValue = true
                        } label: {
                            Text(suggestion)
                                .font(.system(size: 11))
                                .foregroundStyle(theme.textDim)
                                .lineLimit(1)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 5)
                                .background(
                                    Capsule().fill(theme.surface)
                                )
                                .overlay(Capsule().stroke(theme.border, lineWidth: 0.5))
                        }
                        .buttonStyle(.plain)
                    }
                    Button {
                        if let char = db.selectedCharacter {
                            DatabaseStore.shared.updateChat(
                                characterId: char.id,
                                chatId: char.currentChat().id
                            ) { $0.suggestMessages = nil }
                        }
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(theme.textDim)
                            .frame(width: 20, height: 20)
                    }
                    .buttonStyle(.plain)
                    .help("Dismiss suggestions")
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
            }
        }
    }

    private var tokenBar: some View {
        HStack(spacing: 12) {
            if db.settings.showTokenUsage {
                let estimate = promptEstimate()
                Label("~\(estimate.estimatedTokens) tokens", systemImage: "number")
                Text("\(estimate.messageCount) messages in context")
                Text("\(db.settings.maxContext) max context")
            }
            Spacer()
            if case .error(let msg) = GenerationManager.shared.state {
                Text(msg)
                    .lineLimit(1)
                    .font(.caption2)
                    .foregroundStyle(theme.danger)
            }
        }
        .font(.system(size: 10))
        .foregroundStyle(theme.textDim.opacity(0.8))
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    private func promptEstimate() -> (estimatedTokens: Int, messageCount: Int) {
        guard let char = db.selectedCharacter else { return (0, 0) }
        let builder = PromptBuilder(
            settings: db.settings,
            character: char,
            chat: char.currentChat(),
            personaPrompt: db.personaPrompt(),
            username: db.username()
        )
        let built = builder.build()
        return (built.estimatedTokens, built.messages.count - 2)
    }
}
