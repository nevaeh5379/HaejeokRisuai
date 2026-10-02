import SwiftUI
import UniformTypeIdentifiers

/// The main chat area for the selected character: header, messages, input bar.
struct ChatScreenView: View {
    @EnvironmentObject private var db: DatabaseStore
    @EnvironmentObject private var gen: GenerationManager
    @Environment(\.risuTheme) private var theme

    @State private var inputText = ""
    @State private var showChatList = false
    @FocusState private var inputFocused: Bool

    private var character: CharacterCard? {
        db.selectedCharacter
    }

    var body: some View {
        Group {
            if let char = character, !char.chats.isEmpty {
                let chat = char.currentChat()
                VStack(spacing: 0) {
                    headerBar(char)
                    Divider().overlay(theme.border)
                    MessageListView(characterId: char.id, chatId: chat.id)
                    Divider().overlay(theme.border)
                    ChatInputBar(
                        text: $inputText,
                        isGenerating: gen.isGenerating,
                        inputFocused: $inputFocused,
                        onSend: { send() },
                        onStop: { GenerationManager.shared.stop() },
                        onRegenerate: { GenerationManager.shared.regenerate() },
                        onSwipeLeft: { GenerationManager.shared.swipe(direction: -1) },
                        onSwipeRight: { GenerationManager.shared.swipe(direction: 1) }
                    )
                }
                .background(theme.background)
                .sheet(isPresented: $showChatList) {
                    ChatListSheet(characterId: char.id, isPresented: $showChatList)
                        .environment(\.risuTheme, theme)
                        .frame(minWidth: 460, minHeight: 420)
                }
            } else if let char = character {
                // No chats yet — offer to create one.
                VStack(spacing: 14) {
                    CharacterAvatar(character: char, size: 84)
                    Text(char.name).font(.title2).foregroundStyle(theme.text)
                    Button("Start New Chat") {
                        GenerationManager.shared.stop()
                        DatabaseStore.shared.newChat(characterId: char.id)
                    }
                    .buttonStyle(.borderedProminent)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.background)
            }
        }
    }

    // MARK: - Header

    private func headerBar(_ char: CharacterCard) -> some View {
        let chat = char.currentChat()
        return HStack(spacing: 10) {
            CharacterAvatar(character: char, size: 34)
            VStack(alignment: .leading, spacing: 1) {
                Text(char.nickname?.isEmpty == false ? char.nickname! : char.name)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                Text("\(chat.name) · \(chat.messages.count) messages")
                    .font(.system(size: 11))
                    .foregroundStyle(theme.textDim)
            }
            Spacer()

            greetingPicker(char)

            Button {
                showChatList = true
            } label: {
                Label("Chats", systemImage: "list.bullet")
                    .labelStyle(.iconOnly)
            }
            .buttonStyle(.borderless)
            .help("Chat list")

            chatMenu(char, chat)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    /// Picks which greeting seeds new chats (default first message or an alternate).
    @ViewBuilder
    private func greetingPicker(_ char: CharacterCard) -> some View {
        if !char.alternateGreetings.isEmpty {
            Menu {
                Button("Default First Message") { setFmIndex(char, -1) }
                ForEach(Array(char.alternateGreetings.enumerated()), id: \.offset) { idx, _ in
                    Button("Alternate Greeting \(idx + 1)") { setFmIndex(char, idx) }
                }
            } label: {
                let current = char.currentChat().fmIndex
                Label(
                    current == -1 ? "Greeting: Default" : "Greeting: Alt \(current + 1)",
                    systemImage: "text.badge.star"
                )
                .font(.system(size: 11))
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }

    private func setFmIndex(_ char: CharacterCard, _ index: Int) {
        DatabaseStore.shared.updateChat(characterId: char.id, chatId: char.currentChat().id) {
            $0.fmIndex = index
        }
    }

    @ViewBuilder
    private func chatMenu(_ char: CharacterCard, _ chat: ChatSession) -> some View {
        Menu {
            Button("New Chat") {
                GenerationManager.shared.stop()
                DatabaseStore.shared.newChat(characterId: char.id)
            }
            Button("Rename Chat...") { renameCurrentChat(char) }
            Button("Author's Note...") { editChatNote(char) }

            Divider()

            Button("Export Chat as Text...") { exportChatText(char, chat) }
            Button("Export Chat as JSON...") { exportChatJSON(char, chat) }

            Divider()

            Button("Export Card as PNG") { ImportExportCoordinator.shared.exportSelected(as: .png) }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private func editChatNote(_ char: CharacterCard) {
        let alert = NSAlert()
        alert.messageText = "Author's Note"
        alert.informativeText = "Injected into every prompt for this chat."
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 110))
        scrollView.hasVerticalScroller = true
        let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 300, height: 110))
        textView.isRichText = false
        textView.font = .systemFont(ofSize: 13)
        textView.string = char.currentChat().note
        scrollView.documentView = textView
        alert.accessoryView = scrollView

        if alert.runModal() == .alertFirstButtonReturn {
            let note = textView.string
            DatabaseStore.shared.updateChat(characterId: char.id, chatId: char.currentChat().id) {
                $0.note = note
            }
        }
    }

    private func renameCurrentChat(_ char: CharacterCard) {
        let alert = NSAlert()
        alert.messageText = "Rename Chat"
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        input.stringValue = char.currentChat().name
        input.lineBreakMode = .byClipping
        alert.accessoryView = input

        if alert.runModal() == .alertFirstButtonReturn {
            let newName = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !newName.isEmpty else { return }
            DatabaseStore.shared.updateChat(characterId: char.id, chatId: char.currentChat().id) {
                $0.name = newName
            }
        }
    }

    private func exportChatText(_ char: CharacterCard, _ chat: ChatSession) {
        var out = "\(char.name) — \(chat.name)\n\(String(repeating: "=", count: 40))\n\n"
        for m in chat.messages {
            let who = m.role == .user ? db.username() : (m.name?.isEmpty == false ? m.name! : char.name)
            out += "\(who):\n\(m.data)\n\n"
        }
        saveData(Data(out.utf8), defaultName: "\(char.name) - \(chat.name).txt", type: "public.plain-text")
    }

    private func exportChatJSON(_ char: CharacterCard, _ chat: ChatSession) {
        struct ExportMessage: Codable {
            var role: String
            var name: String?
            var data: String
            var time: Double?
        }
        let messages = chat.messages.map {
            ExportMessage(role: $0.role.rawValue, name: $0.name, data: $0.data, time: $0.time)
        }
        guard let data = try? JSONEncoder().encode(messages) else { return }
        saveData(data, defaultName: "\(char.name) - \(chat.name).json", type: "public.json")
    }

    private func saveData(_ data: Data, defaultName: String, type: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = defaultName.replacingOccurrences(of: "/", with: "-")
        panel.allowedContentTypes = [UTType(type) ?? .data]
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try data.write(to: url)
                AlertCenter.shared.success("Saved")
            } catch {
                AlertCenter.shared.error(error)
            }
        }
    }

    // MARK: - Actions

    private func send() {
        let text = inputText
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        inputText = ""
        GenerationManager.shared.send(text: text)
    }
}

// MARK: - Message list

struct MessageListView: View {
    @EnvironmentObject private var db: DatabaseStore
    @Environment(\.risuTheme) private var theme

    let characterId: UUID
    let chatId: UUID

    @State private var editingMessageId: UUID?

    private var chat: ChatSession? {
        db.character(id: characterId)?.chats.first(where: { $0.id == chatId })
    }

    private var visibleMessages: [ChatMessage] {
        chat?.messages ?? []
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(visibleMessages) { message in
                        MessageBubbleView(
                            message: message,
                            characterName: db.character(id: characterId)?.name ?? "",
                            username: db.username(),
                            personaIconAssetId: db.activePersona()?.iconAssetId,
                            characterImageAssetId: db.character(id: characterId)?.imageAssetId,
                            isLast: message.id == visibleMessages.last?.id,
                            isEditing: editingMessageId == message.id,
                            onEditToggle: {
                                editingMessageId = editingMessageId == message.id ? nil : message.id
                            }
                        )
                        .id(message.id)
                    }
                    Color.clear.frame(height: 4).id("bottom-anchor")
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 12)
            }
            .onChange(of: visibleMessages.last?.data.count) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("bottom-anchor", anchor: .bottom)
                }
            }
            .onChange(of: visibleMessages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("bottom-anchor", anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo("bottom-anchor", anchor: .bottom)
            }
            .scrollDismissesKeyboard(.immediately)
        }
    }
}
