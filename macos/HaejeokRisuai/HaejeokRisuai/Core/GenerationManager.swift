import Foundation
import SwiftUI
import Combine
import os

/// Orchestrates chat generation: builds prompts, streams from the provider into
/// the active chat, and manages regenerate/swipe/stop flows.
@MainActor
final class GenerationManager: ObservableObject {
    static let shared = GenerationManager()

    enum GenState: Equatable {
        case idle
        case generating(characterId: UUID)
        case error(String)
    }

    @Published var state: GenState = .idle

    private var currentTask: Task<Void, Never>?
    private var currentAuxTask: Task<Void, Never>?
    private var currentSuggestTask: Task<Void, Never>?
    private var pendingRef: (characterId: UUID, chatId: UUID, messageId: UUID)?

    var isGenerating: Bool {
        if case .generating = state { return true }
        return false
    }

    // MARK: - Public actions

    /// Sends a user message and generates a reply.
    func send(text: String) {
        guard !isGenerating else { return }
        guard let charId = DatabaseStore.shared.selectedCharId,
              let char = DatabaseStore.shared.character(id: charId) else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let chat = char.currentChat()
        let processedText = applyScripts(trimmed, character: char, placement: .input)
            .replacingOccurrences(of: "{{user}}", with: DatabaseStore.shared.username())

        DatabaseStore.shared.updateChat(characterId: char.id, chatId: chat.id) {
            $0.messages.append(ChatMessage(role: .user, data: processedText))
        }

        generate()
    }

    /// Generates a fresh reply for the current chat.
    func generate() {
        guard let charId = DatabaseStore.shared.selectedCharId,
              let char = DatabaseStore.shared.character(id: charId),
              !char.chats.isEmpty else { return }
        startStreaming(character: char, chat: char.currentChat(), swipeTarget: nil)
    }

    /// Regenerates the last character message.
    func regenerate() {
        guard !isGenerating else { return }
        guard let charId = DatabaseStore.shared.selectedCharId,
              let char = DatabaseStore.shared.character(id: charId),
              !char.chats.isEmpty,
              let last = char.currentChat().messages.last, last.role == .char else { return }

        DatabaseStore.shared.updateChat(characterId: char.id, chatId: char.currentChat().id) {
            $0.messages.removeLast()
        }
        generate()
    }

    /// Moves between swipe variants of the last character message;
    /// swiping right past the end creates a new variant via generation.
    func swipe(direction: Int) {
        guard !isGenerating else { return }
        guard let charId = DatabaseStore.shared.selectedCharId,
              let char = DatabaseStore.shared.character(id: charId),
              !char.chats.isEmpty else { return }

        let chat = char.currentChat()
        guard let lastIdx = chat.messages.indices.last,
              chat.messages[lastIdx].role == .char else { return }

        let message = chat.messages[lastIdx]
        let swipes = message.swipes ?? [message.data]

        // Left: move back through existing variants.
        if direction < 0 {
            let current = message.swipeIndex ?? 0
            guard current > 0 else { return }
            let idx = current - 1
            DatabaseStore.shared.updateChat(characterId: char.id, chatId: chat.id) { c in
                c.messages[lastIdx].swipeIndex = idx
                c.messages[lastIdx].data = idx < swipes.count ? swipes[idx] : ""
            }
            return
        }

        // Right: next existing variant, or generate a new one.
        let current = message.swipeIndex ?? 0
        if current + 1 < swipes.count {
            let idx = current + 1
            DatabaseStore.shared.updateChat(characterId: char.id, chatId: chat.id) { c in
                c.messages[lastIdx].swipeIndex = idx
                c.messages[lastIdx].data = swipes[idx]
            }
            return
        }

        // Generate new variant: mark pending index at end of list.
        let pendingIndex = swipes.count
        DatabaseStore.shared.updateChat(characterId: char.id, chatId: chat.id) { c in
            c.messages[lastIdx].data = ""
            c.messages[lastIdx].swipeIndex = pendingIndex
            if c.messages[lastIdx].swipes == nil {
                c.messages[lastIdx].swipes = [message.data]
            }
        }
        startStreaming(
            character: char,
            chat: DatabaseStore.shared.character(id: charId)?.currentChat() ?? chat,
            swipeTarget: SwipeTarget(messageIndex: lastIdx)
        )
    }

    struct SwipeTarget {
        var messageIndex: Int
    }

    func stop() {
        currentTask?.cancel()
        currentTask = nil
        currentAuxTask?.cancel()
        currentSuggestTask?.cancel()
    }

    // MARK: - Core streaming

    private func startStreaming(character: CharacterCard, chat: ChatSession, swipeTarget: SwipeTarget?) {
        guard !isGenerating else { return }

        do {
            let config = try LLMProviderFactory.makeConfig(db: DatabaseStore.shared)
            let personaPrompt = DatabaseStore.shared.personaPrompt()
            let builder = PromptBuilder(
                settings: DatabaseStore.shared.settings,
                character: character,
                chat: chat,
                personaPrompt: personaPrompt,
                username: DatabaseStore.shared.username()
            )
            let built = builder.build()

            let provider = LLMProviderFactory.provider(for: DatabaseStore.shared.settings.apiType)

            let messageId = UUID()
            pendingRef = (character.id, chat.id, messageId)

            if let target = swipeTarget {
                DatabaseStore.shared.updateChat(characterId: character.id, chatId: chat.id) { c in
                    guard c.messages.indices.contains(target.messageIndex) else { return }
                    c.messages[target.messageIndex].data = ""
                    c.messages[target.messageIndex].generationInfo = GenerationInfo(model: config.model)
                    // swipeIndex already holds the pending variant position.
                }
            } else {
                DatabaseStore.shared.updateChat(characterId: character.id, chatId: chat.id) { c in
                    c.messages.append(
                        ChatMessage(
                            role: .char,
                            data: "",
                            name: character.name,
                            generationInfo: GenerationInfo(model: config.model)
                        )
                    )
                }
            }

            state = .generating(characterId: character.id)
            let stream = provider.stream(messages: built.messages, config: config)
            let startTime = Date()

            currentTask = Task { [weak self] in
                var full = ""
                do {
                    for try await delta in stream {
                        full += delta
                        self?.updateStreamingMessage(text: full)
                    }
                    try Task.checkCancellation()
                    self?.finalize(full: full, config: config, tokensIn: built.estimatedTokens, duration: Date().timeIntervalSince(startTime))
                } catch is CancellationError {
                    self?.finalize(full: full.isEmpty ? "(stopped)" : full, config: config, tokensIn: built.estimatedTokens, duration: Date().timeIntervalSince(startTime), stopped: true)
                } catch {
                    AppLog.generation.error("Generation failed: \(error.localizedDescription)")
                    self?.rollbackPendingMessage()
                    AlertCenter.shared.error(error)
                    self?.state = .error(error.localizedDescription)
                }
            }
        } catch {
            rollbackPendingMessage()
            AlertCenter.shared.error(error)
            state = .error(error.localizedDescription)
        }
    }

    private func updateStreamingMessage(text: String) {
        guard let ref = pendingRef else { return }
        let display = applyScripts(text, character: DatabaseStore.shared.character(id: ref.characterId), placement: .output)
        DatabaseStore.shared.updateChat(characterId: ref.characterId, chatId: ref.chatId) { c in
            guard let idx = c.messages.firstIndex(where: { $0.id == ref.messageId }) else { return }
            c.messages[idx].data = display
        }
    }

    /// Removes the placeholder after a failure, restoring any pre-existing swipe text.
    private func rollbackPendingMessage() {
        guard let ref = pendingRef else { return }
        pendingRef = nil
        currentTask = nil
        DatabaseStore.shared.updateChat(characterId: ref.characterId, chatId: ref.chatId) { c in
            guard let idx = c.messages.firstIndex(where: { $0.id == ref.messageId }) else { return }
            if let si = c.messages[idx].swipeIndex {
                let swipes = c.messages[idx].swipes ?? []
                if si < swipes.count {
                    c.messages[idx].data = swipes[si]
                    c.messages[idx].swipeIndex = min(si, max(0, swipes.count - 1))
                } else {
                    c.messages[idx].swipeIndex = si > 0 ? si - 1 : nil
                    let fallback = c.messages[idx].swipeIndex.flatMap { $0 < swipes.count ? swipes[$0] : nil }
                    c.messages[idx].data = fallback ?? "(failed)"
                }
            } else if c.messages[idx].data.isEmpty {
                c.messages.removeAll(where: { $0.id == ref.messageId })
            } else {
                c.messages[idx].data = "(failed)"
            }
        }
        state = .idle
    }

    private func finalize(full: String, config: GenerationConfig, tokensIn: Int, duration: TimeInterval, stopped: Bool = false) {
        defer {
            pendingRef = nil
            currentTask = nil
            state = .idle
        }
        _ = duration
        _ = stopped

        guard let ref = pendingRef else { return }
        let char = DatabaseStore.shared.character(id: ref.characterId)
        let finalText = applyScripts(full, character: char, placement: .output)
        let saying = extractSaying(finalText)
        let tokensOut = TokenEstimator.estimate(finalText)

        DatabaseStore.shared.updateChat(characterId: ref.characterId, chatId: ref.chatId) { c in
            guard let idx = c.messages.firstIndex(where: { $0.id == ref.messageId }) else { return }

            if let si = c.messages[idx].swipeIndex {
                // Store as a swipe variant.
                var swipes = c.messages[idx].swipes ?? []
                while swipes.count <= si { swipes.append("") }
                swipes[si] = finalText
                c.messages[idx].swipes = swipes
                c.messages[idx].data = finalText
            } else {
                c.messages[idx].data = finalText
            }
            c.messages[idx].saying = saying
            c.messages[idx].generationInfo = GenerationInfo(model: config.model, inputTokens: tokensIn, outputTokens: tokensOut)
        }

        DatabaseStore.shared.settings.statisticsMessages += 1

        // Post-generation auxiliary tasks.
        let characterId = ref.characterId
        let chatId = ref.chatId
        if DatabaseStore.shared.settings.memoryAlgorithm == .supaMemory,
           DatabaseStore.shared.settings.supaMemory.enabled {
            runSupaMemorySummarization(characterId: characterId, chatId: chatId)
        }
        if DatabaseStore.shared.settings.autoSuggestMessages {
            runAutoSuggestions(characterId: characterId, chatId: chatId)
        }
    }

    // MARK: - SupaMemory (summarization)

    private static let supaKeepRecent = 12
    private static let supaTriggerThreshold = 24

    private func runSupaMemorySummarization(characterId: UUID, chatId: UUID) {
        guard let chat = DatabaseStore.shared.character(id: characterId)?
            .chats.first(where: { $0.id == chatId }) else { return }

        let already = chat.supaMemoryMessageCount ?? 0
        let total = chat.messages.count
        guard total - already >= Self.supaTriggerThreshold else { return }

        let toSummarize = chat.messages[already..<(total - Self.supaKeepRecent)]
        guard !toSummarize.isEmpty else { return }

        let transcript = toSummarize.map { msg in
            let who = msg.role == .user ? DatabaseStore.shared.username() : "AI"
            return "\(who): \(msg.data)"
        }.joined(separator: "\n")

        let previous = chat.supaMemoryText ?? ""
        let promptText = DatabaseStore.shared.settings.supaMemory.prompt.isEmpty
            ? "[Summary of previous events]:"
            : DatabaseStore.shared.settings.supaMemory.prompt

        let config: GenerationConfig
        do {
            config = try auxConfig(maxTokens: 500)
        } catch {
            return // aux config unavailable; silently skip
        }

        let messages = [
            PromptMessage(role: "system", content: "You summarize roleplay conversations. Be concise, factual, keep character names and key events. Write in English."),
            PromptMessage(
                role: "user",
                content: "\(promptText)\n\nPrevious summary:\n\(previous.isEmpty ? "(none)" : previous)\n\nNew messages to fold in:\n\(transcript)\n\nWrite the updated summary:"
            ),
        ]

        let stream = OpenAICompatibleProvider().stream(messages: messages, config: config)
        currentAuxTask?.cancel()
        currentAuxTask = Task { [weak self] in
            var summary = ""
            do {
                for try await delta in stream {
                    summary += delta
                }
            } catch {
                return
            }
            let cleaned = summary.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !cleaned.isEmpty, !Task.isCancelled else { return }
            DatabaseStore.shared.updateChat(characterId: characterId, chatId: chatId) { c in
                c.supaMemoryText = cleaned
                c.supaMemoryMessageCount = total - Self.supaKeepRecent
            }
            _ = self
        }
    }

    // MARK: - Auto suggestions

    private func runAutoSuggestions(characterId: UUID, chatId: UUID) {
        guard let chat = DatabaseStore.shared.character(id: characterId)?
            .chats.first(where: { $0.id == chatId }), !chat.messages.isEmpty else { return }

        let recent = chat.messages.suffix(8).map { msg in
            "\(msg.role == .user ? "User" : "AI"): \(msg.data.prefix(300))"
        }.joined(separator: "\n")

        let config: GenerationConfig
        do {
            config = try auxConfig(maxTokens: 120)
        } catch {
            return
        }

        let messages = [
            PromptMessage(role: "system", content: "Suggest 3 short next messages the user could send in this roleplay. Reply with exactly 3 lines, no numbering, no quotes, each under 80 characters."),
            PromptMessage(role: "user", content: "Recent conversation:\n\(recent)\n\n3 suggestions:"),
        ]

        let stream = OpenAICompatibleProvider().stream(messages: messages, config: config)
        currentSuggestTask?.cancel()
        currentSuggestTask = Task {
            var text = ""
            do {
                for try await delta in stream {
                    text += delta
                }
            } catch {
                return
            }
            let lines = text
                .replacingOccurrences(of: #"^\s*\d+[.)]\s*"#, with: "", options: .regularExpression)
                .split(whereSeparator: \.isNewline)
                .map { $0.trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "\"-")) }
                .filter { !$0.isEmpty }
            guard !Task.isCancelled, lines.count >= 1 else { return }
            DatabaseStore.shared.updateChat(characterId: characterId, chatId: chatId) { c in
                c.suggestMessages = Array(lines.prefix(3))
            }
        }
    }

    /// Config for auxiliary (non-chat) calls: sub-model if set, else the main model.
    private func auxConfig(maxTokens: Int) throws -> GenerationConfig {
        var config = try LLMProviderFactory.makeConfig(db: DatabaseStore.shared)
        let sub = DatabaseStore.shared.settings.subModel
        if !sub.isEmpty {
            config.model = sub
        }
        config.maxTokens = maxTokens
        config.temperature = 0.7
        return config
    }

    // MARK: - Scripts & parsing

    /// Applies enabled regex scripts for the given placement.
    func applyScripts(_ text: String, character: CharacterCard?, placement: ScriptPlacement) -> String {
        var result = text
        let scripts = (character?.customScripts ?? []) + DatabaseStore.shared.settings.globalScripts
        for script in scripts where script.enabled && script.placement == placement {
            guard !script.findRegex.isEmpty else { continue }
            guard let regex = try? NSRegularExpression(pattern: script.findRegex, options: [.dotMatchesLineSeparators]) else { continue }
            let range = NSRange(result.startIndex..., in: result)
            result = regex.stringByReplacingMatches(
                in: result, options: [], range: range,
                withTemplate: script.replaceWith
            )
        }
        return result
    }

    /// Extracts quoted speech for TTS ("...", “...” or 「...」).
    private func extractSaying(_ text: String) -> String? {
        if let match = text.firstMatch(of: /"([^"]+)"/) {
            return String(match.1)
        }
        if let match = text.firstMatch(of: /\u{201C}([^\u{201D}]+)\u{201D}/) {
            return String(match.1)
        }
        if let match = text.firstMatch(of: /「([^」]+)」/) {
            return String(match.1)
        }
        return nil
    }
}
