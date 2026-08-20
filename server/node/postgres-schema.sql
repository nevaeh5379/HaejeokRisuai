CREATE SCHEMA IF NOT EXISTS system;
CREATE SCHEMA IF NOT EXISTS character;
CREATE SCHEMA IF NOT EXISTS chat;
CREATE SCHEMA IF NOT EXISTS cold;

CREATE TABLE IF NOT EXISTS system.storage_meta (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    schema_version INTEGER NOT NULL DEFAULT 2,
    schema_layout TEXT NOT NULL DEFAULT 'relational-schema-v1',
    revision BIGINT NOT NULL DEFAULT 0,
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO system.storage_meta (singleton, schema_version, schema_layout)
VALUES (TRUE, 2, 'relational-schema-v1')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS system.asset_catalog_state (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    source_id TEXT,
    synced_at TIMESTAMPTZ
);

ALTER TABLE system.asset_catalog_state
ADD COLUMN IF NOT EXISTS source_id TEXT;

INSERT INTO system.asset_catalog_state (singleton)
VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS system.asset_catalog (
    asset_key TEXT PRIMARY KEY,
    size_bytes BIGINT,
    etag TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS asset_catalog_updated_idx
ON system.asset_catalog (updated_at DESC);

CREATE TABLE IF NOT EXISTS system.revisions (
    id BIGSERIAL PRIMARY KEY,
    storage_revision BIGINT,
    database_initialized BOOLEAN,
    scope TEXT NOT NULL CHECK (scope IN ('database', 'cold-storage', 'restore')),
    action TEXT NOT NULL,
    restored_from_revision BIGINT REFERENCES system.revisions(id) DEFERRABLE INITIALLY DEFERRED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS revisions_created_idx
ON system.revisions (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS system.audit_log (
    sequence BIGSERIAL PRIMARY KEY,
    revision_id BIGINT NOT NULL REFERENCES system.revisions(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    before_row JSONB,
    after_row JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_revision_sequence_idx
ON system.audit_log (revision_id DESC, sequence DESC);

CREATE INDEX IF NOT EXISTS audit_table_revision_idx
ON system.audit_log (table_name, revision_id DESC);

CREATE OR REPLACE FUNCTION system.record_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    current_revision TEXT;
    qualified_table_name TEXT;
BEGIN
    current_revision := current_setting('risu.revision_id', TRUE);
    IF current_revision IS NULL OR current_revision = '' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    qualified_table_name := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;

    INSERT INTO system.audit_log (revision_id, table_name, operation, before_row, after_row)
    VALUES (
        current_revision::BIGINT,
        qualified_table_name,
        TG_OP,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END
    );
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TABLE IF NOT EXISTS system.settings (
    key TEXT PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system.setting_values (
    setting_key TEXT NOT NULL REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    node_id BIGINT NOT NULL CHECK (node_id >= 0),
    parent_node_id BIGINT,
    member_key TEXT,
    encoded_member_key TEXT,
    position INTEGER CHECK (position >= 0),
    value_type TEXT NOT NULL CHECK (
        value_type IN ('null', 'text', 'encoded-text', 'number', 'boolean', 'object', 'array')
    ),
    text_value TEXT,
    encoded_text_value TEXT,
    number_value DOUBLE PRECISION,
    boolean_value BOOLEAN,
    PRIMARY KEY (setting_key, node_id),
    FOREIGN KEY (setting_key, parent_node_id)
        REFERENCES system.setting_values(setting_key, node_id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK (
        (node_id = 0 AND parent_node_id IS NULL AND member_key IS NULL
            AND encoded_member_key IS NULL AND position IS NULL)
        OR
        (node_id > 0 AND parent_node_id IS NOT NULL AND (
            (position IS NOT NULL AND member_key IS NULL AND encoded_member_key IS NULL)
            OR
            (position IS NULL AND (
                (member_key IS NOT NULL AND encoded_member_key IS NULL)
                OR (member_key IS NULL AND encoded_member_key IS NOT NULL)
            ))
        ))
    ),
    CHECK (
        (value_type IN ('null', 'object', 'array') AND text_value IS NULL
            AND encoded_text_value IS NULL AND number_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'text' AND text_value IS NOT NULL
            AND encoded_text_value IS NULL AND number_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'encoded-text' AND text_value IS NULL
            AND encoded_text_value IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'number' AND text_value IS NULL
            AND encoded_text_value IS NULL AND number_value IS NOT NULL AND boolean_value IS NULL)
        OR (value_type = 'boolean' AND text_value IS NULL
            AND encoded_text_value IS NULL AND number_value IS NULL AND boolean_value IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS setting_values_parent_idx
ON system.setting_values (setting_key, parent_node_id, position);

CREATE INDEX IF NOT EXISTS setting_values_member_idx
ON system.setting_values (setting_key, member_key)
WHERE member_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS system.bot_presets (
    setting_key TEXT NOT NULL DEFAULT 'botPresets' CHECK (setting_key = 'botPresets'),
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT,
    api_type TEXT,
    ai_model TEXT,
    sub_model TEXT,
    main_prompt TEXT,
    jailbreak TEXT,
    global_note TEXT,
    temperature DOUBLE PRECISION,
    max_context INTEGER,
    max_response INTEGER,
    frequency_penalty DOUBLE PRECISION,
    presence_penalty DOUBLE PRECISION,
    prompt_preprocess BOOLEAN,
    proxy_model TEXT,
    openrouter_model TEXT,
    image TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS bot_presets_model_idx
ON system.bot_presets (api_type, ai_model);

CREATE TABLE IF NOT EXISTS system.personas (
    setting_key TEXT NOT NULL DEFAULT 'personas' CHECK (setting_key = 'personas'),
    position INTEGER NOT NULL CHECK (position >= 0),
    persona_id TEXT,
    name TEXT,
    prompt TEXT,
    icon TEXT,
    large_portrait BOOLEAN,
    note TEXT,
    embedded_module_id TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS personas_id_idx
ON system.personas (persona_id) WHERE persona_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS system.modules (
    setting_key TEXT NOT NULL DEFAULT 'modules' CHECK (setting_key = 'modules'),
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id TEXT,
    name TEXT,
    description TEXT,
    cjs TEXT,
    low_level_access BOOLEAN,
    hide_icon BOOLEAN,
    background_embedding TEXT,
    namespace TEXT,
    custom_toggle TEXT,
    mcp_url TEXT,
    icon TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS modules_id_idx
ON system.modules (module_id) WHERE module_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS system.plugins (
    setting_key TEXT NOT NULL CHECK (setting_key IN ('plugins', 'pluginV2')),
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT,
    display_name TEXT,
    script TEXT,
    api_version TEXT,
    plugin_version TEXT,
    update_url TEXT,
    enabled BOOLEAN,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS plugins_name_idx ON system.plugins (name);

CREATE TABLE IF NOT EXISTS system.global_lorebooks (
    setting_key TEXT NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.global_lore_entries (
    setting_key TEXT NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
    book_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    lore_id TEXT,
    primary_key TEXT,
    secondary_key TEXT,
    insert_order INTEGER,
    comment TEXT,
    content TEXT,
    mode TEXT,
    always_active BOOLEAN,
    selective BOOLEAN,
    case_sensitive BOOLEAN,
    activation_percent DOUBLE PRECISION,
    use_regex BOOLEAN,
    book_version INTEGER,
    folder TEXT,
    cache_key TEXT,
    PRIMARY KEY (setting_key, book_position, position),
    FOREIGN KEY (setting_key, book_position)
        REFERENCES system.global_lorebooks(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS global_lore_primary_idx
ON system.global_lore_entries (primary_key);

CREATE INDEX IF NOT EXISTS global_lore_content_fts_idx
ON system.global_lore_entries USING GIN (to_tsvector('simple', COALESCE(content, '')));

CREATE TABLE IF NOT EXISTS system.global_lore_cache_items (
    setting_key TEXT NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
    book_position INTEGER NOT NULL,
    lore_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, book_position, lore_position, position),
    FOREIGN KEY (setting_key, book_position, lore_position)
        REFERENCES system.global_lore_entries(setting_key, book_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.translator_presets (
    setting_key TEXT NOT NULL DEFAULT 'translatorPresets' CHECK (setting_key = 'translatorPresets'),
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT,
    prompt TEXT,
    max_response INTEGER,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.hotkeys (
    setting_key TEXT NOT NULL DEFAULT 'hotkeys' CHECK (setting_key = 'hotkeys'),
    position INTEGER NOT NULL CHECK (position >= 0),
    key TEXT,
    control BOOLEAN,
    shift BOOLEAN,
    alt BOOLEAN,
    action TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS hotkeys_action_idx ON system.hotkeys (action);

CREATE TABLE IF NOT EXISTS system.custom_models (
    setting_key TEXT NOT NULL DEFAULT 'customModels' CHECK (setting_key = 'customModels'),
    position INTEGER NOT NULL CHECK (position >= 0),
    id TEXT,
    internal_id TEXT,
    url TEXT,
    format INTEGER,
    tokenizer INTEGER,
    api_key TEXT,
    name TEXT,
    params TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS custom_models_id_idx
ON system.custom_models (id) WHERE id IS NOT NULL;

CREATE TABLE IF NOT EXISTS system.custom_model_flags (
    setting_key TEXT NOT NULL DEFAULT 'customModels' CHECK (setting_key = 'customModels'),
    model_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    flag INTEGER NOT NULL,
    PRIMARY KEY (setting_key, model_position, position),
    FOREIGN KEY (setting_key, model_position)
        REFERENCES system.custom_models(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.loadouts (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    position INTEGER NOT NULL CHECK (position >= 0),
    id TEXT,
    name TEXT,
    last_used BIGINT,
    favorite BOOLEAN,
    preset_name TEXT,
    persona_id TEXT,
    icons_present BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS loadouts_last_used_idx
ON system.loadouts (last_used DESC) WHERE last_used IS NOT NULL;

CREATE TABLE IF NOT EXISTS system.loadout_character_refs (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    character_id TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system.loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS loadout_character_idx
ON system.loadout_character_refs (character_id);

CREATE TABLE IF NOT EXISTS system.loadout_module_refs (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system.loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS loadout_module_idx ON system.loadout_module_refs (module_id);

CREATE TABLE IF NOT EXISTS system.loadout_variables (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, key),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system.loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.loadout_icons (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    asset_id TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system.loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.custom_sidebar_items (
    setting_key TEXT NOT NULL DEFAULT 'customSidebarItems' CHECK (setting_key = 'customSidebarItems'),
    position INTEGER NOT NULL CHECK (position >= 0),
    id TEXT,
    item_type TEXT,
    subtype TEXT,
    label TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.ordered_text_settings (
    setting_key TEXT NOT NULL CHECK (setting_key IN (
        'formatingOrder', 'localStopStrings', 'enabledModules', 'banCharacterset', 'modelTools'
    )),
    position INTEGER NOT NULL CHECK (position >= 0),
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS ordered_text_value_idx
ON system.ordered_text_settings (setting_key, value);

CREATE TABLE IF NOT EXISTS system.ordered_number_settings (
    setting_key TEXT NOT NULL CHECK (setting_key = 'customFlags'),
    position INTEGER NOT NULL CHECK (position >= 0),
    value DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.string_map_settings (
    setting_key TEXT NOT NULL CHECK (setting_key IN (
        'globalChatVariables', 'OaiCompAPIKeys', 'seperateModels'
    )),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, key),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.bias_entries (
    setting_key TEXT NOT NULL DEFAULT 'bias' CHECK (setting_key = 'bias'),
    position INTEGER NOT NULL CHECK (position >= 0),
    phrase TEXT NOT NULL,
    bias DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS bias_phrase_idx ON system.bias_entries (phrase);

CREATE TABLE IF NOT EXISTS system.additional_parameters (
    setting_key TEXT NOT NULL DEFAULT 'additionalParams' CHECK (setting_key = 'additionalParams'),
    position INTEGER NOT NULL CHECK (position >= 0),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS system.fallback_models (
    setting_key TEXT NOT NULL DEFAULT 'fallbackModels' CHECK (setting_key = 'fallbackModels'),
    category TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    model TEXT NOT NULL,
    PRIMARY KEY (setting_key, category, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS fallback_model_idx ON system.fallback_models (model);

CREATE TABLE IF NOT EXISTS system.openrouter_provider_rules (
    setting_key TEXT NOT NULL DEFAULT 'openrouterProvider' CHECK (setting_key = 'openrouterProvider'),
    rule_type TEXT NOT NULL CHECK (rule_type IN ('order', 'only', 'ignore')),
    position INTEGER NOT NULL CHECK (position >= 0),
    provider TEXT NOT NULL,
    PRIMARY KEY (setting_key, rule_type, position),
    FOREIGN KEY (setting_key) REFERENCES system.settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS openrouter_provider_idx
ON system.openrouter_provider_rules (provider, rule_type);

CREATE TABLE IF NOT EXISTS character.characters (
    id TEXT PRIMARY KEY,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('character', 'group')),
    name TEXT NOT NULL DEFAULT '',
    image TEXT,
    first_message TEXT NOT NULL DEFAULT '',
    description TEXT,
    notes TEXT,
    creator_notes TEXT,
    system_prompt TEXT,
    post_history_instructions TEXT,
    personality TEXT,
    scenario TEXT,
    example_message TEXT,
    creator TEXT,
    character_version TEXT,
    nickname TEXT,
    view_screen TEXT,
    chat_page INTEGER NOT NULL DEFAULT 0,
    first_message_index INTEGER,
    utility_bot BOOLEAN,
    is_private BOOLEAN,
    realm_id TEXT,
    license TEXT,
    default_variables TEXT,
    additional_text TEXT,
    translator_note TEXT,
    background_html TEXT,
    background_css TEXT,
    creation_time BIGINT,
    modification_time BIGINT,
    last_interaction_time BIGINT,
    trash_time BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS characters_position_idx ON character.characters (position);
CREATE INDEX IF NOT EXISTS characters_kind_position_idx ON character.characters (kind, position);
CREATE INDEX IF NOT EXISTS characters_lower_name_idx ON character.characters (LOWER(name));

CREATE TABLE IF NOT EXISTS character.attributes (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (character_id, key)
);

CREATE INDEX IF NOT EXISTS character_attributes_value_gin_idx
ON character.attributes USING GIN (value jsonb_path_ops);

CREATE TABLE IF NOT EXISTS character.tags (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    tag TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX IF NOT EXISTS character_tags_tag_idx ON character.tags (tag);

CREATE TABLE IF NOT EXISTS character.greetings (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    greeting_type TEXT NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
    position INTEGER NOT NULL CHECK (position >= 0),
    content TEXT NOT NULL,
    PRIMARY KEY (character_id, greeting_type, position)
);

CREATE TABLE IF NOT EXISTS character.biases (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    phrase TEXT NOT NULL,
    bias DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS character.emotions (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    emotion TEXT NOT NULL,
    asset TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS character.modules (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX IF NOT EXISTS character_modules_module_idx ON character.modules (module_id);

CREATE TABLE IF NOT EXISTS character.group_members (
    group_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    character_id TEXT NOT NULL,
    talk_weight DOUBLE PRECISION,
    active BOOLEAN,
    PRIMARY KEY (group_id, position)
);

CREATE INDEX IF NOT EXISTS group_members_character_idx ON character.group_members (character_id);

CREATE TABLE IF NOT EXISTS character.chat_folders (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    folder_id TEXT NOT NULL,
    name TEXT,
    color TEXT,
    folded BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (character_id, position),
    UNIQUE (character_id, folder_id)
);

CREATE TABLE IF NOT EXISTS character.scripts (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    script_kind TEXT NOT NULL CHECK (script_kind IN ('custom', 'trigger')),
    position INTEGER NOT NULL CHECK (position >= 0),
    comment TEXT,
    input_text TEXT,
    output_text TEXT,
    script_type TEXT,
    flag TEXT,
    able_flag BOOLEAN,
    trigger_payload JSONB,
    PRIMARY KEY (character_id, script_kind, position)
);

CREATE TABLE IF NOT EXISTS character.sd_data (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS character.assets (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    asset_source TEXT NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
    asset_type TEXT,
    uri TEXT,
    name TEXT,
    extension TEXT,
    extra_value TEXT,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS character.lore_entries (
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    lore_id TEXT,
    primary_key TEXT NOT NULL DEFAULT '',
    secondary_key TEXT NOT NULL DEFAULT '',
    insert_order INTEGER NOT NULL DEFAULT 0,
    comment TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'normal',
    always_active BOOLEAN NOT NULL DEFAULT FALSE,
    selective BOOLEAN NOT NULL DEFAULT FALSE,
    case_sensitive BOOLEAN,
    activation_percent DOUBLE PRECISION,
    use_regex BOOLEAN,
    book_version INTEGER,
    folder TEXT,
    cache_payload JSONB,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX IF NOT EXISTS character_lore_primary_key_idx
ON character.lore_entries (primary_key);

CREATE TABLE IF NOT EXISTS chat.chats (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES character.characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    sd_data TEXT,
    supa_memory_data TEXT,
    last_memory TEXT,
    is_streaming BOOLEAN,
    streaming_optimization_mode TEXT,
    bound_persona_id TEXT,
    first_message_index INTEGER,
    folder_id TEXT,
    last_message_time BIGINT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chats_character_position_idx
ON chat.chats (character_id, position);

CREATE INDEX IF NOT EXISTS chats_folder_idx
ON chat.chats (character_id, folder_id) WHERE folder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chats_last_message_idx
ON chat.chats (last_message_time DESC) WHERE last_message_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS chats_lower_name_idx ON chat.chats (LOWER(name));

CREATE TABLE IF NOT EXISTS chat.attributes (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (chat_id, key)
);

CREATE TABLE IF NOT EXISTS chat.suggestions (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    content TEXT NOT NULL,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE IF NOT EXISTS chat.modules (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id TEXT NOT NULL,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE IF NOT EXISTS chat.script_state (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'boolean')),
    text_value TEXT,
    number_value DOUBLE PRECISION,
    boolean_value BOOLEAN,
    PRIMARY KEY (chat_id, key),
    CHECK (
        (value_type = 'text' AND text_value IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'number' AND text_value IS NULL AND number_value IS NOT NULL AND boolean_value IS NULL)
        OR (value_type = 'boolean' AND text_value IS NULL AND number_value IS NULL AND boolean_value IS NOT NULL)
    )
);

CREATE TABLE IF NOT EXISTS chat.bookmarks (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    message_id TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (chat_id, position)
);

CREATE INDEX IF NOT EXISTS chat_bookmarks_message_idx
ON chat.bookmarks (chat_id, message_id);

CREATE TABLE IF NOT EXISTS chat.memory (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    memory_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (chat_id, memory_type)
);

CREATE TABLE IF NOT EXISTS chat.lore_entries (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    lore_id TEXT,
    primary_key TEXT NOT NULL DEFAULT '',
    secondary_key TEXT NOT NULL DEFAULT '',
    insert_order INTEGER NOT NULL DEFAULT 0,
    comment TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'normal',
    always_active BOOLEAN NOT NULL DEFAULT FALSE,
    selective BOOLEAN NOT NULL DEFAULT FALSE,
    case_sensitive BOOLEAN,
    activation_percent DOUBLE PRECISION,
    use_regex BOOLEAN,
    book_version INTEGER,
    folder TEXT,
    cache_payload JSONB,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE IF NOT EXISTS chat.messages (
    chat_id TEXT NOT NULL REFERENCES chat.chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    role TEXT NOT NULL CHECK (role IN ('user', 'char')),
    content_text TEXT,
    content_binary BYTEA,
    saying_character_id TEXT,
    sent_time BIGINT,
    sender_name TEXT,
    other_user BOOLEAN,
    disabled_scope TEXT CHECK (disabled_scope IN ('false', 'true', 'allBefore')),
    is_comment BOOLEAN,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, id),
    CHECK ((content_text IS NULL) <> (content_binary IS NULL))
);

CREATE INDEX IF NOT EXISTS messages_chat_position_idx
ON chat.messages (chat_id, position);

CREATE INDEX IF NOT EXISTS messages_role_idx ON chat.messages (role);
CREATE INDEX IF NOT EXISTS messages_sent_time_idx ON chat.messages (sent_time DESC)
WHERE sent_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_content_fts_idx
ON chat.messages USING GIN (to_tsvector('simple', COALESCE(content_text, '')));

CREATE TABLE IF NOT EXISTS chat.message_attributes (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (chat_id, message_id, key),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat.messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS chat.message_generation (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    model TEXT,
    generation_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    max_context INTEGER,
    stage1_time DOUBLE PRECISION,
    stage2_time DOUBLE PRECISION,
    stage3_time DOUBLE PRECISION,
    stage4_time DOUBLE PRECISION,
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat.messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS message_generation_model_idx
ON chat.message_generation (model) WHERE model IS NOT NULL;

CREATE TABLE IF NOT EXISTS chat.message_prompt_info (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    prompt_name TEXT,
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat.messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS chat.message_prompt_toggles (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    toggle_key TEXT NOT NULL,
    toggle_value TEXT,
    PRIMARY KEY (chat_id, message_id, position),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat.messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS chat.message_prompt_items (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    payload JSONB NOT NULL,
    PRIMARY KEY (chat_id, message_id, position),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat.messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.archives (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('character', 'chat', 'legacy')),
    owner_character_id TEXT,
    character_kind TEXT CHECK (character_kind IN ('character', 'group')),
    character_name TEXT,
    character_image TEXT,
    character_first_message TEXT,
    character_description TEXT,
    character_notes TEXT,
    character_creator_notes TEXT,
    character_system_prompt TEXT,
    character_post_history_instructions TEXT,
    character_personality TEXT,
    character_scenario TEXT,
    character_example_message TEXT,
    character_creator TEXT,
    character_version TEXT,
    character_nickname TEXT,
    character_view_screen TEXT,
    character_chat_page INTEGER,
    character_first_message_index INTEGER,
    character_utility_bot BOOLEAN,
    character_is_private BOOLEAN,
    character_realm_id TEXT,
    character_license TEXT,
    character_default_variables TEXT,
    character_additional_text TEXT,
    character_translator_note TEXT,
    character_background_html TEXT,
    character_background_css TEXT,
    character_creation_time BIGINT,
    character_modification_time BIGINT,
    character_last_interaction_time BIGINT,
    character_trash_time BIGINT,
    revision BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cold_archives_kind_updated_idx
ON cold.archives (kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS cold_archives_owner_idx
ON cold.archives (owner_character_id) WHERE owner_character_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS cold.archive_attributes (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (archive_id, key)
);

CREATE TABLE IF NOT EXISTS cold.field_presence (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('character', 'chat', 'message')),
    chat_position INTEGER NOT NULL DEFAULT -1,
    entity_position INTEGER NOT NULL DEFAULT -1,
    field_name TEXT NOT NULL,
    PRIMARY KEY (archive_id, entity_type, chat_position, entity_position, field_name)
);

CREATE TABLE IF NOT EXISTS cold.character_tags (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.character_greetings (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    greeting_type TEXT NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (archive_id, greeting_type, position)
);

CREATE TABLE IF NOT EXISTS cold.character_biases (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    phrase TEXT NOT NULL,
    bias DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.character_emotions (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    emotion TEXT NOT NULL,
    asset TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.character_modules (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    module_id TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.group_members (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    character_id TEXT NOT NULL,
    talk_weight DOUBLE PRECISION,
    active BOOLEAN,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.chat_folders (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    folder_id TEXT NOT NULL,
    name TEXT,
    color TEXT,
    folded BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.character_scripts (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    script_kind TEXT NOT NULL CHECK (script_kind IN ('custom', 'trigger')),
    position INTEGER NOT NULL,
    comment TEXT,
    input_text TEXT,
    output_text TEXT,
    script_type TEXT,
    flag TEXT,
    able_flag BOOLEAN,
    trigger_payload JSONB,
    PRIMARY KEY (archive_id, script_kind, position)
);

CREATE TABLE IF NOT EXISTS cold.character_sd_data (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.character_assets (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    asset_source TEXT NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
    asset_type TEXT,
    uri TEXT,
    name TEXT,
    extension TEXT,
    extra_value TEXT,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.character_lore_entries (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    lore_id TEXT,
    primary_key TEXT NOT NULL DEFAULT '',
    secondary_key TEXT NOT NULL DEFAULT '',
    insert_order INTEGER NOT NULL DEFAULT 0,
    comment TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'normal',
    always_active BOOLEAN NOT NULL DEFAULT FALSE,
    selective BOOLEAN NOT NULL DEFAULT FALSE,
    case_sensitive BOOLEAN,
    activation_percent DOUBLE PRECISION,
    use_regex BOOLEAN,
    book_version INTEGER,
    folder TEXT,
    cache_payload JSONB,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.chats (
    archive_id UUID NOT NULL REFERENCES cold.archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    original_chat_id TEXT,
    name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    sd_data TEXT,
    supa_memory_data TEXT,
    last_memory TEXT,
    is_streaming BOOLEAN,
    streaming_optimization_mode TEXT,
    bound_persona_id TEXT,
    first_message_index INTEGER,
    folder_id TEXT,
    last_message_time BIGINT,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS cold.chat_attributes (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, key),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.chat_suggestions (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.chat_modules (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    module_id TEXT NOT NULL,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.chat_script_state (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'boolean')),
    text_value TEXT,
    number_value DOUBLE PRECISION,
    boolean_value BOOLEAN,
    PRIMARY KEY (archive_id, chat_position, key),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.chat_bookmarks (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.chat_memory (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    memory_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, memory_type),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.chat_lore_entries (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    lore_id TEXT,
    primary_key TEXT NOT NULL DEFAULT '',
    secondary_key TEXT NOT NULL DEFAULT '',
    insert_order INTEGER NOT NULL DEFAULT 0,
    comment TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL DEFAULT 'normal',
    always_active BOOLEAN NOT NULL DEFAULT FALSE,
    selective BOOLEAN NOT NULL DEFAULT FALSE,
    case_sensitive BOOLEAN,
    activation_percent DOUBLE PRECISION,
    use_regex BOOLEAN,
    book_version INTEGER,
    folder TEXT,
    cache_payload JSONB,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.messages (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    original_message_id TEXT,
    role TEXT NOT NULL CHECK (role IN ('user', 'char')),
    content_text TEXT,
    content_binary BYTEA,
    saying_character_id TEXT,
    sent_time BIGINT,
    sender_name TEXT,
    other_user BOOLEAN,
    disabled_scope TEXT CHECK (disabled_scope IN ('false', 'true', 'allBefore')),
    is_comment BOOLEAN,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold.chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK ((content_text IS NULL) <> (content_binary IS NULL))
);

CREATE INDEX IF NOT EXISTS cold_messages_role_idx ON cold.messages (role);
CREATE INDEX IF NOT EXISTS cold_messages_content_fts_idx
ON cold.messages USING GIN (to_tsvector('simple', COALESCE(content_text, '')));

CREATE TABLE IF NOT EXISTS cold.message_attributes (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, message_position, key),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold.messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.message_generation (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    model TEXT,
    generation_id TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    max_context INTEGER,
    stage1_time DOUBLE PRECISION,
    stage2_time DOUBLE PRECISION,
    stage3_time DOUBLE PRECISION,
    stage4_time DOUBLE PRECISION,
    PRIMARY KEY (archive_id, chat_position, message_position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold.messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS cold_message_generation_model_idx
ON cold.message_generation (model) WHERE model IS NOT NULL;

CREATE TABLE IF NOT EXISTS cold.message_prompt_info (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    prompt_name TEXT,
    PRIMARY KEY (archive_id, chat_position, message_position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold.messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.message_prompt_toggles (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    toggle_key TEXT NOT NULL,
    toggle_value TEXT,
    PRIMARY KEY (archive_id, chat_position, message_position, position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold.messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.message_prompt_items (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    payload JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, message_position, position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold.messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS cold.legacy_imports (
    id UUID PRIMARY KEY,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW chat.all_messages AS
SELECT
    'active'::TEXT AS storage_state,
    NULL::UUID AS archive_id,
    chat_id,
    id AS message_id,
    position,
    role,
    content_text,
    content_binary,
    sent_time,
    sender_name
FROM chat.messages
UNION ALL
SELECT
    'cold'::TEXT AS storage_state,
    archive_id,
    NULL::TEXT AS chat_id,
    original_message_id AS message_id,
    position,
    role,
    content_text,
    content_binary,
    sent_time,
    sender_name
FROM cold.messages;

DO $$
DECLARE
    audited_target TEXT[];
    schema_name TEXT;
    tbl_name TEXT;
BEGIN
    FOREACH audited_target SLICE 1 IN ARRAY ARRAY[
        ARRAY['system', 'settings'],
        ARRAY['system', 'setting_values'],
        ARRAY['system', 'bot_presets'],
        ARRAY['system', 'personas'],
        ARRAY['system', 'modules'],
        ARRAY['system', 'plugins'],
        ARRAY['system', 'global_lorebooks'],
        ARRAY['system', 'global_lore_entries'],
        ARRAY['system', 'global_lore_cache_items'],
        ARRAY['system', 'translator_presets'],
        ARRAY['system', 'hotkeys'],
        ARRAY['system', 'custom_models'],
        ARRAY['system', 'custom_model_flags'],
        ARRAY['system', 'loadouts'],
        ARRAY['system', 'loadout_character_refs'],
        ARRAY['system', 'loadout_module_refs'],
        ARRAY['system', 'loadout_variables'],
        ARRAY['system', 'loadout_icons'],
        ARRAY['system', 'custom_sidebar_items'],
        ARRAY['system', 'ordered_text_settings'],
        ARRAY['system', 'ordered_number_settings'],
        ARRAY['system', 'string_map_settings'],
        ARRAY['system', 'bias_entries'],
        ARRAY['system', 'additional_parameters'],
        ARRAY['system', 'fallback_models'],
        ARRAY['system', 'openrouter_provider_rules'],
        ARRAY['character', 'characters'],
        ARRAY['character', 'attributes'],
        ARRAY['character', 'tags'],
        ARRAY['character', 'greetings'],
        ARRAY['character', 'biases'],
        ARRAY['character', 'emotions'],
        ARRAY['character', 'modules'],
        ARRAY['character', 'group_members'],
        ARRAY['character', 'chat_folders'],
        ARRAY['character', 'scripts'],
        ARRAY['character', 'sd_data'],
        ARRAY['character', 'assets'],
        ARRAY['character', 'lore_entries'],
        ARRAY['chat', 'chats'],
        ARRAY['chat', 'attributes'],
        ARRAY['chat', 'suggestions'],
        ARRAY['chat', 'modules'],
        ARRAY['chat', 'script_state'],
        ARRAY['chat', 'bookmarks'],
        ARRAY['chat', 'memory'],
        ARRAY['chat', 'lore_entries'],
        ARRAY['chat', 'messages'],
        ARRAY['chat', 'message_attributes'],
        ARRAY['chat', 'message_generation'],
        ARRAY['chat', 'message_prompt_info'],
        ARRAY['chat', 'message_prompt_toggles'],
        ARRAY['chat', 'message_prompt_items'],
        ARRAY['cold', 'archives'],
        ARRAY['cold', 'archive_attributes'],
        ARRAY['cold', 'field_presence'],
        ARRAY['cold', 'character_tags'],
        ARRAY['cold', 'character_greetings'],
        ARRAY['cold', 'character_biases'],
        ARRAY['cold', 'character_emotions'],
        ARRAY['cold', 'character_modules'],
        ARRAY['cold', 'group_members'],
        ARRAY['cold', 'chat_folders'],
        ARRAY['cold', 'character_scripts'],
        ARRAY['cold', 'character_sd_data'],
        ARRAY['cold', 'character_assets'],
        ARRAY['cold', 'character_lore_entries'],
        ARRAY['cold', 'chats'],
        ARRAY['cold', 'chat_attributes'],
        ARRAY['cold', 'chat_suggestions'],
        ARRAY['cold', 'chat_modules'],
        ARRAY['cold', 'chat_script_state'],
        ARRAY['cold', 'chat_bookmarks'],
        ARRAY['cold', 'chat_memory'],
        ARRAY['cold', 'chat_lore_entries'],
        ARRAY['cold', 'messages'],
        ARRAY['cold', 'message_attributes'],
        ARRAY['cold', 'message_generation'],
        ARRAY['cold', 'message_prompt_info'],
        ARRAY['cold', 'message_prompt_toggles'],
        ARRAY['cold', 'message_prompt_items']
    ] LOOP
        schema_name := audited_target[1];
        tbl_name := audited_target[2];
        EXECUTE format('DROP TRIGGER IF EXISTS audit_change ON %I.%I', schema_name, tbl_name);
        EXECUTE format(
            'CREATE TRIGGER audit_change AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
            'FOR EACH ROW EXECUTE FUNCTION system.record_row_change()',
            schema_name, tbl_name
        );
    END LOOP;
END $$;
