import Foundation
import os

/// The on-disk relational store, 100% compatible with RisuAI's
/// `risuai-local.sqlite3` (relational-schema-v3).
///
/// Reads and writes the exact same schema, table names, column names and
/// `relationalNodeCodec` serialization as the web/Tauri version, so a database
/// file produced by either app is usable by the other.
@MainActor
final class RisuSqliteStorage {
    static let shared = RisuSqliteStorage()

    private var db: RisuSqlite?
    var revision: Int = 0

    var dataDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
            .appendingPathComponent("HaejeokRisuai", isDirectory: true)
    }

    var databaseURL: URL { dataDirectory.appendingPathComponent("risuai-local.sqlite3") }

    private let log = Logger(subsystem: "io.github.nevaeh5379.HaejeokRisuai", category: "storage")

    // MARK: - Open / schema

    func open() throws {
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let url = databaseURL
        db = try RisuSqlite(path: url.path)
        try createSchema()
        revision = try loadRevision()
        log.info("Opened Risu database at \(url.path) (revision \(self.revision))")
    }

    /// Ensures the schema exists. Idempotent (all statements are IF NOT EXISTS).
    func createSchema() throws {
        guard let db else { return }
        // The CREATE statements mirror src/ts/storage/sqlite-schema.sql verbatim.
        try db.exec("""
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS system_storage_meta (
            singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
            schema_version INTEGER NOT NULL DEFAULT 3,
            schema_layout TEXT NOT NULL DEFAULT 'relational-schema-v3',
            revision INTEGER NOT NULL DEFAULT 0,
            initialized INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO system_storage_meta (singleton, schema_version, schema_layout)
        VALUES (1, 3, 'relational-schema-v3');

        CREATE TABLE IF NOT EXISTS bot_presets (
            preset_id TEXT PRIMARY KEY,
            position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
            name TEXT NOT NULL DEFAULT '', image TEXT NOT NULL DEFAULT '',
            api_type TEXT NOT NULL DEFAULT '', ai_model TEXT NOT NULL DEFAULT '',
            data TEXT NOT NULL, content_hash TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS bot_presets_position_idx ON bot_presets (position);
        CREATE INDEX IF NOT EXISTS bot_presets_model_idx ON bot_presets (api_type, ai_model);

        CREATE TABLE IF NOT EXISTS system_revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            storage_revision INTEGER, database_initialized INTEGER,
            scope TEXT NOT NULL CHECK (scope IN ('database', 'cold-storage', 'restore')),
            action TEXT NOT NULL,
            restored_from_revision INTEGER REFERENCES system_revisions(id),
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS revisions_created_idx ON system_revisions (created_at DESC, id DESC);

        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            domain TEXT NOT NULL,
            value_type TEXT NOT NULL CHECK (value_type IN ('null','undefined','boolean','number','string','array','object')),
            text_value TEXT, encoded_text_value TEXT, number_value REAL,
            boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            CHECK (text_value IS NULL OR encoded_text_value IS NULL)
        );

        CREATE TABLE IF NOT EXISTS setting_extension_nodes (
            setting_key TEXT NOT NULL REFERENCES system_settings(key) ON DELETE CASCADE,
            node_id INTEGER NOT NULL, parent_node_id INTEGER, node_order INTEGER NOT NULL CHECK (node_order >= 0),
            object_key TEXT, object_key_encoded TEXT,
            value_type TEXT NOT NULL CHECK (value_type IN ('null','undefined','boolean','number','string','array','object')),
            text_value TEXT, encoded_text_value TEXT, number_value REAL,
            boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
            PRIMARY KEY (setting_key, node_id),
            FOREIGN KEY (setting_key, parent_node_id) REFERENCES setting_extension_nodes(setting_key, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
            CHECK (text_value IS NULL OR encoded_text_value IS NULL),
            CHECK (object_key IS NULL OR object_key_encoded IS NULL)
        );
        CREATE INDEX IF NOT EXISTS setting_nodes_parent_idx ON setting_extension_nodes (setting_key, parent_node_id, node_order);

        CREATE TABLE IF NOT EXISTS characters (
            id TEXT PRIMARY KEY, position INTEGER NOT NULL CHECK (position >= 0),
            kind TEXT NOT NULL DEFAULT 'character' CHECK (kind IN ('character', 'group')),
            name TEXT NOT NULL DEFAULT '', image TEXT, trash_time INTEGER, creation_time INTEGER,
            modification_time INTEGER, last_interaction_time INTEGER,
            details_loaded INTEGER NOT NULL DEFAULT 0 CHECK (details_loaded IN (0, 1)),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS characters_position_idx ON characters (position);
        CREATE INDEX IF NOT EXISTS characters_kind_position_idx ON characters (kind, position);

        CREATE TABLE IF NOT EXISTS character_extension_nodes (
            character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
            node_id INTEGER NOT NULL, parent_node_id INTEGER, node_order INTEGER NOT NULL CHECK (node_order >= 0),
            object_key TEXT, object_key_encoded TEXT,
            value_type TEXT NOT NULL CHECK (value_type IN ('null','undefined','boolean','number','string','array','object')),
            text_value TEXT, encoded_text_value TEXT, number_value REAL,
            boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
            PRIMARY KEY (character_id, node_id),
            FOREIGN KEY (character_id, parent_node_id) REFERENCES character_extension_nodes(character_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
            CHECK (text_value IS NULL OR encoded_text_value IS NULL),
            CHECK (object_key IS NULL OR object_key_encoded IS NULL)
        );
        CREATE INDEX IF NOT EXISTS character_nodes_parent_idx ON character_extension_nodes (character_id, parent_node_id, node_order);

        CREATE TABLE IF NOT EXISTS character_tags (
            character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position >= 0), tag TEXT NOT NULL,
            PRIMARY KEY (character_id, position)
        );
        CREATE INDEX IF NOT EXISTS character_tags_search_idx ON character_tags (tag, character_id);

        CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
            position INTEGER NOT NULL CHECK (position >= 0), name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
            folder_id TEXT, last_message_time INTEGER,
            messages_loaded INTEGER NOT NULL DEFAULT 0 CHECK (messages_loaded IN (0, 1)),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS chats_character_position_idx ON chats (character_id, position);
        CREATE INDEX IF NOT EXISTS chats_folder_idx ON chats (character_id, folder_id) WHERE folder_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS chat_extension_nodes (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            node_id INTEGER NOT NULL, parent_node_id INTEGER, node_order INTEGER NOT NULL CHECK (node_order >= 0),
            object_key TEXT, object_key_encoded TEXT,
            value_type TEXT NOT NULL CHECK (value_type IN ('null','undefined','boolean','number','string','array','object')),
            text_value TEXT, encoded_text_value TEXT, number_value REAL,
            boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
            PRIMARY KEY (chat_id, node_id),
            FOREIGN KEY (chat_id, parent_node_id) REFERENCES chat_extension_nodes(chat_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
            CHECK (text_value IS NULL OR encoded_text_value IS NULL),
            CHECK (object_key IS NULL OR object_key_encoded IS NULL)
        );
        CREATE INDEX IF NOT EXISTS chat_nodes_parent_idx ON chat_extension_nodes (chat_id, parent_node_id, node_order);

        CREATE TABLE IF NOT EXISTS messages (
            chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 0), role TEXT NOT NULL,
            content_text TEXT, content_encoded TEXT, sender_name TEXT, sent_time INTEGER,
            generation_model TEXT, input_tokens INTEGER, output_tokens INTEGER,
            PRIMARY KEY (chat_id, id), CHECK (content_text IS NULL OR content_encoded IS NULL)
        );
        CREATE INDEX IF NOT EXISTS messages_chat_position_idx ON messages (chat_id, position);
        CREATE INDEX IF NOT EXISTS messages_content_idx ON messages (content_text);
        CREATE INDEX IF NOT EXISTS messages_model_idx ON messages (generation_model);

        CREATE TABLE IF NOT EXISTS message_extension_nodes (
            chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
            node_id INTEGER NOT NULL, parent_node_id INTEGER, node_order INTEGER NOT NULL CHECK (node_order >= 0),
            object_key TEXT, object_key_encoded TEXT,
            value_type TEXT NOT NULL CHECK (value_type IN ('null','undefined','boolean','number','string','array','object')),
            text_value TEXT, encoded_text_value TEXT, number_value REAL,
            boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
            PRIMARY KEY (chat_id, message_id, node_id),
            FOREIGN KEY (chat_id, message_id) REFERENCES messages(chat_id, id) ON DELETE CASCADE,
            FOREIGN KEY (chat_id, message_id, parent_node_id) REFERENCES message_extension_nodes(chat_id, message_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
            CHECK (text_value IS NULL OR encoded_text_value IS NULL),
            CHECK (object_key IS NULL OR object_key_encoded IS NULL)
        );
        CREATE INDEX IF NOT EXISTS message_nodes_parent_idx ON message_extension_nodes (chat_id, message_id, parent_node_id, node_order);

        CREATE TABLE IF NOT EXISTS cold_archives (
            archive_id TEXT PRIMARY KEY,
            archive_kind TEXT NOT NULL CHECK (archive_kind IN ('legacy','character','chat','unknown')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS cold_extension_nodes (
            archive_id TEXT NOT NULL REFERENCES cold_archives(archive_id) ON DELETE CASCADE,
            node_id INTEGER NOT NULL, parent_node_id INTEGER, node_order INTEGER NOT NULL CHECK (node_order >= 0),
            object_key TEXT, object_key_encoded TEXT,
            value_type TEXT NOT NULL CHECK (value_type IN ('null','undefined','boolean','number','string','array','object')),
            text_value TEXT, encoded_text_value TEXT, number_value REAL,
            boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
            PRIMARY KEY (archive_id, node_id),
            FOREIGN KEY (archive_id, parent_node_id) REFERENCES cold_extension_nodes(archive_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
            CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
            CHECK (text_value IS NULL OR encoded_text_value IS NULL),
            CHECK (object_key IS NULL OR object_key_encoded IS NULL)
        );
        CREATE INDEX IF NOT EXISTS cold_nodes_parent_idx ON cold_extension_nodes (archive_id, parent_node_id, node_order);

        CREATE TABLE IF NOT EXISTS plugin_custom_storage (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL CHECK (json_valid(value)),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        """)
    }

    // MARK: - Revision

    func loadRevision() throws -> Int {
        guard let db else { return 0 }
        let value = try db.scalar("SELECT revision FROM system_storage_meta WHERE singleton = 1")
        return value.int ?? 0
    }

    // MARK: - Node value load

    /// Loads a flattened value tree from an extension-nodes table, rebuilding it.
    func loadNodeValue(table: String, ownerWhere: String, bind: [SqliteValue]) throws -> JsValue? {
        guard let db else { return nil }
        let sql = """
        SELECT node_id, parent_node_id, node_order, object_key, object_key_encoded,
               value_type, text_value, encoded_text_value, number_value, boolean_value
        FROM \(table) WHERE \(ownerWhere) ORDER BY node_id
        """
        let rows = try db.query(sql, bind) { reader in
            RelationalNodeCodec.NodeRow(
                nodeId: reader.int(0) ?? 0,
                parentNodeId: reader.int(1),
                nodeOrder: reader.int(2) ?? 0,
                objectKey: reader.string(3),
                objectKeyEncoded: reader.string(4),
                valueType: RelationalNodeCodec.NodeType(rawValue: reader.string(5) ?? "null") ?? .null,
                textValue: reader.string(6),
                encodedTextValue: reader.string(7),
                numberValue: reader.double(8),
                booleanValue: reader.int(9)
            )
        }
        guard !rows.isEmpty else { return nil }
        // Note: boolean column is index 9, not 8. Fixed below.
        return try RelationalNodeCodec.rebuild(rows)
    }

    // MARK: - Node value write

    /// Replaces all rows for the given owner with a freshly flattened value.
    func replaceNodes(table: String, ownerColumns: [String], ownerValues: [SqliteValue], value: JsValue) throws {
        guard let db else { return }
        let whereClause = ownerColumns.map { "\($0) = ?" }.joined(separator: " AND ")
        try db.execute("DELETE FROM \(table) WHERE \(whereClause)", ownerValues)

        let columns = ownerColumns + RelationalNodeCodec.columns
        let placeholders = columns.map { _ in "?" }.joined(separator: ", ")
        let sql = "INSERT INTO \(table) (\(columns.joined(separator: ", "))) VALUES (\(placeholders))"
        for row in RelationalNodeCodec.flatten(value) {
            try db.execute(sql, ownerValues + row.nodeBind)
        }
    }

    // MARK: - Full load

    struct LoadResult {
        var database: JsDatabase
        var isEmpty: Bool
    }

    /// Loads the entire database into a JS-style dictionary tree.
    func loadDatabase() throws -> LoadResult {
        guard let db else { throw NSError(domain: "storage", code: 1) }

        // Settings: each key -> rebuilt extension value.
        var database = JsDatabase()
        let settingsRows = try db.query("SELECT key FROM system_settings") { $0.string(0) ?? "" }
        for key in settingsRows {
            if let value = try loadNodeValue(table: "setting_extension_nodes", ownerWhere: "setting_key = ?", bind: [.text(key)]) {
                database.set(key, value)
            }
        }

        // plugin_custom_storage (JSON blob table).
        if database.pluginCustomStorage == nil {
            let pluginRows = try db.query("SELECT key, value FROM plugin_custom_storage") { reader in
                (reader.string(0) ?? "", reader.string(1) ?? "")
            }
            if !pluginRows.isEmpty {
                var storage: [(String, JsValue)] = []
                for (k, v) in pluginRows {
                    if let data = v.data(using: .utf8),
                       let obj = try? JSONSerialization.jsonObject(with: data) {
                        storage.append((k, JsValue(obj)))
                    } else {
                        storage.append((k, .string(v)))
                    }
                }
                database.set("pluginCustomStorage", .object(storage))
            }
        }
        if database.pluginCustomStorage == nil {
            database.set("pluginCustomStorage", .object([]))
        }

        // Characters (full load: extension nodes + chats).
        let charRows = try db.query("""
            SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded
            FROM characters ORDER BY position
        """) { reader in
            CharMetaRow(
                id: reader.string(0) ?? "",
                position: reader.int(1) ?? 0,
                kind: reader.string(2) ?? "character",
                name: reader.string(3) ?? "",
                image: reader.string(4),
                trashTime: reader.int(5),
                creationTime: reader.int(6),
                modificationTime: reader.int(7),
                lastInteractionTime: reader.int(8),
                detailsLoaded: (reader.int(9) ?? 0) == 1
            )
        }

        var characters: [JsValue] = []
        for row in charRows {
            var charValue = (try loadNodeValue(table: "character_extension_nodes", ownerWhere: "character_id = ?", bind: [.text(row.id)])) ?? JsValue.object([])
            // Stamp core columns back onto the object.
            charValue.setKey("chaId", .string(row.id))
            charValue.setKey("type", .string(row.kind))
            charValue.setKey("name", .string(row.name))
            if let image = row.image { charValue.setKey("image", .string(image)) }
            charValue.setKey("detailsLoaded", .bool(row.detailsLoaded))
            charValue.setKey("trashTime", row.trashTime.map { .number(Double($0)) } ?? .null)
            charValue.setKey("creationDate", row.creationTime.map { .number(Double($0)) } ?? .null)
            charValue.setKey("modificationDate", row.modificationTime.map { .number(Double($0)) } ?? .null)
            charValue.setKey("lastInteraction", row.lastInteractionTime.map { .number(Double($0)) } ?? .null)

            // Chats for this character.
            let chatRows = try db.query("""
                SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position
            """, [.text(row.id)]) { reader in
                ChatMetaRow(
                    id: reader.string(0) ?? "",
                    name: reader.string(1) ?? "",
                    note: reader.string(2) ?? "",
                    folderId: reader.string(3),
                    lastMessageTime: reader.int(4)
                )
            }
            var chats: [JsValue] = []
            for chatRow in chatRows {
                var chatValue = (try loadNodeValue(table: "chat_extension_nodes", ownerWhere: "chat_id = ?", bind: [.text(chatRow.id)])) ?? JsValue.object([])
                chatValue.setKey("id", .string(chatRow.id))
                chatValue.setKey("name", .string(chatRow.name))
                chatValue.setKey("note", .string(chatRow.note))
                chatValue.setKey("folderId", chatRow.folderId.map { .string($0) } ?? .null)
                chatValue.setKey("lastDate", chatRow.lastMessageTime.map { .number(Double($0)) } ?? .null)

                // Messages.
                let msgRows = try db.query("SELECT id FROM messages WHERE chat_id = ? ORDER BY position", [.text(chatRow.id)]) { $0.string(0) ?? "" }
                var messages: [JsValue] = []
                for msgId in msgRows {
                    if let msgValue = try loadNodeValue(table: "message_extension_nodes", ownerWhere: "chat_id = ? AND message_id = ?", bind: [.text(chatRow.id), .text(msgId)]) {
                        var msg = msgValue
                        msg.setKey("chatId", .string(msgId)) // message id is stored under chatId per web schema
                        messages.append(msg)
                    }
                }
                chatValue.setKey("message", .array(messages))
                chatValue.setKey("messagesLoaded", .bool(true))
                chatValue.setKey("messagesFullyLoaded", .bool(true))
                chatValue.setKey("detailsLoaded", .bool(true))
                chats.append(chatValue)
            }
            charValue.setKey("chats", .array(chats))
            charValue.setKey("chatPage", .number(0))
            characters.append(charValue)
        }
        database.set("characters", .array(characters))

        let initialized = (try db.scalar("SELECT initialized FROM system_storage_meta WHERE singleton = 1").int ?? 0) == 1
        let isEmpty = !initialized && characters.isEmpty && settingsRows.isEmpty
        return LoadResult(database: database, isEmpty: isEmpty)
    }

    private struct CharMetaRow {
        var id: String; var position: Int; var kind: String; var name: String
        var image: String?; var trashTime: Int?; var creationTime: Int?
        var modificationTime: Int?; var lastInteractionTime: Int?; var detailsLoaded: Bool
    }
    private struct ChatMetaRow {
        var id: String; var name: String; var note: String
        var folderId: String?; var lastMessageTime: Int?
    }

    // MARK: - Full replace (import / reset)

    /// Replaces the entire database with the given JS-style database tree.
    /// Mirrors `buildSqlReplaceCommit` + `applySqliteCommit` with replaceAll.
    func replaceDatabase(_ database: JsDatabase) throws {
        guard let db else { return }
        try db.transaction {
            try db.execute("DELETE FROM plugin_custom_storage")
            try db.execute("DELETE FROM bot_presets")
            try db.execute("DELETE FROM system_settings")
            try db.execute("DELETE FROM characters")

            // Root settings.
            for (key, value) in database.rootEntries() {
                if key == "botPresets" || key == "botPresetsId" || key == "pluginCustomStorage" { continue }
                try upsertSetting(key: key, value: value)
            }

            // Plugin storage.
            if let pluginStorage = database.pluginCustomStorage {
                if case .object(let entries) = pluginStorage {
                    for (k, v) in entries {
                        let json = jsonString(v)
                        try db.execute(
                            "INSERT INTO plugin_custom_storage (key, value, updated_at) VALUES (?, ?, datetime('now'))",
                            [.text(k), .text(json)]
                        )
                    }
                }
            }

            // Bot presets.
            if let presets = database.botPresets, case .array(let presetArr) = presets {
                for (position, preset) in presetArr.enumerated() {
                    guard case .object(let presetEntries) = preset else { continue }
                    var data = presetEntries
                    // Remove id from stored data (mirrors TS behavior).
                    data.removeAll(where: { $0.0 == "id" })
                    let presetId = presetEntries.first(where: { $0.0 == "id" })?.1 ?? .string(UUID().uuidString)
                    let idString = stringValue(presetId) ?? UUID().uuidString
                    let name = stringValue(presetEntries.first(where: { $0.0 == "name" })?.1) ?? ""
                    let image = stringValue(presetEntries.first(where: { $0.0 == "image" })?.1) ?? ""
                    let apiType = stringValue(presetEntries.first(where: { $0.0 == "apiType" })?.1) ?? ""
                    let aiModel = stringValue(presetEntries.first(where: { $0.0 == "aiModel" })?.1) ?? ""
                    let dataJson = jsonString(.object(data))
                    let contentHash = presetContentHash(dataJson)
                    try db.execute("""
                        INSERT INTO bot_presets (preset_id, position, name, image, api_type, ai_model, data, content_hash, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                    """, [.text(idString), .integer(Int64(position)), .text(name), .text(image), .text(apiType), .text(aiModel), .text(dataJson), .text(contentHash)])
                }
            }

            // Characters + chats + messages.
            if let chars = database.characters, case .array(let charArr) = chars {
                for (position, charValue) in charArr.enumerated() {
                    guard case .object(let charEntries) = charValue else { continue }
                    let chaId = stringValue(charEntries.first(where: { $0.0 == "chaId" })?.1) ?? UUID().uuidString
                    let kind = stringValue(charEntries.first(where: { $0.0 == "type" })?.1) == "group" ? "group" : "character"
                    let name = stringValue(charEntries.first(where: { $0.0 == "name" })?.1) ?? ""
                    let image = stringValue(charEntries.first(where: { $0.0 == "image" })?.1)
                    let trashTime = doubleValue(charEntries.first(where: { $0.0 == "trashTime" })?.1).map(Int.init)
                    let creationTime = doubleValue(charEntries.first(where: { $0.0 == "creationDate" })?.1).map(Int.init)
                        ?? doubleValue(charEntries.first(where: { $0.0 == "creation_date" })?.1).map(Int.init)
                    let modificationTime = doubleValue(charEntries.first(where: { $0.0 == "modificationDate" })?.1).map(Int.init)
                        ?? doubleValue(charEntries.first(where: { $0.0 == "modification_date" })?.1).map(Int.init)
                    let lastInteraction = doubleValue(charEntries.first(where: { $0.0 == "lastInteraction" })?.1).map(Int.init)

                    try db.execute("""
                        INSERT INTO characters (id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
                    """, [
                        .text(chaId), .integer(Int64(position)), .text(kind), .text(name),
                        image.map(SqliteValue.text) ?? .null,
                        trashTime.map { .integer(Int64($0)) } ?? .null,
                        creationTime.map { .integer(Int64($0)) } ?? .null,
                        modificationTime.map { .integer(Int64($0)) } ?? .null,
                        lastInteraction.map { .integer(Int64($0)) } ?? .null,
                    ])

                    // Character extension nodes: everything except chats/chaId/detailsLoaded.
                    let charData = charEntries.filter { $0.0 != "chats" && $0.0 != "chaId" && $0.0 != "detailsLoaded" }
                    try replaceNodes(table: "character_extension_nodes", ownerColumns: ["character_id"], ownerValues: [.text(chaId)], value: .object(charData))

                    // Tags.
                    try db.execute("DELETE FROM character_tags WHERE character_id = ?", [.text(chaId)])
                    if let tags = charEntries.first(where: { $0.0 == "tags" })?.1, case .array(let tagArr) = tags {
                        for (tagPosition, tag) in tagArr.enumerated() {
                            if case .string(let s) = tag {
                                try db.execute("INSERT INTO character_tags (character_id, position, tag) VALUES (?, ?, ?)", [.text(chaId), .integer(Int64(tagPosition)), .text(s)])
                            }
                        }
                    }

                    // Chats.
                    if let chatsValue = charEntries.first(where: { $0.0 == "chats" })?.1, case .array(let chatArr) = chatsValue {
                        for (chatPosition, chatValue) in chatArr.enumerated() {
                            guard case .object(let chatEntries) = chatValue else { continue }
                            let chatId = stringValue(chatEntries.first(where: { $0.0 == "id" })?.1) ?? UUID().uuidString
                            let chatName = stringValue(chatEntries.first(where: { $0.0 == "name" })?.1) ?? ""
                            let chatNote = stringValue(chatEntries.first(where: { $0.0 == "note" })?.1) ?? ""
                            let folderId = stringValue(chatEntries.first(where: { $0.0 == "folderId" })?.1)
                            let lastDate = doubleValue(chatEntries.first(where: { $0.0 == "lastDate" })?.1).map(Int.init)

                            try db.execute("""
                                INSERT INTO chats (id, character_id, position, name, note, folder_id, last_message_time, messages_loaded, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
                            """, [
                                .text(chatId), .text(chaId), .integer(Int64(chatPosition)), .text(chatName), .text(chatNote),
                                folderId.map(SqliteValue.text) ?? .null,
                                lastDate.map { .integer(Int64($0)) } ?? .null,
                            ])

                            // Chat extension nodes: everything except message/id/messagesLoaded/etc.
                            let chatData = chatEntries.filter { entry in
                                !["message", "id", "messagesLoaded", "messageOffset", "messageTotal", "messagesFullyLoaded", "preventMessageCompaction", "detailsLoaded"].contains(entry.0)
                            }
                            try replaceNodes(table: "chat_extension_nodes", ownerColumns: ["chat_id"], ownerValues: [.text(chatId)], value: .object(chatData))

                            // Messages.
                            if let messagesValue = chatEntries.first(where: { $0.0 == "message" })?.1, case .array(let msgArr) = messagesValue {
                                for (msgPosition, msgValue) in msgArr.enumerated() {
                                    guard case .object(let msgEntries) = msgValue else { continue }
                                    let msgId = stringValue(msgEntries.first(where: { $0.0 == "chatId" })?.1) ?? UUID().uuidString
                                    let role = stringValue(msgEntries.first(where: { $0.0 == "role" })?.1) ?? "char"
                                    let content = stringValue(msgEntries.first(where: { $0.0 == "data" })?.1) ?? ""
                                    let senderName = stringValue(msgEntries.first(where: { $0.0 == "name" })?.1)
                                    let sentTime = doubleValue(msgEntries.first(where: { $0.0 == "time" })?.1).map(Int.init)
                                    let genInfo = msgEntries.first(where: { $0.0 == "generationInfo" })?.1
                                    let generationModel: String? = {
                                        guard case .object(let info) = genInfo else { return nil }
                                                        return stringValue(info.first(where: { $0.0 == "model" })?.1)
                                    }()
                                    let inputTokens: Int? = {
                                        guard case .object(let info) = genInfo else { return nil }
                                        return doubleValue(info.first(where: { $0.0 == "inputTokens" })?.1).map(Int.init)
                                    }()
                                    let outputTokens: Int? = {
                                        guard case .object(let info) = genInfo else { return nil }
                                        return doubleValue(info.first(where: { $0.0 == "outputTokens" })?.1).map(Int.init)
                                    }()

                                    let contentEncoded = RelationalNodeCodec.encodedText(content)
                                    try db.execute("""
                                        INSERT INTO messages (chat_id, id, position, role, content_text, content_encoded, sender_name, sent_time, generation_model, input_tokens, output_tokens)
                                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                    """, [
                                        .text(chatId), .text(msgId), .integer(Int64(msgPosition)), .text(role),
                                        contentEncoded.text.map(SqliteValue.text) ?? .null,
                                        contentEncoded.encoded.map(SqliteValue.text) ?? .null,
                                        senderName.map(SqliteValue.text) ?? .null,
                                        sentTime.map { .integer(Int64($0)) } ?? .null,
                                        generationModel.map(SqliteValue.text) ?? .null,
                                        inputTokens.map { .integer(Int64($0)) } ?? .null,
                                        outputTokens.map { .integer(Int64($0)) } ?? .null,
                                    ])

                                    // Message extension nodes: everything except chatId.
                                    let msgData = msgEntries.filter { $0.0 != "chatId" }
                                    try replaceNodes(table: "message_extension_nodes", ownerColumns: ["chat_id", "message_id"], ownerValues: [.text(chatId), .text(msgId)], value: .object(msgData))
                                }
                            }
                        }
                    }
                }
            }

            // Bump revision.
            revision += 1
            try db.execute("UPDATE system_storage_meta SET revision = ?, initialized = 1, updated_at = datetime('now') WHERE singleton = 1", [.integer(Int64(revision))])
            try db.execute("INSERT INTO system_revisions (storage_revision, database_initialized, scope, action, created_at) VALUES (?, 1, 'database', ?, datetime('now'))", [.integer(Int64(revision)), .text("replace-all")])
        }
        log.info("Replaced database (revision \(self.revision))")
    }

    // MARK: - Single-setting upsert

    /// Mirrors the root setting upsert path in `applySqliteCommit`.
    func upsertSetting(key: String, value: JsValue) throws {
        guard let db else { return }
        let rows = RelationalNodeCodec.flatten(value)
        guard let root = rows.first else { return }
        try db.execute("""
            INSERT INTO system_settings (key, domain, value_type, text_value, encoded_text_value, number_value, boolean_value, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET
            domain=excluded.domain, value_type=excluded.value_type, text_value=excluded.text_value,
            encoded_text_value=excluded.encoded_text_value, number_value=excluded.number_value,
            boolean_value=excluded.boolean_value, updated_at=datetime('now')
        """, [
            .text(key), .text(settingDomain(key)),
            .text(root.valueType.rawValue),
            root.textValue.map(SqliteValue.text) ?? .null,
            root.encodedTextValue.map(SqliteValue.text) ?? .null,
            root.numberValue.map(SqliteValue.real) ?? .null,
            root.booleanValue.map { .integer(Int64($0)) } ?? .null,
        ])
        try replaceNodes(table: "setting_extension_nodes", ownerColumns: ["setting_key"], ownerValues: [.text(key)], value: value)
    }

    // MARK: - Helpers

    /// FNV-1a content hash mirroring `presetContentHash` (length + uint32 hash in hex).
    func presetContentHash(_ json: String) -> String {
        var hash: UInt32 = 2166136261
        for char in json.unicodeScalars {
            hash ^= char.value
            hash = hash &* 16777619
        }
        return "\(json.count)-\(String(hash, radix: 16))"
    }

    private func jsonString(_ value: JsValue) -> String {
        // JSONSerialization requires a Swift native type; convert through asAny.
        let any = value.asAny
        guard let data = try? JSONSerialization.data(withJSONObject: any, options: [.sortedKeys]) else { return "null" }
        return String(data: data, encoding: .utf8) ?? "null"
    }

    private func stringValue(_ value: JsValue?) -> String? {
        guard let value else { return nil }
        if case .string(let s) = value { return s }
        if case .number(let n) = value { return String(n) }
        if case .bool(let b) = value { return b ? "true" : "false" }
        return nil
    }

    private func doubleValue(_ value: JsValue?) -> Double? {
        guard let value else { return nil }
        if case .number(let n) = value { return n }
        if case .bool(let b) = value { return b ? 1 : 0 }
        if case .string(let s) = value { return Double(s) }
        return nil
    }

    // Setting domain mapping (subset of SETTING_DOMAINS from sqliteCommit.ts).
    private func settingDomain(_ key: String) -> String {
        for (domain, keys) in Self.settingDomains {
            if keys.contains(key) { return domain }
        }
        return "account-sync-compatibility"
    }

    private static let settingDomains: [(String, Set<String>)] = [
        ("model", ["apiType", "aiModel", "subModel", "temperature", "maxContext", "maxResponse", "frequencyPenalty", "PresensePenalty", "bias", "customModels", "fallbackModels"]),
        ("provider", ["openAIKey", "proxyKey", "forceReplaceUrl", "openrouterKey", "claudeAPIKey", "nanogptKey", "koboldURL", "textgenWebUIStreamURL", "textgenWebUIBlockingURL", "OaiCompAPIKeys"]),
        ("prompt", ["mainPrompt", "jailbreak", "globalNote", "additionalPrompt", "descriptionPrefix", "promptTemplate", "promptSettings", "instructChatTemplate", "JinjaTemplate", "globalscript"]),
        ("memory", ["supaMemoryPrompt", "supaMemoryKey", "hypaMemoryKey", "voyageApiKey", "hypaMemory", "hypav2", "hypaModel", "memoryAlgorithmType"]),
        ("translation", ["language", "translator", "translatorType", "translatorInputLanguage", "autoTranslate", "useAutoTranslateInput", "deeplOptions", "deeplXOptions"]),
        ("media", ["sdProvider", "webUiUrl", "sdSteps", "sdCFG", "sdConfig", "NAIImgUrl", "NAIApiKey", "NAIImgModel", "NAIImgConfig", "ttsAutoSpeech", "elevenLabKey", "voicevoxUrl"]),
        ("ui", ["zoomsize", "customBackground", "fullScreen", "iconsize", "theme", "textTheme", "customTextTheme", "colorScheme", "colorSchemeName", "customColorScheme", "characterOrder", "hotkeys"]),
        ("collection", ["botPresets", "personas", "modules", "loreBook", "loadouts", "plugins", "pluginV2", "translatorPresets"]),
    ]
}

// MARK: - JsDatabase: a typed view over the JS database tree

/// Convenience accessor over the JS-style database object loaded from SQLite.
struct JsDatabase {
    private var root: [(String, JsValue)] = []

    init() {}

    mutating func set(_ key: String, _ value: JsValue) {
        if let index = root.firstIndex(where: { $0.0 == key }) {
            root[index] = (key, value)
        } else {
            root.append((key, value))
        }
    }

    func get(_ key: String) -> JsValue? {
        root.first(where: { $0.0 == key })?.1
    }

    func rootEntries() -> [(String, JsValue)] { root }

    var pluginCustomStorage: JsValue? { self.get("pluginCustomStorage") }
    var botPresets: JsValue? { self.get("botPresets") }
    var characters: JsValue? { self.get("characters") }
}

extension JsValue {
    /// Sets/replaces a key on an object node (no-op for non-objects).
    mutating func setKey(_ key: String, _ value: JsValue) {
        guard case .object(var entries) = self else { return }
        if let index = entries.firstIndex(where: { $0.0 == key }) {
            entries[index] = (key, value)
        } else {
            entries.append((key, value))
        }
        self = .object(entries)
    }
}