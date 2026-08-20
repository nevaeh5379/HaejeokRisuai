-- Simplified SQLite schema for RisuAI local storage (web/Tauri).
-- Unlike the server-side relational schema, this uses a pragmatic hybrid:
--   - Core metadata columns are indexed for fast listing/shallow loads.
--   - Full entity data is stored as JSON in a `data` column.
-- This minimises client-side code while still enabling lazy loading by
-- loading only metadata for lists and fetching `data` on demand.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_storage_meta (
    singleton INTEGER PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
    schema_version INTEGER NOT NULL DEFAULT 1,
    schema_layout TEXT NOT NULL DEFAULT 'local-json-v1',
    revision INTEGER NOT NULL DEFAULT 0,
    initialized INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_storage_meta (singleton, schema_version, schema_layout)
VALUES (1, 1, 'local-json-v1');

CREATE TABLE IF NOT EXISTS system_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    storage_revision INTEGER,
    database_initialized INTEGER,
    scope TEXT NOT NULL CHECK (scope IN ('database', 'cold-storage', 'restore')),
    action TEXT NOT NULL,
    restored_from_revision INTEGER REFERENCES system_revisions(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS revisions_created_idx
ON system_revisions (created_at DESC, id DESC);

-- ── Root settings (key-value JSON) ─────────────────────────────────────
-- Each key stores one top-level Database field (e.g. mainPrompt, botPresets).
-- This mirrors the server's system.settings + setting_values but flattened.

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Characters ─────────────────────────────────────────────────────────
-- Metadata columns are duplicated from `data` JSON for shallow listing.
-- `data` holds the full character JSON *without* chats.

CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'character',
    name TEXT NOT NULL DEFAULT '',
    image TEXT,
    trash_time INTEGER,
    creation_time INTEGER,
    modification_time INTEGER,
    last_interaction_time INTEGER,
    details_loaded INTEGER NOT NULL DEFAULT 0,
    data TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS characters_position_idx ON characters (position);
CREATE INDEX IF NOT EXISTS characters_kind_position_idx ON characters (kind, position);

-- ── Chats ──────────────────────────────────────────────────────────────
-- `data` holds the full chat JSON *without* messages.
-- `messages_loaded` = 0 means messages are not in memory (lazy).

CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    folder_id TEXT,
    last_message_time INTEGER,
    messages_loaded INTEGER NOT NULL DEFAULT 0,
    data TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS chats_character_position_idx
ON chats (character_id, position);

CREATE INDEX IF NOT EXISTS chats_folder_idx
ON chats (character_id, folder_id) WHERE folder_id IS NOT NULL;

-- ── Messages ───────────────────────────────────────────────────────────
-- Each message is a separate row. `data` holds the full message JSON
-- (role, content, generationInfo, promptInfo, etc.).

CREATE TABLE IF NOT EXISTS messages (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    position INTEGER NOT NULL,
    role TEXT NOT NULL,
    sent_time INTEGER,
    data TEXT NOT NULL,
    PRIMARY KEY (chat_id, id)
);

CREATE INDEX IF NOT EXISTS messages_chat_position_idx
ON messages (chat_id, position);

-- ── Cold storage ───────────────────────────────────────────────────────
-- Cold storage items are stored as opaque JSON blobs keyed by archive ID.

CREATE TABLE IF NOT EXISTS cold_storage (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Plugins ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS plugins (
    key TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plugin_custom_storage (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);