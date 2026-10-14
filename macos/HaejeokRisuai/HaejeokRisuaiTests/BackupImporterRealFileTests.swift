import Foundation
import Testing
@testable import HaejeokRisuai

/// End-to-end test against a real RisuAI `.bin` backup file.
@MainActor
struct BackupImporterRealFileTests {

    /// Path to a real backup produced by the web/Tauri version.
    /// Adjust if the file moves; the test skips gracefully when absent.
    private static let backupPath = "/Users/jihoon/Downloads/Binary-2026-08-22-1.bin"

    @Test(.disabled(if: !FileManager.default.fileExists(atPath: backupPath),
                    "Backup file not present at \(backupPath)"))
    func importsRealBinBackup() throws {
        let fileURL = URL(fileURLWithPath: Self.backupPath)
        let data = try Data(contentsOf: fileURL)

        let result = try BackupImporter.importBackup(data)

        // The backup should contain a database with at least one character.
        #expect(result.characterCount > 0)
        #expect(result.assetCount > 0)

        // The JsDatabase must expose characters.
        guard case .array(let chars) = result.database.characters ?? .array([]) else {
            Issue.record("characters missing from imported database")
            return
        }
        #expect(!chars.isEmpty)

        // Each character should have a name and chaId.
        for char in chars.prefix(5) {
            if case .object(let entries) = char {
                let name = entries.first(where: { $0.0 == "name" }).flatMap { JsDatabaseBridge.stringValue($0.1) }
                let chaId = entries.first(where: { $0.0 == "chaId" }).flatMap { JsDatabaseBridge.stringValue($0.1) }
                #expect(name != nil && !(name?.isEmpty ?? true))
                #expect(chaId != nil)
            }
        }

        // Round-trip the imported database into SQLite and back.
        let dbURL = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("risu-bin-rt-\(UUID().uuidString).sqlite3")
        defer { try? FileManager.default.removeItem(at: dbURL) }

        let sqlite = try RisuSqlite(path: dbURL.path)
        // Create schema by reusing the shared storage's SQL (read from the schema constant).
        // We use a minimal schema here sufficient for characters + extension nodes.
        try sqlite.exec("""
            CREATE TABLE IF NOT EXISTS system_storage_meta (
                singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
                schema_version INTEGER NOT NULL DEFAULT 3,
                schema_layout TEXT NOT NULL DEFAULT 'relational-schema-v3',
                revision INTEGER NOT NULL DEFAULT 0,
                initialized INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            INSERT OR IGNORE INTO system_storage_meta (singleton, schema_version, schema_layout) VALUES (1, 3, 'relational-schema-v3');
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY, domain TEXT NOT NULL,
                value_type TEXT NOT NULL, text_value TEXT, encoded_text_value TEXT,
                number_value REAL, boolean_value INTEGER, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                CHECK (text_value IS NULL OR encoded_text_value IS NULL)
            );
            CREATE TABLE IF NOT EXISTS setting_extension_nodes (
                setting_key TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
                node_order INTEGER NOT NULL, object_key TEXT, object_key_encoded TEXT,
                value_type TEXT NOT NULL, text_value TEXT, encoded_text_value TEXT,
                number_value REAL, boolean_value INTEGER, PRIMARY KEY (setting_key, node_id)
            );
            CREATE TABLE IF NOT EXISTS characters (
                id TEXT PRIMARY KEY, position INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'character',
                name TEXT NOT NULL DEFAULT '', image TEXT, trash_time INTEGER, creation_time INTEGER,
                modification_time INTEGER, last_interaction_time INTEGER, details_loaded INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS character_extension_nodes (
                character_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
                node_order INTEGER NOT NULL, object_key TEXT, object_key_encoded TEXT,
                value_type TEXT NOT NULL, text_value TEXT, encoded_text_value TEXT,
                number_value REAL, boolean_value INTEGER, PRIMARY KEY (character_id, node_id)
            );
            CREATE TABLE IF NOT EXISTS character_tags (
                character_id TEXT NOT NULL, position INTEGER NOT NULL, tag TEXT NOT NULL,
                PRIMARY KEY (character_id, position)
            );
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY, character_id TEXT NOT NULL, position INTEGER NOT NULL,
                name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', folder_id TEXT,
                last_message_time INTEGER, messages_loaded INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS chat_extension_nodes (
                chat_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER,
                node_order INTEGER NOT NULL, object_key TEXT, object_key_encoded TEXT,
                value_type TEXT NOT NULL, text_value TEXT, encoded_text_value TEXT,
                number_value REAL, boolean_value INTEGER, PRIMARY KEY (chat_id, node_id)
            );
            CREATE TABLE IF NOT EXISTS messages (
                chat_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, role TEXT NOT NULL,
                content_text TEXT, content_encoded TEXT, sender_name TEXT, sent_time INTEGER,
                generation_model TEXT, input_tokens INTEGER, output_tokens INTEGER,
                PRIMARY KEY (chat_id, id)
            );
            CREATE TABLE IF NOT EXISTS message_extension_nodes (
                chat_id TEXT NOT NULL, message_id TEXT NOT NULL, node_id INTEGER NOT NULL,
                parent_node_id INTEGER, node_order INTEGER NOT NULL, object_key TEXT, object_key_encoded TEXT,
                value_type TEXT NOT NULL, text_value TEXT, encoded_text_value TEXT,
                number_value REAL, boolean_value INTEGER, PRIMARY KEY (chat_id, message_id, node_id)
            );
            CREATE TABLE IF NOT EXISTS plugin_custom_storage (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
        """)

        let storage = TestStorage(sqlite: sqlite)
        try storage.replaceDatabase(result.database)

        // Read back and verify character count matches.
        let loaded = try storage.loadDatabase()
        guard case .array(let readChars) = loaded.database.characters ?? .array([]) else {
            Issue.record("no characters after SQL round-trip")
            return
        }
        #expect(readChars.count == result.characterCount)
    }
}