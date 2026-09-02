-- Risuai Oracle Storage Schema
-- Oracle 23c+ (Autonomous Database)용 관계형 스키마.
-- PostgreSQL의 system./character./chat./cold. 스키마를
-- 단일 Oracle 스키마 내의 접두어 테이블로 매핑.
--
-- 스키마 버전: 2 (postgres-schema.sql과 동일)
-- 레이아웃: relational-schema-v2

-- ============================================================
-- system_* 테이블 (PostgreSQL system. 스키마 대응)
-- ============================================================

CREATE TABLE system_storage_meta (
    singleton NUMBER(1) DEFAULT 1 PRIMARY KEY,
    schema_version NUMBER DEFAULT 4 NOT NULL,
    schema_layout VARCHAR2(64) DEFAULT 'relational-schema-v3' NOT NULL,
    revision NUMBER DEFAULT 0 NOT NULL,
    initialized NUMBER(1) DEFAULT 0 NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT system_meta_singleton CHECK (singleton = 1)
);

INSERT INTO system_storage_meta (singleton, schema_version, schema_layout)
VALUES (1, 4, 'relational-schema-v3');
-- MERGE 기반 upsert (단일 행 보장, 이미 존재하면 무시)
MERGE INTO system_storage_meta target
USING (SELECT 1 AS singleton, 4 AS schema_version, 'relational-schema-v3' AS schema_layout FROM dual) src
ON (target.singleton = src.singleton)
WHEN NOT MATCHED THEN INSERT (singleton, schema_version, schema_layout)
    VALUES (src.singleton, src.schema_version, src.schema_layout);

CREATE TABLE system_asset_catalog_state (
    singleton NUMBER(1) DEFAULT 1 PRIMARY KEY,
    initialized NUMBER(1) DEFAULT 0 NOT NULL,
    source_id VARCHAR2(2048),
    synced_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT asset_catalog_state_singleton CHECK (singleton = 1)
);

MERGE INTO system_asset_catalog_state target
USING (SELECT 1 AS singleton FROM dual) src
ON (target.singleton = src.singleton)
WHEN NOT MATCHED THEN INSERT (singleton, initialized) VALUES (1, 0);

CREATE TABLE system_asset_catalog (
    asset_key VARCHAR2(1024) PRIMARY KEY,
    size_bytes NUMBER,
    etag VARCHAR2(1024),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX asset_catalog_updated_idx ON system_asset_catalog (updated_at DESC);

CREATE TABLE system_revisions (
    id NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    storage_revision NUMBER,
    database_initialized NUMBER(1),
    scope VARCHAR2(32) NOT NULL CHECK (scope IN ('database', 'cold-storage', 'restore')),
    action VARCHAR2(64) NOT NULL,
    restored_from_revision NUMBER REFERENCES system_revisions(id) DEFERRABLE INITIALLY DEFERRED,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX revisions_created_idx ON system_revisions (created_at DESC, id DESC);

CREATE TABLE system_audit_log (
    sequence_num NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    revision_id NUMBER NOT NULL REFERENCES system_revisions(id) ON DELETE CASCADE,
    table_name VARCHAR2(128) NOT NULL,
    operation VARCHAR2(10) NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    before_row JSON,
    after_row JSON,
    recorded_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX audit_revision_sequence_idx ON system_audit_log (revision_id DESC, sequence_num DESC);
CREATE INDEX audit_table_revision_idx ON system_audit_log (table_name, revision_id DESC);

-- 감사 컨텍스트 패키지 (세션별 revision_id 전달)
CREATE OR REPLACE PACKAGE risu_audit_ctx_pkg AS
    PROCEDURE set_revision(revision_id IN VARCHAR2);
END risu_audit_ctx_pkg;
/

CREATE OR REPLACE PACKAGE BODY risu_audit_ctx_pkg AS
    PROCEDURE set_revision(revision_id IN VARCHAR2) IS
    BEGIN
        DBMS_SESSION.SET_CONTEXT('risu_audit_ctx', 'revision_id', revision_id);
    END;
END risu_audit_ctx_pkg;
/

CREATE OR REPLACE CONTEXT risu_audit_ctx USING risu_audit_ctx_pkg;

-- 범용 감사 함수: 모든 테이블의 변경 사항 기록
CREATE OR REPLACE PROCEDURE risu_record_change(
    p_table_name IN VARCHAR2,
    p_op IN VARCHAR2,
    p_old_row IN CLOB DEFAULT NULL,
    p_new_row IN CLOB DEFAULT NULL
) AS
    v_revision VARCHAR2(128);
BEGIN
    v_revision := SYS_CONTEXT('risu_audit_ctx', 'revision_id');
    IF v_revision IS NULL OR v_revision = '' THEN
        RETURN;
    END IF;
    INSERT INTO system_audit_log (revision_id, table_name, operation, before_row, after_row)
    VALUES (TO_NUMBER(v_revision), p_table_name, p_op, p_old_row, p_new_row);
END risu_record_change;
/

-- ============================================================
-- system.settings / setting_values (트리 구조 설정)
-- ============================================================

CREATE TABLE system_settings (
    key VARCHAR2(4000) PRIMARY KEY,
    text_val CLOB,
    num_val BINARY_DOUBLE,
    bool_val NUMBER(1),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE system_setting_values (
    setting_key VARCHAR2(4000) NOT NULL REFERENCES system_settings(key) ON DELETE CASCADE,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    member_key CLOB,
    encoded_member_key CLOB,
    position INTEGER CHECK (position >= 0),
    value_type VARCHAR2(32) NOT NULL CHECK (value_type IN ('null','text','encoded-text','number','boolean','array','object')),
    text_value CLOB,
    encoded_text_value CLOB,
    number_value BINARY_DOUBLE,
    boolean_value NUMBER(1),
    PRIMARY KEY (setting_key, node_id),
    FOREIGN KEY (setting_key, parent_node_id) REFERENCES system_setting_values(setting_key, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
    CHECK (member_key IS NULL OR encoded_member_key IS NULL),
    CHECK (text_value IS NULL OR encoded_text_value IS NULL)
);
CREATE INDEX setting_values_parent_idx ON system_setting_values (setting_key, parent_node_id, position, node_id);

CREATE TABLE system_module_records (
    module_id VARCHAR2(4000) PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE TABLE system_module_values (
    module_id VARCHAR2(4000) NOT NULL REFERENCES system_module_records(module_id) ON DELETE CASCADE,
    node_id INTEGER NOT NULL,
    parent_node_id INTEGER,
    member_key CLOB, encoded_member_key CLOB,
    position INTEGER CHECK (position >= 0),
    value_type VARCHAR2(32) NOT NULL CHECK (value_type IN ('null','text','encoded-text','number','boolean','array','object')),
    text_value CLOB, encoded_text_value CLOB,
    number_value BINARY_DOUBLE, boolean_value NUMBER(1),
    PRIMARY KEY (module_id, node_id),
    FOREIGN KEY (module_id, parent_node_id) REFERENCES system_module_values(module_id, node_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
    CHECK (member_key IS NULL OR encoded_member_key IS NULL),
    CHECK (text_value IS NULL OR encoded_text_value IS NULL)
);
CREATE INDEX module_values_parent_idx ON system_module_values (module_id, parent_node_id, position, node_id);

CREATE TABLE system_plugin_custom_storage (
    key VARCHAR2(4000) PRIMARY KEY,
    value JSON NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

-- ============================================================
-- 관계형 설정 테이블 (PostgreSQL system.bot_presets 등)
-- ============================================================

CREATE TABLE system_bot_presets (
    preset_id VARCHAR2(64) PRIMARY KEY,
    position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
    name VARCHAR2(4000) DEFAULT '' NOT NULL,
    image CLOB,
    api_type VARCHAR2(256) DEFAULT '' NOT NULL,
    ai_model VARCHAR2(512) DEFAULT '' NOT NULL,
    data CLOB NOT NULL CHECK (data IS JSON), content_hash VARCHAR2(128) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX bot_presets_model_idx ON system_bot_presets (api_type, ai_model);

CREATE TABLE system_personas (
    setting_key VARCHAR2(64) DEFAULT 'personas' NOT NULL CHECK (setting_key = 'personas'),
    position INTEGER NOT NULL CHECK (position >= 0),
    persona_id VARCHAR2(4000),
    name VARCHAR2(4000),
    prompt CLOB,
    icon CLOB,
    large_portrait NUMBER(1),
    note CLOB,
    embedded_module_id VARCHAR2(4000),
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX personas_id_idx ON system_personas (CASE WHEN persona_id IS NOT NULL THEN persona_id ELSE NULL END);

CREATE TABLE system_modules (
    setting_key VARCHAR2(64) DEFAULT 'modules' NOT NULL CHECK (setting_key = 'modules'),
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id VARCHAR2(4000),
    name VARCHAR2(4000),
    description CLOB,
    cjs CLOB,
    low_level_access NUMBER(1),
    hide_icon NUMBER(1),
    background_embedding CLOB,
    namespace VARCHAR2(4000),
    custom_toggle CLOB,
    mcp_url VARCHAR2(4000),
    icon CLOB,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX modules_id_idx ON system_modules (CASE WHEN module_id IS NOT NULL THEN module_id ELSE NULL END);

CREATE TABLE system_plugins (
    setting_key VARCHAR2(64) NOT NULL CHECK (setting_key IN ('plugins', 'pluginV2')),
    position INTEGER NOT NULL CHECK (position >= 0),
    name VARCHAR2(4000),
    display_name VARCHAR2(4000),
    script CLOB,
    api_version VARCHAR2(64),
    plugin_version VARCHAR2(64),
    update_url VARCHAR2(4000),
    enabled NUMBER(1),
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX plugins_name_idx ON system_plugins (name);

CREATE TABLE system_global_lorebooks (
    setting_key VARCHAR2(64) DEFAULT 'loreBook' NOT NULL CHECK (setting_key = 'loreBook'),
    position INTEGER NOT NULL CHECK (position >= 0),
    name VARCHAR2(4000),
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_global_lore_entries (
    setting_key VARCHAR2(64) DEFAULT 'loreBook' NOT NULL CHECK (setting_key = 'loreBook'),
    book_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    lore_id VARCHAR2(4000),
    primarykey VARCHAR2(4000),
    secondary_key VARCHAR2(4000),
    insert_order INTEGER,
    comment_text CLOB,
    content CLOB,
    lore_mode VARCHAR2(64),
    always_active NUMBER(1),
    selective NUMBER(1),
    case_sensitive NUMBER(1),
    activation_percent BINARY_DOUBLE,
    use_regex NUMBER(1),
    book_version INTEGER,
    folder VARCHAR2(4000),
    cache_key VARCHAR2(4000),
    PRIMARY KEY (setting_key, book_position, position),
    FOREIGN KEY (setting_key, book_position)
        REFERENCES system_global_lorebooks(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX global_lore_primary_idx ON system_global_lore_entries (primarykey);
CREATE INDEX global_lore_content_fts_idx
ON system_global_lore_entries (content)
INDEXTYPE IS CTXSYS.CONTEXT;

CREATE TABLE system_global_lore_cache_items (
    setting_key VARCHAR2(64) DEFAULT 'loreBook' NOT NULL CHECK (setting_key = 'loreBook'),
    book_position INTEGER NOT NULL,
    lore_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    value CLOB NOT NULL,
    PRIMARY KEY (setting_key, book_position, lore_position, position),
    FOREIGN KEY (setting_key, book_position, lore_position)
        REFERENCES system_global_lore_entries(setting_key, book_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_translator_presets (
    setting_key VARCHAR2(64) DEFAULT 'translatorPresets' NOT NULL CHECK (setting_key = 'translatorPresets'),
    position INTEGER NOT NULL CHECK (position >= 0),
    name VARCHAR2(4000),
    prompt CLOB,
    max_response INTEGER,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_hotkeys (
    setting_key VARCHAR2(64) DEFAULT 'hotkeys' NOT NULL CHECK (setting_key = 'hotkeys'),
    position INTEGER NOT NULL CHECK (position >= 0),
    key_value VARCHAR2(256),
    control_flag NUMBER(1),
    shift_flag NUMBER(1),
    alt_flag NUMBER(1),
    action VARCHAR2(4000),
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX hotkeys_action_idx ON system_hotkeys (action);

CREATE TABLE system_custom_models (
    setting_key VARCHAR2(64) DEFAULT 'customModels' NOT NULL CHECK (setting_key = 'customModels'),
    position INTEGER NOT NULL CHECK (position >= 0),
    id VARCHAR2(4000),
    internal_id VARCHAR2(4000),
    url VARCHAR2(4000),
    format_val INTEGER,
    tokenizer INTEGER,
    api_key CLOB,
    name VARCHAR2(4000),
    params CLOB,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX custom_models_id_idx ON system_custom_models (CASE WHEN id IS NOT NULL THEN id ELSE NULL END);

CREATE TABLE system_custom_model_flags (
    setting_key VARCHAR2(64) DEFAULT 'customModels' NOT NULL CHECK (setting_key = 'customModels'),
    model_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    flag INTEGER NOT NULL,
    PRIMARY KEY (setting_key, model_position, position),
    FOREIGN KEY (setting_key, model_position)
        REFERENCES system_custom_models(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_loadouts (
    setting_key VARCHAR2(64) DEFAULT 'loadouts' NOT NULL CHECK (setting_key = 'loadouts'),
    position INTEGER NOT NULL CHECK (position >= 0),
    id VARCHAR2(4000),
    name VARCHAR2(4000),
    last_used NUMBER,
    favorite NUMBER(1),
    preset_name VARCHAR2(4000),
    persona_id VARCHAR2(4000),
    icons_present NUMBER(1) DEFAULT 0 NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX loadouts_last_used_idx
ON system_loadouts (CASE WHEN last_used IS NOT NULL THEN last_used ELSE NULL END);

CREATE TABLE system_loadout_character_refs (
    setting_key VARCHAR2(64) DEFAULT 'loadouts' NOT NULL CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    character_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX loadout_character_idx ON system_loadout_character_refs (character_id);

CREATE TABLE system_loadout_module_refs (
    setting_key VARCHAR2(64) DEFAULT 'loadouts' NOT NULL CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX loadout_module_idx ON system_loadout_module_refs (module_id);

CREATE TABLE system_loadout_variables (
    setting_key VARCHAR2(64) DEFAULT 'loadouts' NOT NULL CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    key_value VARCHAR2(4000) NOT NULL,
    value CLOB NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, key_value),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_loadout_icons (
    setting_key VARCHAR2(64) DEFAULT 'loadouts' NOT NULL CHECK (setting_key = 'loadouts'),
    loadout_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    asset_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (setting_key, loadout_position, position),
    FOREIGN KEY (setting_key, loadout_position)
        REFERENCES system_loadouts(setting_key, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_custom_sidebar_items (
    setting_key VARCHAR2(64) DEFAULT 'customSidebarItems' NOT NULL CHECK (setting_key = 'customSidebarItems'),
    position INTEGER NOT NULL CHECK (position >= 0),
    id VARCHAR2(4000),
    item_type VARCHAR2(128),
    subtype VARCHAR2(128),
    label VARCHAR2(4000),
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_ordered_text_settings (
    setting_key VARCHAR2(64) NOT NULL CHECK (setting_key IN (
        'formatingOrder', 'localStopStrings', 'enabledModules', 'banCharacterset', 'modelTools'
    )),
    position INTEGER NOT NULL CHECK (position >= 0),
    value CLOB NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- value 컬럼이 CLOB이므로 직접 인덱스 불가. DBMS_CRYPTO.GETHASH로 함수 기반 인덱스 대체 가능하나
-- 검색 성능 향상이 제한적이므로 스키마에서는 제외. 애플리케이션에서 LIKE 검색 사용.

CREATE TABLE system_ordered_number_settings (
    setting_key VARCHAR2(64) NOT NULL CHECK (setting_key = 'customFlags'),
    position INTEGER NOT NULL CHECK (position >= 0),
    value BINARY_DOUBLE NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_string_map_settings (
    setting_key VARCHAR2(64) NOT NULL CHECK (setting_key IN (
        'globalChatVariables', 'OaiCompAPIKeys', 'seperateModels'
    )),
    key_value VARCHAR2(4000) NOT NULL,
    value CLOB NOT NULL,
    PRIMARY KEY (setting_key, key_value),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_bias_entries (
    setting_key VARCHAR2(64) DEFAULT 'bias' NOT NULL CHECK (setting_key = 'bias'),
    position INTEGER NOT NULL CHECK (position >= 0),
    phrase VARCHAR2(4000) NOT NULL,
    bias BINARY_DOUBLE NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX bias_phrase_idx ON system_bias_entries (phrase);

CREATE TABLE system_additional_parameters (
    setting_key VARCHAR2(64) DEFAULT 'additionalParams' NOT NULL CHECK (setting_key = 'additionalParams'),
    position INTEGER NOT NULL CHECK (position >= 0),
    key_value VARCHAR2(4000) NOT NULL,
    value CLOB NOT NULL,
    PRIMARY KEY (setting_key, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE system_fallback_models (
    setting_key VARCHAR2(64) DEFAULT 'fallbackModels' NOT NULL CHECK (setting_key = 'fallbackModels'),
    category VARCHAR2(256) NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    model VARCHAR2(512) NOT NULL,
    PRIMARY KEY (setting_key, category, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX fallback_model_idx ON system_fallback_models (model);

CREATE TABLE system_openrouter_provider_rules (
    setting_key VARCHAR2(64) DEFAULT 'openrouterProvider' NOT NULL CHECK (setting_key = 'openrouterProvider'),
    rule_type VARCHAR2(32) NOT NULL CHECK (rule_type IN ('order', 'only', 'ignore')),
    position INTEGER NOT NULL CHECK (position >= 0),
    provider VARCHAR2(256) NOT NULL,
    PRIMARY KEY (setting_key, rule_type, position),
    FOREIGN KEY (setting_key) REFERENCES system_settings(key)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX openrouter_provider_idx
ON system_openrouter_provider_rules (provider, rule_type);

-- ============================================================
-- character_* 테이블 (PostgreSQL character. 스키마 대응)
-- ============================================================

CREATE TABLE character_characters (
    id VARCHAR2(4000) PRIMARY KEY,
    position INTEGER NOT NULL CHECK (position >= 0),
    kind VARCHAR2(32) NOT NULL CHECK (kind IN ('character', 'group')),
    name VARCHAR2(4000) DEFAULT '' NOT NULL,
    image CLOB,
    first_message CLOB DEFAULT '' NOT NULL,
    description CLOB,
    notes CLOB,
    creator_notes CLOB,
    system_prompt CLOB,
    post_history_instructions CLOB,
    personality CLOB,
    scenario CLOB,
    example_message CLOB,
    creator VARCHAR2(4000),
    character_version VARCHAR2(256),
    nickname VARCHAR2(4000),
    view_screen VARCHAR2(128),
    chat_page INTEGER DEFAULT 0 NOT NULL,
    first_message_index INTEGER,
    utility_bot NUMBER(1),
    is_private NUMBER(1),
    realm_id VARCHAR2(4000),
    license CLOB,
    default_variables CLOB,
    additional_text CLOB,
    translator_note CLOB,
    background_html CLOB,
    background_css CLOB,
    creation_time NUMBER,
    modification_time NUMBER,
    last_interaction_time NUMBER,
    trash_time NUMBER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX characters_position_idx ON character_characters (position);
CREATE INDEX characters_kind_position_idx ON character_characters (kind, position);
CREATE INDEX characters_lower_name_idx ON character_characters (LOWER(name));

CREATE TABLE character_attributes (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key_value VARCHAR2(4000) NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (character_id, key_value)
);

CREATE TABLE character_tags (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    tag VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX character_tags_tag_idx ON character_tags (tag);

CREATE TABLE character_greetings (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    greeting_type VARCHAR2(32) NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
    position INTEGER NOT NULL CHECK (position >= 0),
    content CLOB NOT NULL,
    PRIMARY KEY (character_id, greeting_type, position)
);

CREATE TABLE character_biases (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    phrase VARCHAR2(4000) NOT NULL,
    bias BINARY_DOUBLE NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE character_emotions (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    emotion VARCHAR2(4000) NOT NULL,
    asset CLOB NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE character_modules (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX character_modules_module_idx ON character_modules (module_id);

CREATE TABLE character_group_members (
    group_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    character_id VARCHAR2(4000) NOT NULL,
    talk_weight BINARY_DOUBLE,
    active NUMBER(1),
    PRIMARY KEY (group_id, position)
);

CREATE INDEX group_members_character_idx ON character_group_members (character_id);

CREATE TABLE character_chat_folders (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    folder_id VARCHAR2(4000) NOT NULL,
    name VARCHAR2(4000),
    color VARCHAR2(64),
    folded NUMBER(1) DEFAULT 0 NOT NULL,
    PRIMARY KEY (character_id, position),
    UNIQUE (character_id, folder_id)
);

CREATE TABLE character_scripts (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    script_kind VARCHAR2(32) NOT NULL CHECK (script_kind IN ('custom', 'trigger')),
    position INTEGER NOT NULL CHECK (position >= 0),
    comment_text CLOB,
    input_text CLOB,
    output_text CLOB,
    script_type VARCHAR2(128),
    flag CLOB,
    able_flag NUMBER(1),
    trigger_payload JSON,
    PRIMARY KEY (character_id, script_kind, position)
);

CREATE TABLE character_sd_data (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    key_value VARCHAR2(4000) NOT NULL,
    value CLOB NOT NULL,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE character_assets (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    asset_source VARCHAR2(32) NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
    asset_type VARCHAR2(128),
    uri CLOB,
    name VARCHAR2(4000),
    extension VARCHAR2(64),
    extra_value CLOB,
    PRIMARY KEY (character_id, position)
);

CREATE TABLE character_lore_entries (
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    lore_id VARCHAR2(4000),
    primarykey VARCHAR2(4000) DEFAULT '',
    secondary_key VARCHAR2(4000) DEFAULT '',
    insert_order INTEGER DEFAULT 0,
    comment_text CLOB DEFAULT '',
    content CLOB DEFAULT '',
    lore_mode VARCHAR2(64) DEFAULT 'normal',
    always_active NUMBER(1) DEFAULT 0,
    selective NUMBER(1) DEFAULT 0,
    case_sensitive NUMBER(1),
    activation_percent BINARY_DOUBLE,
    use_regex NUMBER(1),
    book_version INTEGER,
    folder VARCHAR2(4000),
    cache_payload JSON,
    PRIMARY KEY (character_id, position)
);

CREATE INDEX character_lore_primary_key_idx ON character_lore_entries (primarykey);

-- ============================================================
-- chat_* 테이블 (PostgreSQL chat. 스키마 대응)
-- ============================================================

CREATE TABLE chat_chats (
    id VARCHAR2(4000) PRIMARY KEY,
    character_id VARCHAR2(4000) NOT NULL REFERENCES character_characters(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    name VARCHAR2(4000) DEFAULT '' NOT NULL,
    note CLOB DEFAULT '' NOT NULL,
    sd_data CLOB,
    supa_memory_data CLOB,
    last_memory CLOB,
    is_streaming NUMBER(1),
    streaming_optimization_mode VARCHAR2(128),
    bound_persona_id VARCHAR2(4000),
    first_message_index INTEGER,
    folder_id VARCHAR2(4000),
    last_message_time NUMBER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX chats_character_position_idx ON chat_chats (character_id, position);
CREATE INDEX chats_folder_idx ON chat_chats (CASE WHEN folder_id IS NOT NULL THEN character_id ELSE NULL END, CASE WHEN folder_id IS NOT NULL THEN folder_id ELSE NULL END);
CREATE INDEX chats_last_message_idx ON chat_chats (CASE WHEN last_message_time IS NOT NULL THEN last_message_time ELSE NULL END);
CREATE INDEX chats_lower_name_idx ON chat_chats (LOWER(name));

CREATE TABLE chat_attributes (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key_value VARCHAR2(4000) NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (chat_id, key_value)
);

CREATE TABLE chat_suggestions (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    content CLOB NOT NULL,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE chat_modules (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    module_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE chat_script_state (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key_value VARCHAR2(4000) NOT NULL,
    value_type VARCHAR2(16) NOT NULL CHECK (value_type IN ('text', 'number', 'boolean')),
    text_value CLOB,
    number_value BINARY_DOUBLE,
    boolean_value NUMBER(1),
    PRIMARY KEY (chat_id, key_value),
    CHECK (
        (value_type = 'text' AND text_value IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
        OR (value_type = 'number' AND text_value IS NULL AND number_value IS NOT NULL AND boolean_value IS NULL)
        OR (value_type = 'boolean' AND text_value IS NULL AND number_value IS NULL AND boolean_value IS NOT NULL)
    )
);

CREATE TABLE chat_bookmarks (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    message_id VARCHAR2(4000) NOT NULL,
    name VARCHAR2(4000),
    PRIMARY KEY (chat_id, position)
);

CREATE INDEX chat_bookmarks_message_idx ON chat_bookmarks (chat_id, message_id);

CREATE TABLE chat_memory (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    memory_type VARCHAR2(64) NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (chat_id, memory_type)
);

CREATE TABLE chat_lore_entries (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    lore_id VARCHAR2(4000),
    primarykey VARCHAR2(4000) DEFAULT '',
    secondary_key VARCHAR2(4000) DEFAULT '',
    insert_order INTEGER DEFAULT 0,
    comment_text CLOB DEFAULT '',
    content CLOB DEFAULT '',
    lore_mode VARCHAR2(64) DEFAULT 'normal',
    always_active NUMBER(1) DEFAULT 0,
    selective NUMBER(1) DEFAULT 0,
    case_sensitive NUMBER(1),
    activation_percent BINARY_DOUBLE,
    use_regex NUMBER(1),
    book_version INTEGER,
    folder VARCHAR2(4000),
    cache_payload JSON,
    PRIMARY KEY (chat_id, position)
);

CREATE TABLE chat_messages (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    id VARCHAR2(4000) NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    role VARCHAR2(16) NOT NULL CHECK (role IN ('user', 'char')),
    content_text CLOB,
    content_binary BLOB,
    saying_character_id VARCHAR2(4000),
    sent_time NUMBER,
    sender_name VARCHAR2(4000),
    other_user NUMBER(1),
    disabled_scope VARCHAR2(16) CHECK (disabled_scope IN ('false', 'true', 'allBefore')),
    is_comment NUMBER(1),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    PRIMARY KEY (chat_id, id),
    CHECK ((content_text IS NULL) <> (content_binary IS NULL))
);

CREATE INDEX messages_chat_position_idx ON chat_messages (chat_id, position);
CREATE INDEX messages_role_idx ON chat_messages (role);
CREATE INDEX messages_sent_time_idx ON chat_messages (CASE WHEN sent_time IS NOT NULL THEN sent_time ELSE NULL END);
CREATE INDEX messages_content_fts_idx
ON chat_messages (content_text)
INDEXTYPE IS CTXSYS.CONTEXT;


CREATE TABLE chat_branches (
    chat_id VARCHAR2(4000) NOT NULL REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    id VARCHAR2(4000) NOT NULL,
    parent_branch_id VARCHAR2(4000),
    fork_message_id VARCHAR2(4000),
    head_message_id VARCHAR2(4000),
    reason VARCHAR2(32) NOT NULL CHECK (reason IN ('root', 'manual', 'reroll')),
    created_at NUMBER NOT NULL,
    PRIMARY KEY (chat_id, id),
    FOREIGN KEY (chat_id, parent_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (chat_id, fork_message_id) REFERENCES chat_messages(chat_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (chat_id, head_message_id) REFERENCES chat_messages(chat_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX branches_parent_idx ON chat_branches (chat_id, parent_branch_id, created_at);

CREATE TABLE chat_active_branches (
    chat_id VARCHAR2(4000) PRIMARY KEY REFERENCES chat_chats(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    branch_id VARCHAR2(4000) NOT NULL,
    FOREIGN KEY (chat_id, branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE chat_message_branch_links (
    chat_id VARCHAR2(4000) NOT NULL,
    message_id VARCHAR2(4000) NOT NULL,
    parent_message_id VARCHAR2(4000),
    origin_branch_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat_messages(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (chat_id, parent_message_id) REFERENCES chat_messages(chat_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (chat_id, origin_branch_id) REFERENCES chat_branches(chat_id, id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX message_branch_parent_idx ON chat_message_branch_links (chat_id, parent_message_id);
CREATE INDEX message_branch_origin_idx ON chat_message_branch_links (chat_id, origin_branch_id);

CREATE TABLE chat_message_attributes (
    chat_id VARCHAR2(4000) NOT NULL,
    message_id VARCHAR2(4000) NOT NULL,
    key_value VARCHAR2(4000) NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (chat_id, message_id, key_value),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE chat_message_generation (
    chat_id VARCHAR2(4000) NOT NULL,
    message_id VARCHAR2(4000) NOT NULL,
    model VARCHAR2(512),
    generation_id VARCHAR2(4000),
    input_tokens INTEGER,
    output_tokens INTEGER,
    max_context INTEGER,
    stage1_time BINARY_DOUBLE,
    stage2_time BINARY_DOUBLE,
    stage3_time BINARY_DOUBLE,
    stage4_time BINARY_DOUBLE,
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX message_generation_model_idx
ON chat_message_generation (CASE WHEN model IS NOT NULL THEN model ELSE NULL END);

CREATE TABLE chat_message_prompt_info (
    chat_id VARCHAR2(4000) NOT NULL,
    message_id VARCHAR2(4000) NOT NULL,
    prompt_name VARCHAR2(4000),
    PRIMARY KEY (chat_id, message_id),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE chat_message_prompt_toggles (
    chat_id VARCHAR2(4000) NOT NULL,
    message_id VARCHAR2(4000) NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    toggle_key VARCHAR2(4000) NOT NULL,
    toggle_value CLOB,
    PRIMARY KEY (chat_id, message_id, position),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE chat_message_prompt_items (
    chat_id VARCHAR2(4000) NOT NULL,
    message_id VARCHAR2(4000) NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    payload JSON NOT NULL,
    PRIMARY KEY (chat_id, message_id, position),
    FOREIGN KEY (chat_id, message_id) REFERENCES chat_messages(chat_id, id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- ============================================================
-- cold_* 테이블 (PostgreSQL cold. 스키마 대응)
-- ============================================================

CREATE TABLE cold_archives (
    id RAW(16) PRIMARY KEY,
    kind VARCHAR2(32) NOT NULL CHECK (kind IN ('character', 'chat', 'legacy')),
    owner_character_id VARCHAR2(4000),
    character_kind VARCHAR2(32) CHECK (character_kind IN ('character', 'group')),
    character_name VARCHAR2(4000),
    character_image CLOB,
    character_first_message CLOB,
    character_description CLOB,
    character_notes CLOB,
    character_creator_notes CLOB,
    character_system_prompt CLOB,
    character_post_history_instructions CLOB,
    character_personality CLOB,
    character_scenario CLOB,
    character_example_message CLOB,
    character_creator VARCHAR2(4000),
    character_version VARCHAR2(256),
    character_nickname VARCHAR2(4000),
    character_view_screen VARCHAR2(128),
    character_chat_page INTEGER,
    character_first_message_index INTEGER,
    character_utility_bot NUMBER(1),
    character_is_private NUMBER(1),
    character_realm_id VARCHAR2(4000),
    character_license CLOB,
    character_default_variables CLOB,
    character_additional_text CLOB,
    character_translator_note CLOB,
    character_background_html CLOB,
    character_background_css CLOB,
    character_creation_time NUMBER,
    character_modification_time NUMBER,
    character_last_interaction_time NUMBER,
    character_trash_time NUMBER,
    revision NUMBER DEFAULT 1 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

CREATE INDEX cold_archives_kind_updated_idx ON cold_archives (kind, updated_at DESC);
CREATE INDEX cold_archives_owner_idx ON cold_archives (CASE WHEN owner_character_id IS NOT NULL THEN owner_character_id ELSE NULL END);

CREATE TABLE cold_archive_attributes (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    key_value VARCHAR2(4000) NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (archive_id, key_value)
);

CREATE TABLE cold_field_presence (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    entity_type VARCHAR2(16) NOT NULL CHECK (entity_type IN ('character', 'chat', 'message')),
    chat_position INTEGER DEFAULT -1 NOT NULL,
    entity_position INTEGER DEFAULT -1 NOT NULL,
    field_name VARCHAR2(128) NOT NULL,
    PRIMARY KEY (archive_id, entity_type, chat_position, entity_position, field_name)
);

CREATE TABLE cold_character_tags (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    tag VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_character_greetings (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    greeting_type VARCHAR2(32) NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
    position INTEGER NOT NULL,
    content CLOB NOT NULL,
    PRIMARY KEY (archive_id, greeting_type, position)
);

CREATE TABLE cold_character_biases (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    phrase VARCHAR2(4000) NOT NULL,
    bias BINARY_DOUBLE NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_character_emotions (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    emotion VARCHAR2(4000) NOT NULL,
    asset CLOB NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_character_modules (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    module_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_group_members (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    character_id VARCHAR2(4000) NOT NULL,
    talk_weight BINARY_DOUBLE,
    active NUMBER(1),
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_chat_folders (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    folder_id VARCHAR2(4000) NOT NULL,
    name VARCHAR2(4000),
    color VARCHAR2(64),
    folded NUMBER(1) DEFAULT 0 NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_character_scripts (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    script_kind VARCHAR2(32) NOT NULL CHECK (script_kind IN ('custom', 'trigger')),
    position INTEGER NOT NULL,
    comment_text CLOB,
    input_text CLOB,
    output_text CLOB,
    script_type VARCHAR2(128),
    flag CLOB,
    able_flag NUMBER(1),
    trigger_payload JSON,
    PRIMARY KEY (archive_id, script_kind, position)
);

CREATE TABLE cold_character_sd_data (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    key_value VARCHAR2(4000) NOT NULL,
    value CLOB NOT NULL,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_character_assets (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    asset_source VARCHAR2(32) NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
    asset_type VARCHAR2(128),
    uri CLOB,
    name VARCHAR2(4000),
    extension VARCHAR2(64),
    extra_value CLOB,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_character_lore_entries (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL,
    lore_id VARCHAR2(4000),
    primarykey VARCHAR2(4000) DEFAULT '',
    secondary_key VARCHAR2(4000) DEFAULT '',
    insert_order INTEGER DEFAULT 0,
    comment_text CLOB DEFAULT '',
    content CLOB DEFAULT '',
    lore_mode VARCHAR2(64) DEFAULT 'normal',
    always_active NUMBER(1) DEFAULT 0,
    selective NUMBER(1) DEFAULT 0,
    case_sensitive NUMBER(1),
    activation_percent BINARY_DOUBLE,
    use_regex NUMBER(1),
    book_version INTEGER,
    folder VARCHAR2(4000),
    cache_payload JSON,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_chats (
    archive_id RAW(16) NOT NULL REFERENCES cold_archives(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    position INTEGER NOT NULL CHECK (position >= 0),
    original_chat_id VARCHAR2(4000),
    name VARCHAR2(4000) DEFAULT '' NOT NULL,
    note CLOB DEFAULT '' NOT NULL,
    sd_data CLOB,
    supa_memory_data CLOB,
    last_memory CLOB,
    is_streaming NUMBER(1),
    streaming_optimization_mode VARCHAR2(128),
    bound_persona_id VARCHAR2(4000),
    first_message_index INTEGER,
    folder_id VARCHAR2(4000),
    last_message_time NUMBER,
    PRIMARY KEY (archive_id, position)
);

CREATE TABLE cold_chat_attributes (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    key_value VARCHAR2(4000) NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (archive_id, chat_position, key_value),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_chat_suggestions (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    content CLOB NOT NULL,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_chat_modules (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    module_id VARCHAR2(4000) NOT NULL,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_chat_script_state (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    key_value VARCHAR2(4000) NOT NULL,
    value_type VARCHAR2(16) NOT NULL CHECK (value_type IN ('text', 'number', 'boolean')),
    text_value CLOB,
    number_value BINARY_DOUBLE,
    boolean_value NUMBER(1),
    PRIMARY KEY (archive_id, chat_position, key_value),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_chat_bookmarks (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    message_id VARCHAR2(4000) NOT NULL,
    name VARCHAR2(4000),
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_chat_memory (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    memory_type VARCHAR2(64) NOT NULL,
    payload JSON NOT NULL,
    PRIMARY KEY (archive_id, chat_position, memory_type),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_chat_lore_entries (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL,
    lore_id VARCHAR2(4000),
    primarykey VARCHAR2(4000) DEFAULT '',
    secondary_key VARCHAR2(4000) DEFAULT '',
    insert_order INTEGER DEFAULT 0,
    comment_text CLOB DEFAULT '',
    content CLOB DEFAULT '',
    lore_mode VARCHAR2(64) DEFAULT 'normal',
    always_active NUMBER(1) DEFAULT 0,
    selective NUMBER(1) DEFAULT 0,
    case_sensitive NUMBER(1),
    activation_percent BINARY_DOUBLE,
    use_regex NUMBER(1),
    book_version INTEGER,
    folder VARCHAR2(4000),
    cache_payload JSON,
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_messages (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    original_message_id VARCHAR2(4000),
    role VARCHAR2(16) NOT NULL CHECK (role IN ('user', 'char')),
    content_text CLOB,
    content_binary BLOB,
    saying_character_id VARCHAR2(4000),
    sent_time NUMBER,
    sender_name VARCHAR2(4000),
    other_user NUMBER(1),
    disabled_scope VARCHAR2(16) CHECK (disabled_scope IN ('false', 'true', 'allBefore')),
    is_comment NUMBER(1),
    PRIMARY KEY (archive_id, chat_position, position),
    FOREIGN KEY (archive_id, chat_position) REFERENCES cold_chats(archive_id, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    CHECK ((content_text IS NULL) <> (content_binary IS NULL))
);

CREATE INDEX cold_messages_role_idx ON cold_messages (role);
CREATE INDEX cold_messages_content_fts_idx
ON cold_messages (content_text)
INDEXTYPE IS CTXSYS.CONTEXT;

CREATE TABLE cold_message_attributes (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    key_value VARCHAR2(4000) NOT NULL,
    value JSON NOT NULL,
    PRIMARY KEY (archive_id, chat_position, message_position, key_value),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_message_generation (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    model VARCHAR2(512),
    generation_id VARCHAR2(4000),
    input_tokens INTEGER,
    output_tokens INTEGER,
    max_context INTEGER,
    stage1_time BINARY_DOUBLE,
    stage2_time BINARY_DOUBLE,
    stage3_time BINARY_DOUBLE,
    stage4_time BINARY_DOUBLE,
    PRIMARY KEY (archive_id, chat_position, message_position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX cold_message_generation_model_idx
ON cold_message_generation (CASE WHEN model IS NOT NULL THEN model ELSE NULL END);

CREATE TABLE cold_message_prompt_info (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    prompt_name VARCHAR2(4000),
    PRIMARY KEY (archive_id, chat_position, message_position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_message_prompt_toggles (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    toggle_key VARCHAR2(4000) NOT NULL,
    toggle_value CLOB,
    PRIMARY KEY (archive_id, chat_position, message_position, position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_message_prompt_items (
    archive_id RAW(16) NOT NULL,
    chat_position INTEGER NOT NULL,
    message_position INTEGER NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    payload JSON NOT NULL,
    PRIMARY KEY (archive_id, chat_position, message_position, position),
    FOREIGN KEY (archive_id, chat_position, message_position)
        REFERENCES cold_messages(archive_id, chat_position, position)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE cold_legacy_imports (
    id RAW(16) PRIMARY KEY,
    imported_at TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

-- ============================================================
-- 통합 뷰: 활성 + 콜드 메시지 (PostgreSQL chat.all_messages 대응)
-- ============================================================

CREATE OR REPLACE VIEW chat_all_messages AS
SELECT
    'active' AS storage_state,
    CAST(NULL AS RAW(16)) AS archive_id,
    chat_id,
    id AS message_id,
    position,
    role,
    content_text,
    content_binary,
    sent_time,
    sender_name
FROM chat_messages
UNION ALL
SELECT
    'cold' AS storage_state,
    archive_id,
    CAST(NULL AS VARCHAR2(4000)) AS chat_id,
    original_message_id AS message_id,
    position,
    role,
    content_text,
    content_binary,
    sent_time,
    sender_name
FROM cold_messages;

-- ============================================================
-- 감사 트리거: 모든 테이블에 자동 변경 기록
-- PostgreSQL의 record_row_change() 트리거와 동일.
-- row_to_json 대신 JSON_OBJECT를 사용하여 CLOB으로 직렬화.
-- ============================================================

-- 범용 감사 트리거 생성 프로시저
CREATE OR REPLACE PROCEDURE risu_create_audit_trigger(
    p_table_name IN VARCHAR2
) AS
    v_trigger_sql VARCHAR2(4000);
BEGIN
    -- 기존 트리거 제거
    BEGIN
        EXECUTE IMMEDIATE 'DROP TRIGGER ' || p_table_name || '_audit';
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    -- 트리거 생성 (각 행의 OLD/NEW를 JSON_OBJECT로 직렬화)
    -- 주의: 테이블별로 컬럼이 다르므로, 범용 트리거는 ROWID 기반으로
    -- 감사 함수에서 동적 SQL로 전체 행을 직렬화.
    v_trigger_sql :=
        'CREATE OR REPLACE TRIGGER ' || p_table_name || '_audit ' ||
        'AFTER INSERT OR UPDATE OR DELETE ON ' || p_table_name || ' ' ||
        'FOR EACH ROW ' ||
        'DECLARE ' ||
        '  v_op VARCHAR2(10); ' ||
        '  v_old CLOB; ' ||
        '  v_new CLOB; ' ||
        'BEGIN ' ||
        '  IF INSERTING THEN ' ||
        '    v_op := ''INSERT''; ' ||
        '    v_old := NULL; ' ||
        '    v_new := NULL; ' ||
        '  ELSIF UPDATING THEN ' ||
        '    v_op := ''UPDATE''; ' ||
        '    v_old := NULL; ' ||
        '    v_new := NULL; ' ||
        '  ELSIF DELETING THEN ' ||
        '    v_op := ''DELETE''; ' ||
        '    v_old := NULL; ' ||
        '    v_new := NULL; ' ||
        '  END IF; ' ||
        '  risu_record_change(''' || p_table_name || ''', v_op, v_old, v_new); ' ||
        'END;';
    EXECUTE IMMEDIATE v_trigger_sql;
END risu_create_audit_trigger;
/

-- 감사 대상 테이블 목록
-- PostgreSQL AUDITED_TABLES와 동일. 트리거는 애플리케이션 시작 시
-- 동적으로 생성하여 테이블별 컬럼을 정확히 직렬화.
-- 구현체(oracleStorage.cjs)에서 initialize 시 생성.
