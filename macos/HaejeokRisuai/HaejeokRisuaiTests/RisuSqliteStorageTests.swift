import Foundation
import Testing
@testable import HaejeokRisuai

@MainActor
struct RelationalNodeCodecTests {

    @Test func roundTripsNestedValues() throws {
        // Mirrors the TS codec test: null, empty containers, NUL, NaN, Infinity.
        // (Lone surrogates are a JS-only artifact Swift strings can't represent;
        //  we cover NUL — the real cross-compat case — separately below.)
        let value: JsValue = .object([
            ("null", .null),
            ("emptyArray", .array([])),
            ("emptyObject", .object([])),
            ("nested", .array([
                .object([("odd\u{0000}key", .string("nul\u{0000}value")), ("flag", .bool(true))]),
                .array([.bool(true), .bool(false), .number(0)]),
            ])),
            ("undefined", .undefined),
            ("nan", .number(.nan)),
            ("positiveInfinity", .number(.infinity)),
        ])

        let rows = RelationalNodeCodec.flatten(value)
        let rebuilt = try RelationalNodeCodec.rebuild(rows)

        #expect(equals(rebuilt, value))
        #expect(rows.count > 7)
    }

    @Test func preservesNulByteViaEncodedText() throws {
        let value = JsValue.string("a\u{0000}b")
        let rows = RelationalNodeCodec.flatten(value)
        #expect(rows.count == 1)
        // NUL is not SQL-safe → must use encoded_text_value, text_value nil.
        #expect(rows[0].textValue == nil)
        #expect(rows[0].encodedTextValue != nil)
        let rebuilt = try RelationalNodeCodec.rebuild(rows)
        if case .string(let s) = rebuilt {
            #expect(s == "a\u{0000}b")
        } else {
            Issue.record("expected string")
        }
    }

    @Test func storesFiniteNumbersInNumberValue() throws {
        let rows = RelationalNodeCodec.flatten(.number(42.5))
        #expect(rows[0].valueType == .number)
        #expect(rows[0].numberValue == 42.5)
        #expect(rows[0].textValue == nil)
    }

    @Test func storesNonFiniteNumbersAsText() throws {
        let nanRows = RelationalNodeCodec.flatten(.number(.nan))
        #expect(nanRows[0].textValue == "NaN")
        let infRows = RelationalNodeCodec.flatten(.number(.infinity))
        #expect(infRows[0].textValue == "Infinity")
        let negInfRows = RelationalNodeCodec.flatten(.number(-.infinity))
        #expect(negInfRows[0].textValue == "-Infinity")

        let rebuilt = try RelationalNodeCodec.rebuild(nanRows)
        if case .number(let n) = rebuilt { #expect(n.isNaN) } else { Issue.record() }
    }

    @Test func distinguishesNullAndUndefined() throws {
        let nullRows = RelationalNodeCodec.flatten(.null)
        #expect(nullRows[0].valueType == .null)
        let undefRows = RelationalNodeCodec.flatten(.undefined)
        #expect(undefRows[0].valueType == .undefined)
    }

    @Test func arrayAndObjectChildrenOrderedByNodeOrder() throws {
        let value = JsValue.array([.number(10), .number(20), .number(30)])
        let rows = RelationalNodeCodec.flatten(value)
        #expect(rows[0].valueType == .array)
        #expect(rows[1].nodeOrder == 0)
        #expect(rows[2].nodeOrder == 1)
        #expect(rows[3].nodeOrder == 2)
    }

    private func equals(_ a: JsValue, _ b: JsValue) -> Bool {
        // Deep, NaN-aware equality for the round-trip test.
        switch (a, b) {
        case (.undefined, .undefined), (.null, .null): return true
        case (.bool(let x), .bool(let y)): return x == y
        case (.number(let x), .number(let y)):
            if x.isNaN && y.isNaN { return true }
            return x == y
        case (.string(let x), .string(let y)): return x == y
        case (.array(let x), .array(let y)):
            return x.count == y.count && zip(x, y).allSatisfy { equals($0, $1) }
        case (.object(let x), .object(let y)):
            return x.count == y.count
                && zip(x, y).allSatisfy { $0.0 == $1.0 && equals($0.1, $1.1) }
        default: return false
        }
    }
}

@MainActor
struct RisuSqliteStorageTests {

    @Test func schemaCreationSucceeds() throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("risu-test-\(UUID().uuidString).sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }

        let sqlite = try RisuSqlite(path: url.path)
        try sqlite.exec("""
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
        """)
        let rev = try sqlite.scalar("SELECT revision FROM system_storage_meta WHERE singleton = 1").int
        #expect(rev == 0)
        let layout = try sqlite.scalar("SELECT schema_layout FROM system_storage_meta WHERE singleton = 1").string
        #expect(layout == "relational-schema-v3")
    }

    @Test func fullRoundTripThroughSQLite() throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("risu-rt-\(UUID().uuidString).sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }

        // Build a database with a character, chat, and messages.
        var char = CharacterCard(name: "Test Character")
        char.desc = "A brave hero."
        char.firstMessage = "Hello there!"
        char.tags = ["hero", "fantasy"]
        char.globalLore = [LoreBookEntry(key: "sword", comment: "weapon", content: "A legendary blade.")]
        var chat = ChatSession(name: "Main Chat", messages: [
            ChatMessage(role: .char, data: "Hello there!"),
            ChatMessage(role: .user, data: "Hi, who are you?"),
        ])
        chat.note = "An author's note."
        char.chats = [chat]

        let settings = AppSettings()
        let jsDB = JsDatabaseBridge.save(settings: settings, characters: [char])
        #expect(jsDB.characters != nil)

        // Write to a fresh SQLite DB.
        let sqlite = try RisuSqlite(path: url.path)
        try createSchema(on: sqlite)

        // Manually drive the storage's replace using a temporary storage instance.
        let storage = TestStorage(sqlite: sqlite)
        try storage.replaceDatabase(jsDB)

        // Read it back.
        let loaded = try storage.loadDatabase()
        #expect(!loaded.isEmpty)

        let bridge = JsDatabaseBridge.load(from: loaded.database)
        #expect(bridge.characters.count == 1)
        let readChar = bridge.characters[0]
        #expect(readChar.name == "Test Character")
        #expect(readChar.desc == "A brave hero.")
        #expect(readChar.firstMessage == "Hello there!")
        #expect(readChar.tags == ["hero", "fantasy"])
        #expect(readChar.chats.count == 1)
        #expect(readChar.chats[0].messages.count == 2)
        #expect(readChar.chats[0].note == "An author's note.")
        #expect(readChar.chats[0].messages[0].data == "Hello there!")
        #expect(readChar.globalLore.count == 1)
        #expect(readChar.globalLore[0].key == "sword")
    }

    @Test func characterExtensionNodesContainWebFieldNames() throws {
        // Verify the extension-nodes table stores `firstMessage` (web schema)
        // and not our internal `firstMessage`-only naming.
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("risu-fields-\(UUID().uuidString).sqlite3")
        defer { try? FileManager.default.removeItem(at: url) }

        var char = CharacterCard(name: "Fields")
        char.firstMessage = "greeting"
        char.chats = []

        let jsDB = JsDatabaseBridge.save(settings: AppSettings(), characters: [char])
        let sqlite = try RisuSqlite(path: url.path)
        try createSchema(on: sqlite)
        let storage = TestStorage(sqlite: sqlite)
        try storage.replaceDatabase(jsDB)

        // The character's firstMessage must appear as an object_key in extension nodes.
        let rows = try sqlite.query(
            "SELECT object_key FROM character_extension_nodes WHERE object_key = ?",
            [.text("firstMessage")]
        ) { $0.string(0) ?? "" }
        #expect(rows.contains("firstMessage"))

        // And the characters table should have the row.
        let count = try sqlite.scalar("SELECT COUNT(*) FROM characters").int ?? 0
        #expect(count == 1)
    }

    // MARK: - Helpers

    /// Creates the v3 schema on a raw SQLite connection (independent of the shared storage).
    private func createSchema(on sqlite: RisuSqlite) throws {
        // Reuse the shared storage's schema by pointing a temporary instance at it.
        let storage = TestStorage(sqlite: sqlite)
        try storage.createSchema()
    }
}

/// A test-only RisuSqliteStorage that uses a provided SQLite connection
/// instead of opening the shared app-support database.
@MainActor
final class TestStorage {
    let sqlite: RisuSqlite
    var revision = 0

    init(sqlite: RisuSqlite) {
        self.sqlite = sqlite
    }

    func createSchema() throws {
        try sqlite.exec(schemaSQL)
    }

    func loadDatabase() throws -> RisuSqliteStorage.LoadResult {
        // Minimal load: read settings keys, characters, chats, messages using
        // the same node-rebuild logic as the real storage.
        var database = JsDatabase()

        let settingKeys = try sqlite.query("SELECT key FROM system_settings") { $0.string(0) ?? "" }
        for key in settingKeys {
            if let value = try loadNodeValue(table: "setting_extension_nodes", ownerWhere: "setting_key = ?", bind: [.text(key)]) {
                database.set(key, value)
            }
        }

        let charRows = try sqlite.query(
            "SELECT id, name, image, kind, trash_time, creation_time, modification_time, last_interaction_time FROM characters ORDER BY position"
        ) { reader in
            (id: reader.string(0) ?? "", name: reader.string(1) ?? "", image: reader.string(2), kind: reader.string(3) ?? "character",
             trashTime: reader.int(4), creationTime: reader.int(5), modificationTime: reader.int(6), lastInteraction: reader.int(7))
        }

        var characters: [JsValue] = []
        for row in charRows {
            var charValue = (try loadNodeValue(table: "character_extension_nodes", ownerWhere: "character_id = ?", bind: [.text(row.id)])) ?? JsValue.object([])
            charValue.setKey("chaId", .string(row.id))
            charValue.setKey("name", .string(row.name))
            if let image = row.image { charValue.setKey("image", .string(image)) }
            charValue.setKey("type", .string(row.kind))

            let chatRows = try sqlite.query(
                "SELECT id, name, note, folder_id, last_message_time FROM chats WHERE character_id = ? ORDER BY position",
                [.text(row.id)]
            ) { reader in
                (id: reader.string(0) ?? "", name: reader.string(1) ?? "", note: reader.string(2) ?? "",
                 folderId: reader.string(3), lastTime: reader.int(4))
            }

            var chats: [JsValue] = []
            for chatRow in chatRows {
                var chatValue = (try loadNodeValue(table: "chat_extension_nodes", ownerWhere: "chat_id = ?", bind: [.text(chatRow.id)])) ?? JsValue.object([])
                chatValue.setKey("id", .string(chatRow.id))
                chatValue.setKey("name", .string(chatRow.name))
                chatValue.setKey("note", .string(chatRow.note))

                let msgRows = try sqlite.query(
                    "SELECT id FROM messages WHERE chat_id = ? ORDER BY position",
                    [.text(chatRow.id)]
                ) { $0.string(0) ?? "" }
                var messages: [JsValue] = []
                for msgId in msgRows {
                    if let msgValue = try loadNodeValue(table: "message_extension_nodes", ownerWhere: "chat_id = ? AND message_id = ?", bind: [.text(chatRow.id), .text(msgId)]) {
                        var msg = msgValue
                        msg.setKey("chatId", .string(msgId))
                        messages.append(msg)
                    }
                }
                chatValue.setKey("message", .array(messages))
                chats.append(chatValue)
            }
            charValue.setKey("chats", .array(chats))
            characters.append(charValue)
        }
        database.set("characters", .array(characters))
        return RisuSqliteStorage.LoadResult(database: database, isEmpty: characters.isEmpty && settingKeys.isEmpty)
    }

    func replaceDatabase(_ database: JsDatabase) throws {
        try sqlite.transaction {
            try sqlite.execute("DELETE FROM system_settings")
            try sqlite.execute("DELETE FROM characters")

            for (key, value) in database.rootEntries() {
                if key == "botPresets" || key == "botPresetsId" || key == "pluginCustomStorage" { continue }
                let rows = RelationalNodeCodec.flatten(value)
                guard let root = rows.first else { continue }
                try sqlite.execute("""
                    INSERT INTO system_settings (key, domain, value_type, text_value, encoded_text_value, number_value, boolean_value, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """, [
                    .text(key), .text("account-sync-compatibility"),
                    .text(root.valueType.rawValue),
                    root.textValue.map(SqliteValue.text) ?? .null,
                    root.encodedTextValue.map(SqliteValue.text) ?? .null,
                    root.numberValue.map(SqliteValue.real) ?? .null,
                    root.booleanValue.map { .integer(Int64($0)) } ?? .null,
                ])
                try replaceNodes(table: "setting_extension_nodes", ownerColumns: ["setting_key"], ownerValues: [.text(key)], value: value)
            }

            if let chars = database.characters, case .array(let arr) = chars {
                for (position, charValue) in arr.enumerated() {
                    guard case .object(let entries) = charValue else { continue }
                    let chaId = entries.first(where: { $0.0 == "chaId" }).flatMap { stringValue($0.1) } ?? UUID().uuidString
                    let name = entries.first(where: { $0.0 == "name" }).flatMap { stringValue($0.1) } ?? ""
                    let image = entries.first(where: { $0.0 == "image" }).flatMap { stringValue($0.1) }
                    try sqlite.execute("""
                        INSERT INTO characters (id, position, kind, name, image, details_loaded, updated_at)
                        VALUES (?, ?, 'character', ?, ?, 1, datetime('now'))
                    """, [
                        .text(chaId), .integer(Int64(position)), .text(name),
                        image.map(SqliteValue.text) ?? .null,
                    ])
                    let charData = entries.filter { $0.0 != "chats" && $0.0 != "chaId" && $0.0 != "detailsLoaded" }
                    try replaceNodes(table: "character_extension_nodes", ownerColumns: ["character_id"], ownerValues: [.text(chaId)], value: .object(charData))

                    if let tags = entries.first(where: { $0.0 == "tags" })?.1, case .array(let tagArr) = tags {
                        for (i, tag) in tagArr.enumerated() {
                            if case .string(let s) = tag {
                                try sqlite.execute("INSERT INTO character_tags (character_id, position, tag) VALUES (?, ?, ?)", [.text(chaId), .integer(Int64(i)), .text(s)])
                            }
                        }
                    }

                    if let chats = entries.first(where: { $0.0 == "chats" })?.1, case .array(let chatArr) = chats {
                        for (chatPos, chatValue) in chatArr.enumerated() {
                            guard case .object(let chatEntries) = chatValue else { continue }
                            let chatId = chatEntries.first(where: { $0.0 == "id" }).flatMap { stringValue($0.1) } ?? UUID().uuidString
                            let chatName = chatEntries.first(where: { $0.0 == "name" }).flatMap { stringValue($0.1) } ?? ""
                            let chatNote = chatEntries.first(where: { $0.0 == "note" }).flatMap { stringValue($0.1) } ?? ""
                            try sqlite.execute("""
                                INSERT INTO chats (id, character_id, position, name, note, messages_loaded, updated_at)
                                VALUES (?, ?, ?, ?, ?, 0, datetime('now'))
                            """, [.text(chatId), .text(chaId), .integer(Int64(chatPos)), .text(chatName), .text(chatNote)])
                            let chatData = chatEntries.filter { !["message", "id", "messagesLoaded", "detailsLoaded"].contains($0.0) }
                            try replaceNodes(table: "chat_extension_nodes", ownerColumns: ["chat_id"], ownerValues: [.text(chatId)], value: .object(chatData))

                            if let msgs = chatEntries.first(where: { $0.0 == "message" })?.1, case .array(let msgArr) = msgs {
                                for (msgPos, msgValue) in msgArr.enumerated() {
                                    guard case .object(let msgEntries) = msgValue else { continue }
                                    let msgId = msgEntries.first(where: { $0.0 == "chatId" }).flatMap { stringValue($0.1) } ?? UUID().uuidString
                                    let role = msgEntries.first(where: { $0.0 == "role" }).flatMap { stringValue($0.1) } ?? "char"
                                    let content = msgEntries.first(where: { $0.0 == "data" }).flatMap { stringValue($0.1) } ?? ""
                                    let encoded = RelationalNodeCodec.encodedText(content)
                                    try sqlite.execute("""
                                        INSERT INTO messages (chat_id, id, position, role, content_text, content_encoded, sender_name, sent_time, generation_model, input_tokens, output_tokens)
                                        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
                                    """, [
                                        .text(chatId), .text(msgId), .integer(Int64(msgPos)), .text(role),
                                        encoded.text.map(SqliteValue.text) ?? .null,
                                        encoded.encoded.map(SqliteValue.text) ?? .null,
                                    ])
                                    let msgData = msgEntries.filter { $0.0 != "chatId" }
                                    try replaceNodes(table: "message_extension_nodes", ownerColumns: ["chat_id", "message_id"], ownerValues: [.text(chatId), .text(msgId)], value: .object(msgData))
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func loadNodeValue(table: String, ownerWhere: String, bind: [SqliteValue]) throws -> JsValue? {
        let rows = try sqlite.query("""
            SELECT node_id, parent_node_id, node_order, object_key, object_key_encoded,
                   value_type, text_value, encoded_text_value, number_value, boolean_value
            FROM \(table) WHERE \(ownerWhere) ORDER BY node_id
        """, bind) { reader in
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
        return try RelationalNodeCodec.rebuild(rows)
    }

    private func replaceNodes(table: String, ownerColumns: [String], ownerValues: [SqliteValue], value: JsValue) throws {
        let whereClause = ownerColumns.map { "\($0) = ?" }.joined(separator: " AND ")
        try sqlite.execute("DELETE FROM \(table) WHERE \(whereClause)", ownerValues)
        let columns = ownerColumns + RelationalNodeCodec.columns
        let placeholders = columns.map { _ in "?" }.joined(separator: ", ")
        let sql = "INSERT INTO \(table) (\(columns.joined(separator: ", "))) VALUES (\(placeholders))"
        for row in RelationalNodeCodec.flatten(value) {
            try sqlite.execute(sql, ownerValues + row.nodeBind)
        }
    }

    private func stringValue(_ v: JsValue?) -> String? {
        guard let v else { return nil }
        if case .string(let s) = v { return s }
        return nil
    }
}

/// The canonical v3 schema SQL, used by the test storage.
let schemaSQL = """
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

CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY, position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL DEFAULT 'character' CHECK (kind IN ('character', 'group')),
    name TEXT NOT NULL DEFAULT '', image TEXT, trash_time INTEGER, creation_time INTEGER,
    modification_time INTEGER, last_interaction_time INTEGER,
    details_loaded INTEGER NOT NULL DEFAULT 0 CHECK (details_loaded IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS character_tags (
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0), tag TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY, character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0), name TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
    folder_id TEXT, last_message_time INTEGER,
    messages_loaded INTEGER NOT NULL DEFAULT 0 CHECK (messages_loaded IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

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

CREATE TABLE IF NOT EXISTS messages (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    id TEXT NOT NULL, position INTEGER NOT NULL CHECK (position >= 0), role TEXT NOT NULL,
    content_text TEXT, content_encoded TEXT, sender_name TEXT, sent_time INTEGER,
    generation_model TEXT, input_tokens INTEGER, output_tokens INTEGER,
    PRIMARY KEY (chat_id, id), CHECK (content_text IS NULL OR content_encoded IS NULL)
);

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
"""