DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'risu_chats'
          AND column_name = 'data'
    ) THEN
        RAISE EXCEPTION 'The unreleased JSON-document PostgreSQL layout is incompatible with the relational layout'
            USING HINT = 'Back up if needed, then recreate the development PostgreSQL volume before restarting Risuai.';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'risu_settings'
          AND column_name = 'json_value'
    ) THEN
        RAISE EXCEPTION 'The unreleased JSON settings layout is incompatible with relational settings'
            USING HINT = 'Recreate the development PostgreSQL volume before restarting Risuai.';
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS risu_storage_meta (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    schema_version INTEGER NOT NULL DEFAULT 2,
    schema_layout TEXT NOT NULL DEFAULT 'relational-v1',
    revision BIGINT NOT NULL DEFAULT 0,
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO risu_storage_meta (singleton, schema_version, schema_layout)
VALUES (TRUE, 2, 'relational-v1')
ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS risu_revisions (
    id BIGSERIAL PRIMARY KEY,
    storage_revision BIGINT,
    database_initialized BOOLEAN,
    scope TEXT NOT NULL CHECK (scope IN ('database', 'cold-storage', 'restore')),
    action TEXT NOT NULL,
    restored_from_revision BIGINT REFERENCES risu_revisions(id) DEFERRABLE INITIALLY DEFERRED,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS risu_revisions_created_idx
ON risu_revisions (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS risu_audit_log (
    sequence BIGSERIAL PRIMARY KEY,
    revision_id BIGINT NOT NULL REFERENCES risu_revisions(id) ON DELETE CASCADE,
    table_name TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    before_row JSONB,
    after_row JSONB,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS risu_audit_revision_sequence_idx
ON risu_audit_log (revision_id DESC, sequence DESC);

CREATE INDEX IF NOT EXISTS risu_audit_table_revision_idx
ON risu_audit_log (table_name, revision_id DESC);

CREATE OR REPLACE FUNCTION risu_record_row_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    current_revision TEXT;
BEGIN
    current_revision := current_setting('risu.revision_id', TRUE);
    IF current_revision IS NULL OR current_revision = '' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    INSERT INTO risu_audit_log (revision_id, table_name, operation, before_row, after_row)
    VALUES (
        current_revision::BIGINT,
        TG_TABLE_NAME,
        TG_OP,
        CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) ELSE NULL END,
        CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) ELSE NULL END
    );
    RETURN COALESCE(NEW, OLD);
END $$;

CREATE TABLE IF NOT EXISTS risu_settings (
    key TEXT PRIMARY KEY,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS risu_setting_values (
    setting_key TEXT NOT NULL REFERENCES risu_settings(key)
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
        REFERENCES risu_setting_values(setting_key, node_id)
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

CREATE INDEX IF NOT EXISTS risu_setting_values_parent_idx
ON risu_setting_values (setting_key, parent_node_id, position);

CREATE INDEX IF NOT EXISTS risu_setting_values_member_idx
ON risu_setting_values (setting_key, member_key)
WHERE member_key IS NOT NULL;

-- text_value can hold arbitrarily large setting strings (prompts, jailbreaks,
-- etc.) that exceed the btree index row limit, so it cannot be indexed directly.
-- The index is unused by the storage layer; drop any legacy copy that predates
-- this fix so large values no longer fail to insert.
DROP INDEX IF EXISTS risu_setting_values_text_idx;

CREATE TABLE IF NOT EXISTS risu_bot_presets (
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
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_bot_presets_model_idx
ON risu_bot_presets (api_type, ai_model);

CREATE TABLE IF NOT EXISTS risu_personas (
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
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_personas_id_idx
ON risu_personas (persona_id) WHERE persona_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS risu_modules (
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
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_modules_id_idx
ON risu_modules (module_id) WHERE module_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS risu_plugins (
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
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_plugins_name_idx ON risu_plugins (name);

CREATE TABLE IF NOT EXISTS risu_global_lorebooks (
    setting_key TEXT NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_global_lore_entries (
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
        REFERENCES risu_global_lorebooks(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_global_lore_primary_idx
ON risu_global_lore_entries (primary_key);

CREATE INDEX IF NOT EXISTS risu_global_lore_content_fts_idx
ON risu_global_lore_entries USING GIN (to_tsvector('simple', COALESCE(content, '')));

CREATE TABLE IF NOT EXISTS risu_global_lore_cache_items (
    setting_key TEXT NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
    book_position INTEGER NOT NULL,
    lore_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, book_position, lore_position, position),
    FOREIGN KEY (setting_key, book_position, lore_position)
        REFERENCES risu_global_lore_entries(setting_key, book_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_translator_presets (
    setting_key TEXT NOT NULL DEFAULT 'translatorPresets' CHECK (setting_key = 'translatorPresets'),
    position INTEGER NOT NULL CHECK (position >= 0),
    name TEXT,
    prompt TEXT,
    max_response INTEGER,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_hotkeys (
    setting_key TEXT NOT NULL DEFAULT 'hotkeys' CHECK (setting_key = 'hotkeys'),
    position INTEGER NOT NULL CHECK (position >= 0),
    key TEXT,
    control BOOLEAN,
    shift BOOLEAN,
    alt BOOLEAN,
    action TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_hotkeys_action_idx ON risu_hotkeys (action);

CREATE TABLE IF NOT EXISTS risu_custom_models (
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
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_custom_models_id_idx
ON risu_custom_models (id) WHERE id IS NOT NULL;

CREATE TABLE IF NOT EXISTS risu_custom_model_flags (
    setting_key TEXT NOT NULL DEFAULT 'customModels' CHECK (setting_key = 'customModels'),
    model_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    flag INTEGER NOT NULL,
    PRIMARY KEY (setting_key, model_position, position),
    FOREIGN KEY (setting_key, model_position)
        REFERENCES risu_custom_models(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_loadouts (
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
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_loadouts_last_used_idx
ON risu_loadouts (last_used DESC) WHERE last_used IS NOT NULL;

CREATE TABLE IF NOT EXISTS risu_loadout_character_refs (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    character_id TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES risu_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_loadout_character_idx
ON risu_loadout_character_refs (character_id);

CREATE TABLE IF NOT EXISTS risu_loadout_module_refs (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES risu_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_loadout_module_idx ON risu_loadout_module_refs (module_id);

CREATE TABLE IF NOT EXISTS risu_loadout_variables (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, key),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES risu_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_loadout_icons (
    setting_key TEXT NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    asset_id TEXT NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES risu_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_custom_sidebar_items (
    setting_key TEXT NOT NULL DEFAULT 'customSidebarItems' CHECK (setting_key = 'customSidebarItems'),
    position INTEGER NOT NULL CHECK (position >= 0),
    id TEXT,
    item_type TEXT,
    subtype TEXT,
    label TEXT,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_ordered_text_settings (
    setting_key TEXT NOT NULL CHECK (setting_key IN (
        'formatingOrder', 'localStopStrings', 'enabledModules', 'banCharacterset', 'modelTools'
    )),
    position INTEGER NOT NULL CHECK (position >= 0),
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_ordered_text_value_idx
ON risu_ordered_text_settings (setting_key, value);

CREATE TABLE IF NOT EXISTS risu_ordered_number_settings (
    setting_key TEXT NOT NULL CHECK (setting_key = 'customFlags'),
    position INTEGER NOT NULL CHECK (position >= 0),
    value DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_string_map_settings (
    setting_key TEXT NOT NULL CHECK (setting_key IN (
        'globalChatVariables', 'OaiCompAPIKeys', 'seperateModels'
    )),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, key),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_bias_entries (
    setting_key TEXT NOT NULL DEFAULT 'bias' CHECK (setting_key = 'bias'),
    position INTEGER NOT NULL CHECK (position >= 0),
    phrase TEXT NOT NULL,
    bias DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_bias_phrase_idx ON risu_bias_entries (phrase);

CREATE TABLE IF NOT EXISTS risu_additional_parameters (
    setting_key TEXT NOT NULL DEFAULT 'additionalParams' CHECK (setting_key = 'additionalParams'),
    position INTEGER NOT NULL CHECK (position >= 0),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_fallback_models (
    setting_key TEXT NOT NULL DEFAULT 'fallbackModels' CHECK (setting_key = 'fallbackModels'),
    category TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    model TEXT NOT NULL,
    PRIMARY KEY (setting_key, category, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_fallback_model_idx ON risu_fallback_models (model);

CREATE TABLE IF NOT EXISTS risu_openrouter_provider_rules (
    setting_key TEXT NOT NULL DEFAULT 'openrouterProvider' CHECK (setting_key = 'openrouterProvider'),
    rule_type TEXT NOT NULL CHECK (rule_type IN ('order', 'only', 'ignore')),
    position INTEGER NOT NULL CHECK (position >= 0),
    provider TEXT NOT NULL,
    PRIMARY KEY (setting_key, rule_type, position),
    FOREIGN KEY (setting_key) REFERENCES risu_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_openrouter_provider_idx
ON risu_openrouter_provider_rules (provider, rule_type);

CREATE TABLE IF NOT EXISTS risu_characters (
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

CREATE INDEX IF NOT EXISTS risu_characters_position_idx ON risu_characters (position);
CREATE INDEX IF NOT EXISTS risu_characters_kind_position_idx ON risu_characters (kind, position);
CREATE INDEX IF NOT EXISTS risu_characters_lower_name_idx ON risu_characters (LOWER(name));

CREATE TABLE IF NOT EXISTS risu_character_attributes (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (character_id, key)
);

CREATE INDEX IF NOT EXISTS risu_character_attributes_value_gin_idx
ON risu_character_attributes USING GIN (value jsonb_path_ops);

CREATE TABLE IF NOT EXISTS risu_character_tags (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    tag TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX IF NOT EXISTS risu_character_tags_tag_idx ON risu_character_tags (tag);

CREATE TABLE IF NOT EXISTS risu_character_greetings (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    greeting_type TEXT NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
    position INTEGER NOT NULL CHECK (position >= 0),
    content TEXT NOT NULL,
    PRIMARY KEY (character_id, greeting_type, position)
);

CREATE TABLE IF NOT EXISTS risu_character_biases (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    phrase TEXT NOT NULL,
    bias DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS risu_character_emotions (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    emotion TEXT NOT NULL,
    asset TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS risu_character_modules (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX IF NOT EXISTS risu_character_modules_module_idx ON risu_character_modules (module_id);

CREATE TABLE IF NOT EXISTS risu_group_members (
    group_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    character_id TEXT NOT NULL,
    talk_weight DOUBLE PRECISION,
    active BOOLEAN,
    PRIMARY KEY (group_id, position)
);

CREATE INDEX IF NOT EXISTS risu_group_members_character_idx ON risu_group_members (character_id);

CREATE TABLE IF NOT EXISTS risu_chat_folders (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    folder_id TEXT NOT NULL,
    name TEXT,
    color TEXT,
    folded BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (character_id, position),
    UNIQUE (character_id, folder_id)
);

CREATE TABLE IF NOT EXISTS risu_character_scripts (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE TABLE IF NOT EXISTS risu_character_sd_data (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS risu_character_assets (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    asset_source TEXT NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
    asset_type TEXT,
    uri TEXT,
    name TEXT,
    extension TEXT,
    extra_value TEXT,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE IF NOT EXISTS risu_character_lore_entries (
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE INDEX IF NOT EXISTS risu_character_lore_primary_key_idx
ON risu_character_lore_entries (primary_key);

CREATE TABLE IF NOT EXISTS risu_chats (
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL REFERENCES risu_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE INDEX IF NOT EXISTS risu_chats_character_position_idx
ON risu_chats (character_id, position);

CREATE INDEX IF NOT EXISTS risu_chats_folder_idx
ON risu_chats (character_id, folder_id) WHERE folder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS risu_chats_last_message_idx
ON risu_chats (last_message_time DESC) WHERE last_message_time IS NOT NULL;

CREATE INDEX IF NOT EXISTS risu_chats_lower_name_idx ON risu_chats (LOWER(name));

CREATE TABLE IF NOT EXISTS risu_chat_attributes (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (chat_id, key)
);

CREATE TABLE IF NOT EXISTS risu_chat_suggestions (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    content TEXT NOT NULL,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE IF NOT EXISTS risu_chat_modules (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id TEXT NOT NULL,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE IF NOT EXISTS risu_chat_script_state (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE TABLE IF NOT EXISTS risu_chat_bookmarks (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    message_id TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (chat_id, position)
);

CREATE INDEX IF NOT EXISTS risu_chat_bookmarks_message_idx
ON risu_chat_bookmarks (chat_id, message_id);

CREATE TABLE IF NOT EXISTS risu_chat_memory (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    memory_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (chat_id, memory_type)
);

CREATE TABLE IF NOT EXISTS risu_chat_lore_entries (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE TABLE IF NOT EXISTS risu_messages (
    chat_id TEXT NOT NULL REFERENCES risu_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE INDEX IF NOT EXISTS risu_messages_chat_position_idx
ON risu_messages (chat_id, position);

CREATE INDEX IF NOT EXISTS risu_messages_role_idx ON risu_messages (role);
CREATE INDEX IF NOT EXISTS risu_messages_sent_time_idx ON risu_messages (sent_time DESC)
WHERE sent_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS risu_messages_content_fts_idx
ON risu_messages USING GIN (to_tsvector('simple', COALESCE(content_text, '')));

CREATE TABLE IF NOT EXISTS risu_message_attributes (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (chat_id, message_id, key),
    FOREIGN KEY (chat_id, message_id) REFERENCES risu_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_message_generation (
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
    FOREIGN KEY (chat_id, message_id) REFERENCES risu_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_message_generation_model_idx
ON risu_message_generation (model) WHERE model IS NOT NULL;

CREATE TABLE IF NOT EXISTS risu_message_prompt_info (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    prompt_name TEXT,
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES risu_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_message_prompt_toggles (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    toggle_key TEXT NOT NULL,
    toggle_value TEXT,
    PRIMARY KEY (chat_id, message_id, position),
    FOREIGN KEY (chat_id, message_id) REFERENCES risu_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_message_prompt_items (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    payload JSONB NOT NULL,
    PRIMARY KEY (chat_id, message_id, position),
    FOREIGN KEY (chat_id, message_id) REFERENCES risu_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_archives (
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

CREATE INDEX IF NOT EXISTS risu_cold_archives_kind_updated_idx
ON risu_cold_archives (kind, updated_at DESC);

CREATE INDEX IF NOT EXISTS risu_cold_archives_owner_idx
ON risu_cold_archives (owner_character_id) WHERE owner_character_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS risu_cold_archive_attributes (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (archive_id, key)
);

CREATE TABLE IF NOT EXISTS risu_cold_field_presence (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('character', 'chat', 'message')),
    chat_position INTEGER NOT NULL DEFAULT -1,
    entity_position INTEGER NOT NULL DEFAULT -1,
    field_name TEXT NOT NULL,
    PRIMARY KEY (archive_id, entity_type, chat_position, entity_position, field_name)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_tags (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_greetings (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    greeting_type TEXT NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (archive_id, greeting_type, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_biases (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    phrase TEXT NOT NULL,
    bias DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_emotions (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    emotion TEXT NOT NULL,
    asset TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_modules (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    module_id TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_group_members (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    character_id TEXT NOT NULL,
    talk_weight DOUBLE PRECISION,
    active BOOLEAN,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_chat_folders (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    folder_id TEXT NOT NULL,
    name TEXT,
    color TEXT,
    folded BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_scripts (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE TABLE IF NOT EXISTS risu_cold_character_sd_data (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_assets (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    asset_source TEXT NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
    asset_type TEXT,
    uri TEXT,
    name TEXT,
    extension TEXT,
    extra_value TEXT,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE IF NOT EXISTS risu_cold_character_lore_entries (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE TABLE IF NOT EXISTS risu_cold_chats (
    archive_id UUID NOT NULL REFERENCES risu_cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
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

CREATE TABLE IF NOT EXISTS risu_cold_chat_attributes (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, key),
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_chat_suggestions (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_chat_modules (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    module_id TEXT NOT NULL,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_chat_script_state (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('text', 'number', 'boolean')),
    text_value TEXT,
    number_value DOUBLE PRECISION,
    boolean_value BOOLEAN,
    PRIMARY KEY (archive_id, chat_position, key),
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_chat_bookmarks (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    name TEXT,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_chat_memory (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    memory_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, memory_type),
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_chat_lore_entries (
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
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_messages (
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
    FOREIGN KEY (archive_id, chat_position) REFERENCES risu_cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK ((content_text IS NULL) <> (content_binary IS NULL))
);

CREATE INDEX IF NOT EXISTS risu_cold_messages_role_idx ON risu_cold_messages (role);
CREATE INDEX IF NOT EXISTS risu_cold_messages_content_fts_idx
ON risu_cold_messages USING GIN (to_tsvector('simple', COALESCE(content_text, '')));

CREATE TABLE IF NOT EXISTS risu_cold_message_attributes (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, message_position, key),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES risu_cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_message_generation (
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
        REFERENCES risu_cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS risu_cold_message_generation_model_idx
ON risu_cold_message_generation (model) WHERE model IS NOT NULL;

CREATE TABLE IF NOT EXISTS risu_cold_message_prompt_info (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    prompt_name TEXT,
    PRIMARY KEY (archive_id, chat_position, message_position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES risu_cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_message_prompt_toggles (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    toggle_key TEXT NOT NULL,
    toggle_value TEXT,
    PRIMARY KEY (archive_id, chat_position, message_position, position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES risu_cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- The legacy save format permits a prompt toggle to explicitly contain null.
-- Keep this idempotent ALTER for relational-v1 databases created before that case was discovered.
ALTER TABLE risu_message_prompt_toggles
ALTER COLUMN toggle_value DROP NOT NULL;

ALTER TABLE risu_cold_message_prompt_toggles
ALTER COLUMN toggle_value DROP NOT NULL;

CREATE TABLE IF NOT EXISTS risu_cold_message_prompt_items (
    archive_id UUID NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    payload JSONB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, message_position, position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES risu_cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE IF NOT EXISTS risu_cold_storage_legacy_imports (
    id UUID PRIMARY KEY,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE VIEW risu_all_messages AS
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
FROM risu_messages
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
FROM risu_cold_messages;

DO $$
DECLARE
    audited_table TEXT;
BEGIN
    FOREACH audited_table IN ARRAY ARRAY[
        'risu_settings',
        'risu_setting_values',
        'risu_bot_presets',
        'risu_personas',
        'risu_modules',
        'risu_plugins',
        'risu_global_lorebooks',
        'risu_global_lore_entries',
        'risu_global_lore_cache_items',
        'risu_translator_presets',
        'risu_hotkeys',
        'risu_custom_models',
        'risu_custom_model_flags',
        'risu_loadouts',
        'risu_loadout_character_refs',
        'risu_loadout_module_refs',
        'risu_loadout_variables',
        'risu_loadout_icons',
        'risu_custom_sidebar_items',
        'risu_ordered_text_settings',
        'risu_ordered_number_settings',
        'risu_string_map_settings',
        'risu_bias_entries',
        'risu_additional_parameters',
        'risu_fallback_models',
        'risu_openrouter_provider_rules',
        'risu_characters',
        'risu_character_attributes',
        'risu_character_tags',
        'risu_character_greetings',
        'risu_character_biases',
        'risu_character_emotions',
        'risu_character_modules',
        'risu_group_members',
        'risu_chat_folders',
        'risu_character_scripts',
        'risu_character_sd_data',
        'risu_character_assets',
        'risu_character_lore_entries',
        'risu_chats',
        'risu_chat_attributes',
        'risu_chat_suggestions',
        'risu_chat_modules',
        'risu_chat_script_state',
        'risu_chat_bookmarks',
        'risu_chat_memory',
        'risu_chat_lore_entries',
        'risu_messages',
        'risu_message_attributes',
        'risu_message_generation',
        'risu_message_prompt_info',
        'risu_message_prompt_toggles',
        'risu_message_prompt_items',
        'risu_cold_archives',
        'risu_cold_archive_attributes',
        'risu_cold_field_presence',
        'risu_cold_character_tags',
        'risu_cold_character_greetings',
        'risu_cold_character_biases',
        'risu_cold_character_emotions',
        'risu_cold_character_modules',
        'risu_cold_group_members',
        'risu_cold_chat_folders',
        'risu_cold_character_scripts',
        'risu_cold_character_sd_data',
        'risu_cold_character_assets',
        'risu_cold_character_lore_entries',
        'risu_cold_chats',
        'risu_cold_chat_attributes',
        'risu_cold_chat_suggestions',
        'risu_cold_chat_modules',
        'risu_cold_chat_script_state',
        'risu_cold_chat_bookmarks',
        'risu_cold_chat_memory',
        'risu_cold_chat_lore_entries',
        'risu_cold_messages',
        'risu_cold_message_attributes',
        'risu_cold_message_generation',
        'risu_cold_message_prompt_info',
        'risu_cold_message_prompt_toggles',
        'risu_cold_message_prompt_items'
    ] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS risu_audit_change ON %I', audited_table);
        EXECUTE format(
            'CREATE TRIGGER risu_audit_change AFTER INSERT OR UPDATE OR DELETE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION risu_record_row_change()',
            audited_table
        );
    END LOOP;
END $$;
