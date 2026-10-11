import SwiftUI

/// Sheet listing all chats of a character with management actions.
struct ChatListSheet: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let characterId: UUID
    @Binding var isPresented: Bool

    @State private var confirmDeleteChat: ChatSession?

    private var character: CharacterCard? {
        db.character(id: characterId)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Chats")
                    .font(.headline)
                    .foregroundStyle(theme.text)
                Spacer()
                Button("New Chat") {
                    DatabaseStore.shared.newChat(characterId: characterId)
                }
                .buttonStyle(.borderedProminent)
                Button("Done") { isPresented = false }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(14)

            Divider().overlay(theme.border)

            List {
                ForEach(Array((character?.chats ?? []).enumerated()), id: \.element.id) { idx, chat in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(chat.name)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(theme.text)
                            Text("\(chat.messages.count) messages · \(formatDate(chat.lastDate))")
                                .font(.caption)
                                .foregroundStyle(theme.textDim)
                        }
                        Spacer()
                        if character?.chatPage == idx {
                            Image(systemName: "checkmark")
                                .foregroundStyle(theme.accent)
                        }
                        Menu {
                            Button("Open") { select(idx) }
                            Button("Rename...") { renameChat(idx) }
                            Button("Duplicate") {
                                DatabaseStore.shared.duplicateChat(characterId: characterId, chatId: chat.id)
                            }
                            Divider()
                            Button("Delete", role: .destructive) {
                                confirmDeleteChat = chat
                            }
                        } label: {
                            Image(systemName: "ellipsis.circle")
                        }
                        .menuStyle(.borderlessButton)
                        .fixedSize()
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { select(idx) }
                    .listRowBackground(
                        character?.chatPage == idx ? theme.surfaceHover : Color.clear
                    )
                }
            }
            .listStyle(.plain)
            .confirmationDialog(
                "Delete chat \"\(confirmDeleteChat?.name ?? "")\"?",
                isPresented: Binding(
                    get: { confirmDeleteChat != nil },
                    set: { if !$0 { confirmDeleteChat = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let c = confirmDeleteChat {
                        DatabaseStore.shared.deleteChat(characterId: characterId, chatId: c.id)
                    }
                    confirmDeleteChat = nil
                }
            } message: {
                Text("This cannot be undone.")
            }
        }
        .background(theme.backgroundPanel)
    }

    private func select(_ idx: Int) {
        GenerationManager.shared.stop()
        DatabaseStore.shared.updateCharacter(characterId) { $0.chatPage = idx }
        isPresented = false
    }

    private func renameChat(_ idx: Int) {
        guard let char = character else { return }
        let alert = NSAlert()
        alert.messageText = "Rename Chat"
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")

        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        input.stringValue = char.chats.indices.contains(idx) ? char.chats[idx].name : ""
        input.lineBreakMode = .byClipping
        alert.accessoryView = input

        if alert.runModal() == .alertFirstButtonReturn {
            let newName = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !newName.isEmpty else { return }
            DatabaseStore.shared.updateCharacter(characterId) { c in
                if c.chats.indices.contains(idx) {
                    c.chats[idx].name = newName
                }
            }
        }
    }

    private func formatDate(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "—" }
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
