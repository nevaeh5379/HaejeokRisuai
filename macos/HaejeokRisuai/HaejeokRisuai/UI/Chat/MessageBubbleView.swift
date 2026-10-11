import SwiftUI

/// A single chat message with actions (copy/edit/delete/regenerate/TTS).
struct MessageBubbleView: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    let message: ChatMessage
    let characterName: String
    let username: String
    let personaIconAssetId: String?
    let characterImageAssetId: String?
    let isLast: Bool
    let isEditing: Bool
    var onEditToggle: () -> Void

    @State private var editedText = ""
    @State private var hovered = false

    private var isUser: Bool { message.role == .user }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            if isUser { Spacer(minLength: 60) }
            avatar
            VStack(alignment: .leading, spacing: 4) {
                nameRow
                if isEditing {
                    editor
                } else {
                    bubbleBody
                }
                metaRow
            }
            if !isUser { Spacer(minLength: 60) }
        }
        .onHover { hovered = $0 }
    }

    // MARK: - Parts

    @ViewBuilder
    private var avatar: some View {
        if isUser {
            if let iconId = personaIconAssetId, let img = AssetStore.shared.loadImage(iconId) {
                Image(nsImage: img)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 32, height: 32)
                    .clipShape(Circle())
            } else {
                ZStack {
                    Circle().fill(theme.surfaceHover)
                    Text(username.prefix(1).uppercased())
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.textDim)
                }
                .frame(width: 32, height: 32)
            }
        } else {
            CharacterAvatar(
                character: CharacterCard(name: characterName, imageAssetId: characterImageAssetId),
                size: 32
            )
        }
    }

    private var nameRow: some View {
        HStack(spacing: 6) {
            Text(isUser ? username : message.name?.isEmpty == false ? message.name! : characterName)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(theme.textDim)
            if message.isComment {
                Image(systemName: "note.text")
                    .font(.system(size: 9))
                    .foregroundStyle(theme.textDim)
            }
            if message.disabled {
                Image(systemName: "eye.slash")
                    .font(.system(size: 9))
                    .foregroundStyle(theme.danger)
            }
        }
    }

    private var bubbleBody: some View {
        Group {
            if message.data.isEmpty {
                typingIndicator
            } else {
                MarkdownText(text: message.data)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(maxWidth: 620, alignment: .leading)
        .background(bubbleBackground)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .bottomTrailing) {
            swipeIndicator
        }
        .contextMenu { contextMenu }
    }

    private var bubbleBackground: Color {
        if isUser {
            return theme.accent.opacity(0.16)
        }
        return theme.surface
    }

    @ViewBuilder
    private var swipeIndicator: some View {
        if let swipes = message.swipes, swipes.count > 1,
           let idx = message.swipeIndex {
            HStack(spacing: 2) {
                Image(systemName: "chevron.left")
                Text("\(idx + 1)/\(swipes.count)")
                Image(systemName: "chevron.right")
            }
            .font(.system(size: 9, weight: .medium))
            .foregroundStyle(theme.textDim)
            .padding(4)
        }
    }

    private var typingIndicator: some View {
        HStack(spacing: 5) {
            ForEach(0..<3) { i in
                Circle()
                    .fill(theme.textDim)
                    .frame(width: 6, height: 6)
                    .opacity(0.7)
                    .offset(y: i == 1 ? -3 : 0)
            }
        }
        .padding(.vertical, 2)
    }

    private var editor: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextEditor(text: $editedText)
                .font(.body)
                .scrollContentBackground(.hidden)
                .foregroundStyle(theme.text)
                .frame(minWidth: 480, minHeight: 90)
                .padding(6)
                .background(theme.backgroundPanel)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(theme.accent.opacity(0.6), lineWidth: 1)
                )

            HStack {
                Button("Cancel") { onEditToggle() }
                Button("Save") {
                    saveEdit()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: 620)
        .padding(6)
        .background(theme.surface)
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var metaRow: some View {
        HStack(spacing: 10) {
            if hovered || isEditing {
                actionButtons
            } else if let info = message.generationInfo, db.settings.showTokenUsage {
                tokenInfo(info)
            }
        }
        .animation(.easeInOut(duration: 0.12), value: hovered)
    }

    private func tokenInfo(_ info: GenerationInfo) -> some View {
        HStack(spacing: 6) {
            if let m = info.model {
                Text(m).lineLimit(1)
            }
            if let out = info.outputTokens {
                Text("↑\(info.inputTokens ?? 0) ↓\(out)")
            }
        }
        .font(.system(size: 9))
        .foregroundStyle(theme.textDim.opacity(0.75))
    }

    private var actionButtons: some View {
        HStack(spacing: 2) {
            iconButton("doc.on.doc", "Copy") {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(message.data, forType: .string)
            }
            iconButton(isEditing ? "pencil.slash" : "pencil", "Edit") { onEditToggle() }
            iconButton("speaker.wave.2", "Speak") {
                SpeechManager.shared.speak(message.saying ?? message.data)
            }
            if !isUser && isLast {
                iconButton("arrow.counterclockwise", "Regenerate") {
                    GenerationManager.shared.regenerate()
                }
            }
            if !isUser && isLast && GenerationManager.shared.isGenerating != true {
                iconButton("forward.end", "Swipe") {
                    GenerationManager.shared.swipe(direction: 1)
                }
            }
            iconButton(message.disabled ? "eye" : "eye.slash", "Toggle inclusion") {
                toggleDisabled()
            }
            iconButton("trash", "Delete", color: theme.danger) {
                deleteMessage()
            }
        }
        .font(.caption)
    }

    @ViewBuilder
    private var contextMenu: some View {
        Button("Copy") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(message.data, forType: .string)
        }
        Button("Edit") { onEditToggle() }
        if !isUser && isLast {
            Button("Regenerate") { GenerationManager.shared.regenerate() }
        }
        Divider()
        Button(message.disabled ? "Include in Prompt" : "Exclude from Prompt") {
            toggleDisabled()
        }
        Divider()
        Button("Delete", role: .destructive) { deleteMessage() }
    }

    private func iconButton(_ systemImage: String, _ help: String, color: Color? = nil, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 11))
                .foregroundStyle(color ?? theme.textDim)
                .frame(width: 22, height: 20)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
    }

    // MARK: - Mutations

    private func chatId() -> UUID? {
        db.character(id: currentCharacterId())?.currentChat().id
    }

    private func currentCharacterId() -> UUID {
        db.selectedCharId ?? UUID()
    }

    private func saveEdit() {
        guard let charId = db.selectedCharId else { return }
        let char = db.character(id: charId)
        guard let cid = char?.currentChat().id else { return }
        let newText = editedText
        let mid = message.id
        DatabaseStore.shared.updateChat(characterId: charId, chatId: cid) { c in
            if let idx = c.messages.firstIndex(where: { $0.id == mid }) {
                c.messages[idx].data = newText
            }
        }
        onEditToggle()
    }

    private func toggleDisabled() {
        guard let charId = db.selectedCharId else { return }
        guard let cid = db.character(id: charId)?.currentChat().id else { return }
        let mid = message.id
        DatabaseStore.shared.updateChat(characterId: charId, chatId: cid) { c in
            if let idx = c.messages.firstIndex(where: { $0.id == mid }) {
                c.messages[idx].disabled.toggle()
            }
        }
    }

    private func deleteMessage() {
        guard let charId = db.selectedCharId else { return }
        guard let cid = db.character(id: charId)?.currentChat().id else { return }
        let mid = message.id
        DatabaseStore.shared.updateChat(characterId: charId, chatId: cid) { c in
            c.messages.removeAll(where: { $0.id == mid })
        }
    }
}

// MARK: - Lightweight markdown rendering

/// Renders roleplay-style text: *italic* actions, **bold**, `code`, quotes and paragraphs.
struct MarkdownText: View {
    @Environment(\.risuTheme) private var theme

    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, para in
                inlineText(para)
            }
        }
    }

    private var paragraphs: [String] {
        text.components(separatedBy: "\n\n")
    }

    @ViewBuilder
    private func inlineText(_ paragraph: String) -> some View {
        let lines = paragraph.split(separator: "\n", omittingEmptySubsequences: true)
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                lineView(String(line))
            }
        }
    }

    @ViewBuilder
    private func lineView(_ line: String) -> some View {
        if line.hasPrefix("> ") {
            Text(line.dropFirst(2))
                .italic()
                .foregroundStyle(theme.accent)
        } else {
            styled(line)
        }
    }

    /// Splits a line into styled runs: **bold**, *italic*.
    private func styled(_ line: String) -> Text {
        var attributed = AttributedString(line)

        applyStyle(&attributed, marker: "**") { container in
            container.font = Font.system(size: DatabaseStore.shared.settings.fontSize).bold()
        }
        applyStyle(&attributed, marker: "*") { container in
            container.font = Font.system(size: DatabaseStore.shared.settings.fontSize).italic()
        }
        applyStyle(&attributed, marker: "`") { container in
            container.font = Font.system(size: DatabaseStore.shared.settings.fontSize - 1, design: .monospaced)
            container.foregroundColor = theme.accent
        }

        return Text(attributed)
            .font(.system(size: DatabaseStore.shared.settings.fontSize))
    }

    /// Applies a style to segments delimited by `marker` (non-greedy pairs).
    private func applyStyle(
        _ attributed: inout AttributedString,
        marker: String,
        style: (inout AttributeContainer) -> Void
    ) {
        while true {
            guard let startRange = attributed.range(of: marker) else { break }
            guard let endRange = attributed[startRange.upperBound...].range(of: marker) else { break }

            let contentStart = startRange.upperBound
            let contentEnd = endRange.lowerBound
            var container = AttributeContainer()
            style(&container)

            attributed[contentStart..<contentEnd].mergeAttributes(container)

            attributed.removeSubrange(endRange.lowerBound..<endRange.upperBound)
            attributed.removeSubrange(startRange.lowerBound..<startRange.upperBound)
        }
    }
}
