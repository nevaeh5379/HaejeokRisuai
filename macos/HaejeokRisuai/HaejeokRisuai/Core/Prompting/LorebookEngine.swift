import Foundation

/// Lorebook activation scanning, mirroring the web version's lorebook logic:
/// keyword matching against recent chat history with depth limits, budgets,
/// constant entries and selective secondary keys.
enum LorebookEngine {
    struct ActivatedEntry {
        var entry: LoreBookEntry
    }

    /// Activates entries from the given collections against the chat history.
    static func activate(
        characterLore: [LoreBookEntry],
        chatLore: [LoreBookEntry],
        globalBooks: [LoreBookPage],
        history: [ChatMessage],
        settings: AppSettings
    ) -> [LoreBookEntry] {
        let allEntries: [LoreBookEntry] = characterLore + chatLore
            + globalBooks.flatMap { $0.entries.filter(\.enabled) }

        guard !allEntries.isEmpty else { return [] }

        // Combined text of the last N messages (scan depth).
        let scanDepth = max(1, settings.loreBookDepth)
        let recent = history.suffix(scanDepth)
        let scanText = recent.map { $0.data }.joined(separator: "\n")

        var activated: [LoreBookEntry] = []
        var usedTokens = 0
        let budget = settings.loreBookToken * 3 // heuristic budget in estimated tokens

        for entry in allEntries.sorted(by: { $0.insertOrder < $1.insertOrder }) {
            if usedTokens >= budget { break }

            if entry.mode == .constant || entry.alwaysActive {
                activated.append(entry)
                usedTokens += TokenEstimator.estimate(entry.content)
                continue
            }
            if entry.mode == .folder { continue }
            if !entry.enabled && (characterLore.contains(where: { $0.id == entry.id }) || chatLore.contains(where: { $0.id == entry.id })) {
                continue
            }

            // Random activation percent gate.
            if let percent = entry.activationPercent, percent > 0, percent < 100 {
                let roll = Int.random(in: 0..<100)
                if roll >= percent { continue }
            }

            let keys = entry.key
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            guard !keys.isEmpty else { continue }

            let primaryMatched = keys.contains { key in matches(key: key, text: scanText, entry: entry) }

            var isMatch = primaryMatched
            if isMatch && entry.selective && !entry.secondKeys.isEmpty {
                let secondMatched = entry.secondKeys.contains { key in matches(key: key, text: scanText, entry: entry) }
                isMatch = secondMatched
            }

            if isMatch {
                activated.append(entry)
                usedTokens += TokenEstimator.estimate(entry.content)
            }
        }

        return activated
    }

    private static func matches(key: String, text: String, entry: LoreBookEntry) -> Bool {
        if entry.useRegex {
            let options: NSRegularExpression.Options = entry.caseSensitive ? [] : [.caseInsensitive]
            guard let regex = try? NSRegularExpression(pattern: key, options: options) else { return false }
            let range = NSRange(text.startIndex..., in: text)
            return regex.firstMatch(in: text, options: [], range: range) != nil
        }
        if entry.caseSensitive {
            return text.contains(key)
        }
        return text.range(of: key, options: .caseInsensitive) != nil
    }

    /// Formats activated lore entries into a single prompt block.
    static func formatBlock(_ entries: [LoreBookEntry]) -> String {
        guard !entries.isEmpty else { return "" }
        return "World Info:\n"
            + entries
            .sorted(by: { $0.insertOrder < $1.insertOrder })
            .map { "- \($0.content)" }
            .joined(separator: "\n")
    }
}
