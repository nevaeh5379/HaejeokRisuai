-- RisuAI local relational schema. Business JSON is permitted only in
-- plugin_custom_storage; all other nested values use typed node rows.
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
-- Message search uses LIKE '%query%', so a normal B-tree on the full message
-- body cannot serve it. Keeping that index makes large restores write every
-- chat body twice and can dominate Android SQLite restore time.
DROP INDEX IF EXISTS messages_content_idx;
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

-- The only business-value JSON exception. One row per top-level plugin key.
CREATE TABLE IF NOT EXISTS plugin_custom_storage (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL CHECK (json_valid(value)),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
