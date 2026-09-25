import Foundation

/// Builds the provider-ready prompt from character, persona, lorebook and chat history.
/// Mirrors the web version's ordered formatting (`formatingOrder`) with
/// `{{char}}` / `{{user}}` placeholder substitution.
struct PromptBuilder {
    let settings: AppSettings
    let character: CharacterCard
    let chat: ChatSession
    let personaPrompt: String
    let username: String

    init(settings: AppSettings, character: CharacterCard, chat: ChatSession, personaPrompt: String, username: String) {
        self.settings = settings
        self.character = character
        self.chat = chat
        self.personaPrompt = personaPrompt
        self.username = username
    }

    // MARK: - Placeholders

    func replacePlaceholders(_ text: String) -> String {
        var t = text.replacingOccurrences(of: "{{char}}", with: character.name)
        t = t.replacingOccurrences(of: "<BOT>", with: character.name)
        t = t.replacingOccurrences(of: "{{user}}", with: username)
        t = t.replacingOccurrences(of: "<USER>", with: username)
        if let nickname = character.nickname, !nickname.isEmpty {
            t = t.replacingOccurrences(of: "{{nickname}}", with: nickname)
        }
        return t
    }

    // MARK: - Blocks

    func descriptionBlock() -> String {
        guard !character.utilityBot else { return "" }
        var parts: [String] = []
        let prefix = replacePlaceholders(settings.descriptionPrefix)
        var desc = replacePlaceholders(character.desc)
        if !desc.isEmpty {
            desc = desc.hasPrefix("description of") ? desc : prefix + desc
            parts.append(desc)
        }
        if !character.personality.isEmpty {
            parts.append("personality of \(character.name): " + replacePlaceholders(character.personality))
        }
        if !character.scenario.isEmpty {
            parts.append("scenario of \(character.name): " + replacePlaceholders(character.scenario))
        }
        return parts.joined(separator: "\n")
    }

    func personaBlock() -> String {
        guard !personaPrompt.isEmpty else { return "" }
        return "description of \(username): \(replacePlaceholders(personaPrompt))"
    }

    func mainBlock() -> String {
        var text = settings.mainPrompt.isEmpty
            ? "The following is a conversation between \(username) and \(character.name)."
            : replacePlaceholders(settings.mainPrompt)
        if !settings.additionalPrompt.isEmpty {
            text += "\n" + replacePlaceholders(settings.additionalPrompt)
        }
        if !character.systemPrompt.isEmpty {
            text += "\n" + replacePlaceholders(character.systemPrompt)
        }
        return text
    }

    func globalNoteBlock() -> String {
        var note = character.replaceGlobalNote.isEmpty ? settings.globalNote : character.replaceGlobalNote
        if !note.isEmpty {
            note = "[Note]\n" + note
        }
        return note
    }

    func authorNoteBlock() -> String {
        var note = ""
        if !chat.note.isEmpty {
            note += "[Author's note]\n" + chat.note
        }
        if !character.additionalText.isEmpty {
            note += (note.isEmpty ? "" : "\n") + "[Note to AI]\n" + replacePlaceholders(character.additionalText)
        }
        return note
    }

    // MARK: - Message assembly

    /// Assembles the full prompt. Returns messages ready for any provider,
    /// plus the token estimate for display.
    struct BuiltPrompt {
        var messages: [PromptMessage]
        var estimatedTokens: Int
        var activatedLore: [LoreBookEntry]
    }

    func build() -> BuiltPrompt {
        let summarizedCount = chat.supaMemoryMessageCount ?? 0
        let visibleMessages = Array(chat.messages.dropFirst(summarizedCount))
            .filter { !$0.disabled && !$0.isComment }

        let loreEntries = LorebookEngine.activate(
            characterLore: character.globalLore.filter(\.enabled),
            chatLore: chat.localLore.filter(\.enabled),
            globalBooks: settings.loreBooks,
            history: visibleMessages,
            settings: settings
        )
        let loreBlock = LorebookEngine.formatBlock(loreEntries)

        var systemBlocks: [String] = []

        for item in settings.formattingOrder {
            switch item {
            case .main:
                let b = mainBlock()
                if !b.isEmpty { systemBlocks.append(b) }
            case .description:
                let b = descriptionBlock()
                if !b.isEmpty { systemBlocks.append(b) }
            case .personaPrompt:
                let b = personaBlock()
                if !b.isEmpty { systemBlocks.append(b) }
            case .lorebook:
                if !loreBlock.isEmpty { systemBlocks.append(loreBlock) }
            case .globalNote:
                let b = globalNoteBlock()
                if !b.isEmpty { systemBlocks.append(b) }
            case .authorNote:
                let b = authorNoteBlock()
                if !b.isEmpty { systemBlocks.append(b) }
            case .chats, .lastChat, .jailbreak, .postEverything:
                break // handled below
            }
        }

        // SupaMemory summary of earlier conversation.
        if let memory = chat.supaMemoryText, !memory.isEmpty {
            let label = settings.supaMemory.prompt.isEmpty
                ? "[Summary of previous events]:"
                : settings.supaMemory.prompt
            systemBlocks.append("\(label)\n\(memory)")
        }

        var messages: [PromptMessage] = []

        if !systemBlocks.isEmpty {
            messages.append(PromptMessage(role: "system", content: systemBlocks.joined(separator: "\n\n")))
        }

        // Example messages block.
        let exampleBlock = buildExampleBlock()
        if !exampleBlock.isEmpty {
            messages.append(contentsOf: exampleBlock)
        }

        // Chat history with context trimming.
        let budgetTokens = max(512, settings.maxContext - settings.maxResponse)
        var historyTokens = TokenEstimator.estimate(messages: messages)
        var history: [ChatMessage] = []
        let reversed = Array(visibleMessages.reversed())
        for msg in reversed {
            let cost = TokenEstimator.estimate(msg.data) + 4
            if historyTokens + cost > budgetTokens && !history.isEmpty {
                break
            }
            history.append(msg)
            historyTokens += cost
        }
        history.reverse()

        for msg in history {
            let content = replacePlaceholders(msg.data)
            let role = msg.role == .user ? "user" : "assistant"
            let namePrefix = msg.name.flatMap { $0.isEmpty ? nil : "\($0): " } ?? ""
            messages.append(PromptMessage(role: role, content: namePrefix + content))
        }

        // Post-history instructions (jailbreak) appended at the end.
        if settings.formattingOrder.contains(.jailbreak), !settings.jailbreak.isEmpty {
            messages.append(PromptMessage(role: "system", content: replacePlaceholders(settings.jailbreak)))
        }

        return BuiltPrompt(
            messages: messages,
            estimatedTokens: TokenEstimator.estimate(messages: messages),
            activatedLore: loreEntries
        )
    }

    private func buildExampleBlock() -> [PromptMessage] {
        guard !character.exampleMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return []
        }
        var out: [PromptMessage] = [PromptMessage(role: "system", content: "Example conversations involving \(character.name):")]
        let segments = character.exampleMessage.components(separatedBy: "<START>")
        for segment in segments {
            let trimmed = segment.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            out.append(PromptMessage(role: "user", content: trimmed))
        }
        return out
    }
}
