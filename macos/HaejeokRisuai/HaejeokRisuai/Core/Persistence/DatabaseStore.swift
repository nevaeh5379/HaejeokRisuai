import Combine
import Foundation
import os

/// Central application state and persistence.
///
/// Mirrors the web version's `Database` + `characterStore`/`settingsStore` combination:
/// all characters, chats, personas, lorebooks and settings live here and are persisted
/// as JSON in Application Support with debounced autosave.
@MainActor
final class DatabaseStore: ObservableObject {
    static let shared = DatabaseStore()

    @Published var settings: AppSettings {
        didSet { scheduleSave() }
    }
    @Published var characters: [CharacterCard] {
        didSet { scheduleSave() }
    }
    @Published var selectedCharId: UUID? {
        didSet { UserDefaults.standard.set(selectedCharId?.uuidString, forKey: "selectedCharId") }
    }

    private var saveTask: Task<Void, Never>?
    private let fileManager = FileManager.default
    /// Unknown root setting keys preserved across loads so round-trips through
    /// the web version don't drop fields the native app doesn't model yet.
    private var preservedRootKeys: [(String, JsValue)] = []

    var dataDirectory: URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("HaejeokRisuai", isDirectory: true)
    }

    /// Legacy JSON database file (pre-SQLite). Used only for one-time migration.
    private var legacyJSONURL: URL { dataDirectory.appendingPathComponent("database.json") }

    // MARK: - Init / Load

    init() {
        settings = AppSettings()
        characters = []
        load()
        if let saved = UserDefaults.standard.string(forKey: "selectedCharId") {
            selectedCharId = UUID(uuidString: saved) ?? nil
        }
    }

    func load() {
        do {
            try fileManager.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            try RisuSqliteStorage.shared.open()
            let result = try RisuSqliteStorage.shared.loadDatabase()

            if result.isEmpty && fileManager.fileExists(atPath: legacyJSONURL.path) {
                // One-time migration from the old JSON backend into SQLite.
                migrateFromLegacyJSON()
                return
            }

            let loaded = JsDatabaseBridge.load(from: result.database)
            // Preserve root keys the bridge didn't consume.
            let knownKeys = Set(loaded.settings.allKnownSettingKeys())
            preservedRootKeys = result.database.rootEntries().filter { !knownKeys.contains($0.0) }

            settings = loaded.settings
            characters = loaded.characters
            AppLog.persistence.info("Loaded \(self.characters.count) characters from SQLite (revision \(RisuSqliteStorage.shared.revision))")
        } catch {
            AppLog.persistence.error("Failed to load SQLite database: \(error.localizedDescription)")
        }
    }

    private func migrateFromLegacyJSON() {
        do {
            let data = try Data(contentsOf: legacyJSONURL)
            struct PersistedDB: Codable {
                var settings: AppSettings
                var characters: [CharacterCard]
            }
            let db = try JSONDecoder().decode(PersistedDB.self, from: data)
            self.settings = db.settings
            self.characters = db.characters
            AppLog.persistence.info("Migrating \(self.characters.count) characters from legacy JSON to SQLite...")
            self.persistToSQLite()
            // Rename the old file so we don't migrate twice.
            let archived = legacyJSONURL.appendingPathExtension("migrated")
            try? fileManager.moveItem(at: legacyJSONURL, to: archived)
        } catch {
            AppLog.persistence.error("Legacy JSON migration failed: \(error.localizedDescription)")
        }
    }

    func saveNow() {
        saveTask?.cancel()
        persistToSQLite()
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            self?.persistToSQLite()
        }
    }

    private func persistToSQLite() {
        let jsDB = JsDatabaseBridge.save(settings: self.settings, characters: self.characters, preserve: preservedRootKeys)
        do {
            try RisuSqliteStorage.shared.replaceDatabase(jsDB)
        } catch {
            AppLog.persistence.error("Failed to save SQLite database: \(error.localizedDescription)")
        }
    }

    // MARK: - Character access

    var selectedCharacter: CharacterCard? {
        get {
            guard let id = selectedCharId else { return nil }
            return characters.first(where: { $0.id == id })
        }
    }

    func character(id: UUID) -> CharacterCard? {
        characters.first(where: { $0.id == id })
    }

    func updateCharacter(_ id: UUID, _ mutate: (inout CharacterCard) -> Void) {
        guard let idx = characters.firstIndex(where: { $0.id == id }) else { return }
        mutate(&characters[idx])
        characters[idx].modificationDate = Date().timeIntervalSince1970 * 1000
        characters[idx].lastInteraction = Date().timeIntervalSince1970 * 1000
    }

    func addCharacter(_ character: CharacterCard) {
        characters.append(character)
        settings.statisticsImports += 1
    }

    func deleteCharacter(_ id: UUID) {
        if let char = character(id: id), let assetId = char.imageAssetId {
            AssetStore.shared.deleteAsset(assetId)
        }
        characters.removeAll(where: { $0.id == id })
        if selectedCharId == id {
            selectedCharId = characters.first?.id
        }
    }

    /// Soft-delete into trash.
    func trashCharacter(_ id: UUID) {
        updateCharacter(id) { char in
            char.trashTime = Date().timeIntervalSince1970 * 1000
        }
    }

    func restoreCharacter(_ id: UUID) {
        updateCharacter(id) { char in
            char.trashTime = nil
        }
    }

    var activeCharacters: [CharacterCard] {
        characters.filter { $0.trashTime == nil }
    }

    var trashedCharacters: [CharacterCard] {
        characters.filter { $0.trashTime != nil }
    }

    // MARK: - Chat access

    func currentChat(characterId: UUID) -> ChatSession? {
        guard let char = character(id: characterId), !char.chats.isEmpty else { return nil }
        let page = max(0, min(char.chatPage, char.chats.count - 1))
        return char.chats[page]
    }

    func updateChat(characterId: UUID, chatId: UUID, _ mutate: (inout ChatSession) -> Void) {
        updateCharacter(characterId) { char in
            guard let idx = char.chats.firstIndex(where: { $0.id == chatId }) else { return }
            mutate(&char.chats[idx])
            char.chats[idx].lastDate = Date().timeIntervalSince1970 * 1000
        }
    }

    func newChat(characterId: UUID) {
        updateCharacter(characterId) { char in
            char.ensureChatExists()
            let fmIndex = char.chats.last?.fmIndex ?? -1
            let firstMsg = char.firstMessageText(fmIndex: fmIndex) ?? ""
            var messages: [ChatMessage] = []
            if !firstMsg.isEmpty {
                messages.append(ChatMessage(role: .char, data: firstMsg))
            }
            let chat = ChatSession(name: "Chat \(char.chats.count + 1)", messages: messages, fmIndex: fmIndex)
            char.chats.append(chat)
            char.chatPage = char.chats.count - 1
        }
    }

    func duplicateChat(characterId: UUID, chatId: UUID) {
        updateCharacter(characterId) { char in
            guard let chat = char.chats.first(where: { $0.id == chatId }) else { return }
            var copy = chat
            copy.id = UUID()
            copy.name = chat.name + " (copy)"
            copy.messages = chat.messages.map { m in
                var m = m
                m.id = UUID()
                return m
            }
            if let idx = char.chats.firstIndex(where: { $0.id == chatId }) {
                char.chats.insert(copy, at: idx + 1)
                char.chatPage = idx + 1
            }
        }
    }

    func deleteChat(characterId: UUID, chatId: UUID) {
        updateCharacter(characterId) { char in
            char.chats.removeAll(where: { $0.id == chatId })
            if char.chatPage >= char.chats.count {
                char.chatPage = max(0, char.chats.count - 1)
            }
        }
    }

    // MARK: - Persona

    func activePersona() -> PersonaPreset? {
        if let id = settings.selectedPersonaId,
           let persona = settings.personas.first(where: { $0.id == id }) {
            return persona
        }
        return nil
    }

    func personaPrompt() -> String {
        activePersona()?.personaPrompt ?? settings.personaPrompt
    }

    func username() -> String {
        activePersona()?.name.isEmpty == false ? activePersona()!.name : settings.username
    }

    // MARK: - Backup / Restore

    struct BackupPayload: Codable {
        var version: Int
        var savedAt: Double
        var settings: AppSettings
        var characters: [CharacterCard]
    }

    func exportBackupData() throws -> Data {
        let payload = BackupPayload(
            version: 1,
            savedAt: Date().timeIntervalSince1970 * 1000,
            settings: settings,
            characters: characters
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        return try encoder.encode(payload)
    }

    func importBackupData(_ data: Data, mergeCharacters: Bool) throws {
        let decoder = JSONDecoder()
        let payload = try decoder.decode(BackupPayload.self, from: data)
        if mergeCharacters {
            for var ch in payload.characters {
                if characters.contains(where: { $0.id == ch.id }) {
                    ch.id = UUID()
                }
                characters.append(ch)
            }
        } else {
            settings = payload.settings
            characters = payload.characters
        }
        saveNow()
    }
}

// MARK: - Logging

enum AppLog {
    static let persistence = Logger(subsystem: "io.github.nevaeh5379.HaejeokRisuai", category: "persistence")
    static let network = Logger(subsystem: "io.github.nevaeh5379.HaejeokRisuai", category: "network")
    static let cards = Logger(subsystem: "io.github.nevaeh5379.HaejeokRisuai", category: "cards")
    static let generation = Logger(subsystem: "io.github.nevaeh5379.HaejeokRisuai", category: "generation")
}
