-- Risuai Azure SQL / MS SQL Server Storage Schema
-- Azure SQL Database / Microsoft SQL Server용 관계형 스키마.
-- system, character, chat, cold 4개 스키마 분리 및 감사 로그 지원.
--
-- 스키마 버전: 2 (postgres-schema.sql과 동일)
-- 레이아웃: relational-schema-v2

IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'system') EXEC('CREATE SCHEMA [system]');
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'character') EXEC('CREATE SCHEMA [character]');
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'chat') EXEC('CREATE SCHEMA [chat]');
IF NOT EXISTS (SELECT * FROM sys.schemas WHERE name = 'cold') EXEC('CREATE SCHEMA [cold]');

-- ============================================================
-- system 스키마
-- ============================================================

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[storage_meta]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[storage_meta] (
        singleton BIT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
        schema_version INT NOT NULL DEFAULT 4,
        schema_layout NVARCHAR(64) NOT NULL DEFAULT 'relational-schema-v3',
        revision BIGINT NOT NULL DEFAULT 0,
        initialized BIT NOT NULL DEFAULT 0,
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    INSERT INTO [system].[storage_meta] (singleton, schema_version, schema_layout)
    VALUES (1, 4, 'relational-schema-v3');
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[asset_catalog_state]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[asset_catalog_state] (
        singleton BIT PRIMARY KEY DEFAULT 1 CHECK (singleton = 1),
        initialized BIT NOT NULL DEFAULT 0,
        source_id NVARCHAR(900),
        synced_at DATETIMEOFFSET
    );
    INSERT INTO [system].[asset_catalog_state] (singleton, initialized) VALUES (1, 0);
END;

IF COL_LENGTH('system.asset_catalog_state', 'source_id') IS NULL
    ALTER TABLE [system].[asset_catalog_state] ADD source_id NVARCHAR(900);

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[asset_catalog]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[asset_catalog] (
        asset_key NVARCHAR(900) PRIMARY KEY,
        size_bytes BIGINT,
        etag NVARCHAR(900),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX asset_catalog_updated_idx ON [system].[asset_catalog] (updated_at DESC);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[revisions]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[revisions] (
        id BIGINT IDENTITY(1,1) PRIMARY KEY,
        storage_revision BIGINT,
        database_initialized BIT,
        scope NVARCHAR(32) NOT NULL CHECK (scope IN ('database', 'cold-storage', 'restore')),
        action NVARCHAR(64) NOT NULL,
        restored_from_revision BIGINT REFERENCES [system].[revisions](id),
        created_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX revisions_created_idx ON [system].[revisions] (created_at DESC, id DESC);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[audit_log]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[audit_log] (
        sequence BIGINT IDENTITY(1,1) PRIMARY KEY,
        revision_id BIGINT NOT NULL REFERENCES [system].[revisions](id) ON DELETE CASCADE,
        table_name NVARCHAR(128) NOT NULL,
        operation NVARCHAR(10) NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
        before_row NVARCHAR(MAX),
        after_row NVARCHAR(MAX),
        recorded_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX audit_revision_sequence_idx ON [system].[audit_log] (revision_id DESC, sequence DESC);
    CREATE INDEX audit_table_revision_idx ON [system].[audit_log] (table_name, revision_id DESC);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[settings]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[settings] (
        [key] NVARCHAR(450) PRIMARY KEY,
        [text_val] NVARCHAR(MAX),
        [num_val] FLOAT,
        [bool_val] BIT,
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[setting_values]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[setting_values] (
        setting_key NVARCHAR(450) NOT NULL,
        node_id INT NOT NULL,
        parent_node_id INT,
        member_key NVARCHAR(MAX),
        encoded_member_key NVARCHAR(MAX),
        position INT CHECK (position >= 0),
        value_type NVARCHAR(32) NOT NULL CHECK (value_type IN ('null','text','encoded-text','number','boolean','array','object')),
        text_value NVARCHAR(MAX),
        encoded_text_value NVARCHAR(MAX),
        number_value FLOAT,
        boolean_value BIT,
        PRIMARY KEY (setting_key, node_id),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE,
        FOREIGN KEY (setting_key, parent_node_id) REFERENCES [system].[setting_values](setting_key, node_id),
        CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
        CHECK (member_key IS NULL OR encoded_member_key IS NULL),
        CHECK (text_value IS NULL OR encoded_text_value IS NULL)
    );
    CREATE INDEX setting_values_parent_idx ON [system].[setting_values] (setting_key, parent_node_id, position, node_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[module_records]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[module_records] (
        module_id NVARCHAR(450) NOT NULL PRIMARY KEY,
        position INT NOT NULL UNIQUE CHECK (position >= 0),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE TABLE [system].[module_values] (
        module_id NVARCHAR(450) NOT NULL,
        node_id INT NOT NULL,
        parent_node_id INT,
        member_key NVARCHAR(MAX), encoded_member_key NVARCHAR(MAX),
        position INT CHECK (position >= 0),
        value_type NVARCHAR(32) NOT NULL CHECK (value_type IN ('null','text','encoded-text','number','boolean','array','object')),
        text_value NVARCHAR(MAX), encoded_text_value NVARCHAR(MAX),
        number_value FLOAT, boolean_value BIT,
        PRIMARY KEY (module_id, node_id),
        FOREIGN KEY (module_id) REFERENCES [system].[module_records](module_id) ON DELETE CASCADE,
        FOREIGN KEY (module_id, parent_node_id) REFERENCES [system].[module_values](module_id, node_id),
        CHECK (node_id = 0 OR parent_node_id IS NOT NULL),
        CHECK (member_key IS NULL OR encoded_member_key IS NULL),
        CHECK (text_value IS NULL OR encoded_text_value IS NULL)
    );
    CREATE INDEX module_values_parent_idx ON [system].[module_values] (module_id, parent_node_id, position, node_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[bot_presets]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[bot_presets] (
        preset_id NVARCHAR(450) NOT NULL PRIMARY KEY,
        position INT NOT NULL UNIQUE CHECK (position >= 0),
        name NVARCHAR(MAX) NOT NULL DEFAULT '', image NVARCHAR(MAX) NOT NULL DEFAULT '',
        api_type NVARCHAR(256) NOT NULL DEFAULT '', ai_model NVARCHAR(512) NOT NULL DEFAULT '',
        data NVARCHAR(MAX) NOT NULL CHECK (ISJSON(data) = 1), content_hash NVARCHAR(128) NOT NULL,
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX bot_presets_model_idx ON [system].[bot_presets] (api_type, ai_model);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[personas]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[personas] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'personas' CHECK (setting_key = 'personas'),
        position INT NOT NULL CHECK (position >= 0),
        persona_id NVARCHAR(450),
        name NVARCHAR(MAX),
        prompt NVARCHAR(MAX),
        icon NVARCHAR(MAX),
        large_portrait BIT,
        note NVARCHAR(MAX),
        embedded_module_id NVARCHAR(450),
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
    CREATE INDEX personas_id_idx ON [system].[personas] (persona_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[modules]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[modules] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'modules' CHECK (setting_key = 'modules'),
        position INT NOT NULL CHECK (position >= 0),
        module_id NVARCHAR(450),
        name NVARCHAR(MAX),
        description NVARCHAR(MAX),
        cjs NVARCHAR(MAX),
        low_level_access BIT,
        hide_icon BIT,
        background_embedding NVARCHAR(MAX),
        namespace NVARCHAR(450),
        custom_toggle NVARCHAR(MAX),
        mcp_url NVARCHAR(MAX),
        icon NVARCHAR(MAX),
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
    CREATE INDEX modules_id_idx ON [system].[modules] (module_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[plugins]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[plugins] (
        setting_key NVARCHAR(450) NOT NULL CHECK (setting_key IN ('plugins', 'pluginV2')),
        position INT NOT NULL CHECK (position >= 0),
        name NVARCHAR(450),
        display_name NVARCHAR(MAX),
        script NVARCHAR(MAX),
        api_version NVARCHAR(64),
        plugin_version NVARCHAR(64),
        update_url NVARCHAR(MAX),
        enabled BIT,
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
    CREATE INDEX plugins_name_idx ON [system].[plugins] (name);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[global_lorebooks]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[global_lorebooks] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
        position INT NOT NULL CHECK (position >= 0),
        name NVARCHAR(MAX),
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[global_lore_entries]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[global_lore_entries] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
        book_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        lore_id NVARCHAR(450),
        primary_key NVARCHAR(450),
        secondary_key NVARCHAR(MAX),
        insert_order INT,
        comment NVARCHAR(MAX),
        content NVARCHAR(MAX),
        mode NVARCHAR(64),
        always_active BIT,
        selective BIT,
        case_sensitive BIT,
        activation_percent FLOAT,
        use_regex BIT,
        book_version INT,
        folder NVARCHAR(450),
        cache_key NVARCHAR(450),
        PRIMARY KEY (setting_key, book_position, position),
        FOREIGN KEY (setting_key, book_position) REFERENCES [system].[global_lorebooks](setting_key, position) ON DELETE CASCADE
    );
    CREATE INDEX global_lore_primary_idx ON [system].[global_lore_entries] (primary_key);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[global_lore_cache_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[global_lore_cache_items] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loreBook' CHECK (setting_key = 'loreBook'),
        book_position INT NOT NULL,
        lore_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (setting_key, book_position, lore_position, position),
        FOREIGN KEY (setting_key, book_position, lore_position)
            REFERENCES [system].[global_lore_entries](setting_key, book_position, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[translator_presets]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[translator_presets] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'translatorPresets' CHECK (setting_key = 'translatorPresets'),
        position INT NOT NULL CHECK (position >= 0),
        name NVARCHAR(MAX),
        prompt NVARCHAR(MAX),
        max_response INT,
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[hotkeys]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[hotkeys] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'hotkeys' CHECK (setting_key = 'hotkeys'),
        position INT NOT NULL CHECK (position >= 0),
        [key] NVARCHAR(MAX),
        control BIT,
        shift BIT,
        alt BIT,
        action NVARCHAR(450),
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
    CREATE INDEX hotkeys_action_idx ON [system].[hotkeys] (action);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[custom_models]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[custom_models] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'customModels' CHECK (setting_key = 'customModels'),
        position INT NOT NULL CHECK (position >= 0),
        id NVARCHAR(450),
        internal_id NVARCHAR(450),
        url NVARCHAR(MAX),
        format INT,
        tokenizer INT,
        api_key NVARCHAR(MAX),
        name NVARCHAR(MAX),
        params NVARCHAR(MAX),
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[custom_model_flags]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[custom_model_flags] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'customModels' CHECK (setting_key = 'customModels'),
        model_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        flag INT NOT NULL,
        PRIMARY KEY (setting_key, model_position, position),
        FOREIGN KEY (setting_key, model_position)
            REFERENCES [system].[custom_models](setting_key, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[loadouts]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[loadouts] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
        position INT NOT NULL CHECK (position >= 0),
        id NVARCHAR(450),
        name NVARCHAR(MAX),
        last_used BIGINT,
        favorite BIT,
        preset_name NVARCHAR(MAX),
        persona_id NVARCHAR(450),
        icons_present BIT NOT NULL DEFAULT 0,
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
    CREATE INDEX loadouts_last_used_idx ON [system].[loadouts] (last_used);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[loadout_character_refs]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[loadout_character_refs] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
        loadout_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        character_id NVARCHAR(450) NOT NULL,
        PRIMARY KEY (setting_key, loadout_position, position),
        FOREIGN KEY (setting_key, loadout_position)
            REFERENCES [system].[loadouts](setting_key, position) ON DELETE CASCADE
    );
    CREATE INDEX loadout_character_idx ON [system].[loadout_character_refs] (character_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[loadout_module_refs]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[loadout_module_refs] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
        loadout_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        module_id NVARCHAR(450) NOT NULL,
        PRIMARY KEY (setting_key, loadout_position, position),
        FOREIGN KEY (setting_key, loadout_position)
            REFERENCES [system].[loadouts](setting_key, position) ON DELETE CASCADE
    );
    CREATE INDEX loadout_module_idx ON [system].[loadout_module_refs] (module_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[loadout_variables]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[loadout_variables] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
        loadout_position INT NOT NULL,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (setting_key, loadout_position, [key]),
        FOREIGN KEY (setting_key, loadout_position)
            REFERENCES [system].[loadouts](setting_key, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[loadout_icons]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[loadout_icons] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'loadouts' CHECK (setting_key = 'loadouts'),
        loadout_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        asset_id NVARCHAR(450) NOT NULL,
        PRIMARY KEY (setting_key, loadout_position, position),
        FOREIGN KEY (setting_key, loadout_position)
            REFERENCES [system].[loadouts](setting_key, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[custom_sidebar_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[custom_sidebar_items] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'customSidebarItems' CHECK (setting_key = 'customSidebarItems'),
        position INT NOT NULL CHECK (position >= 0),
        id NVARCHAR(450),
        item_type NVARCHAR(128),
        subtype NVARCHAR(128),
        label NVARCHAR(MAX),
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[ordered_text_settings]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[ordered_text_settings] (
        setting_key NVARCHAR(450) NOT NULL CHECK (setting_key IN (
            'formatingOrder', 'localStopStrings', 'enabledModules', 'banCharacterset', 'modelTools'
        )),
        position INT NOT NULL CHECK (position >= 0),
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[ordered_number_settings]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[ordered_number_settings] (
        setting_key NVARCHAR(450) NOT NULL CHECK (setting_key = 'customFlags'),
        position INT NOT NULL CHECK (position >= 0),
        value FLOAT NOT NULL,
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[string_map_settings]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[string_map_settings] (
        setting_key NVARCHAR(450) NOT NULL CHECK (setting_key IN (
            'globalChatVariables', 'OaiCompAPIKeys', 'seperateModels'
        )),
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (setting_key, [key]),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[bias_entries]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[bias_entries] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'bias' CHECK (setting_key = 'bias'),
        position INT NOT NULL CHECK (position >= 0),
        phrase NVARCHAR(450) NOT NULL,
        bias FLOAT NOT NULL,
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[additional_parameters]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[additional_parameters] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'additionalParams' CHECK (setting_key = 'additionalParams'),
        position INT NOT NULL CHECK (position >= 0),
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (setting_key, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[fallback_models]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[fallback_models] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'fallbackModels' CHECK (setting_key = 'fallbackModels'),
        category NVARCHAR(128) NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        model NVARCHAR(450) NOT NULL,
        PRIMARY KEY (setting_key, category, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
    CREATE INDEX fallback_model_idx ON [system].[fallback_models] (model);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[openrouter_provider_rules]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[openrouter_provider_rules] (
        setting_key NVARCHAR(450) NOT NULL DEFAULT 'openrouterProvider' CHECK (setting_key = 'openrouterProvider'),
        rule_type NVARCHAR(32) NOT NULL CHECK (rule_type IN ('order', 'only', 'ignore')),
        position INT NOT NULL CHECK (position >= 0),
        provider NVARCHAR(450) NOT NULL,
        PRIMARY KEY (setting_key, rule_type, position),
        FOREIGN KEY (setting_key) REFERENCES [system].[settings]([key]) ON DELETE CASCADE
    );
    CREATE INDEX openrouter_provider_idx ON [system].[openrouter_provider_rules] (provider, rule_type);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[plugin_custom_storage]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[plugin_custom_storage] (
        [key] NVARCHAR(450) PRIMARY KEY,
        value NVARCHAR(MAX) NOT NULL CHECK (ISJSON(value) = 1),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[system].[client_storage]') AND type in (N'U'))
BEGIN
    CREATE TABLE [system].[client_storage] (
        [key] NVARCHAR(450) PRIMARY KEY,
        value NVARCHAR(MAX) NOT NULL,
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
END;

-- ============================================================
-- character 스키마
-- ============================================================

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[characters]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[characters] (
        id NVARCHAR(450) PRIMARY KEY,
        position INT NOT NULL CHECK (position >= 0),
        kind NVARCHAR(32) NOT NULL CHECK (kind IN ('character', 'group')),
        name NVARCHAR(MAX) NOT NULL DEFAULT '',
        image NVARCHAR(MAX),
        first_message NVARCHAR(MAX) NOT NULL DEFAULT '',
        description NVARCHAR(MAX),
        notes NVARCHAR(MAX),
        creator_notes NVARCHAR(MAX),
        system_prompt NVARCHAR(MAX),
        post_history_instructions NVARCHAR(MAX),
        personality NVARCHAR(MAX),
        scenario NVARCHAR(MAX),
        example_message NVARCHAR(MAX),
        creator NVARCHAR(MAX),
        character_version NVARCHAR(MAX),
        nickname NVARCHAR(MAX),
        view_screen NVARCHAR(MAX),
        chat_page INT NOT NULL DEFAULT 0,
        first_message_index INT,
        utility_bot BIT,
        is_private BIT,
        realm_id NVARCHAR(MAX),
        license NVARCHAR(MAX),
        default_variables NVARCHAR(MAX),
        additional_text NVARCHAR(MAX),
        translator_note NVARCHAR(MAX),
        background_html NVARCHAR(MAX),
        background_css NVARCHAR(MAX),
        creation_time BIGINT,
        modification_time BIGINT,
        last_interaction_time BIGINT,
        trash_time BIGINT,
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX characters_position_idx ON [character].[characters] (position);
    CREATE INDEX characters_kind_position_idx ON [character].[characters] (kind, position);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[attributes]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[attributes] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (character_id, [key])
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[tags]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[tags] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        tag NVARCHAR(450) NOT NULL,
        PRIMARY KEY (character_id, position)
    );
    CREATE INDEX character_tags_tag_idx ON [character].[tags] (tag);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[greetings]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[greetings] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        greeting_type NVARCHAR(32) NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
        position INT NOT NULL CHECK (position >= 0),
        content NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (character_id, greeting_type, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[biases]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[biases] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        phrase NVARCHAR(450) NOT NULL,
        bias FLOAT NOT NULL,
        PRIMARY KEY (character_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[emotions]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[emotions] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        emotion NVARCHAR(450) NOT NULL,
        asset NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (character_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[modules]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[modules] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        module_id NVARCHAR(450) NOT NULL,
        PRIMARY KEY (character_id, position)
    );
    CREATE INDEX character_modules_module_idx ON [character].[modules] (module_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[group_members]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[group_members] (
        group_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        character_id NVARCHAR(450) NOT NULL,
        talk_weight FLOAT,
        active BIT,
        PRIMARY KEY (group_id, position)
    );
    CREATE INDEX group_members_character_idx ON [character].[group_members] (character_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[chat_folders]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[chat_folders] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        folder_id NVARCHAR(450) NOT NULL,
        name NVARCHAR(MAX),
        color NVARCHAR(64),
        folded BIT NOT NULL DEFAULT 0,
        PRIMARY KEY (character_id, position),
        UNIQUE (character_id, folder_id)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[scripts]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[scripts] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        script_kind NVARCHAR(32) NOT NULL CHECK (script_kind IN ('custom', 'trigger')),
        position INT NOT NULL CHECK (position >= 0),
        comment NVARCHAR(MAX),
        input_text NVARCHAR(MAX),
        output_text NVARCHAR(MAX),
        script_type NVARCHAR(128),
        flag NVARCHAR(450),
        able_flag BIT,
        trigger_payload NVARCHAR(MAX),
        PRIMARY KEY (character_id, script_kind, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[sd_data]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[sd_data] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (character_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[assets]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[assets] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        asset_source NVARCHAR(32) NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
        asset_type NVARCHAR(128),
        uri NVARCHAR(MAX),
        name NVARCHAR(MAX),
        extension NVARCHAR(64),
        extra_value NVARCHAR(MAX),
        PRIMARY KEY (character_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[lore_entries]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[lore_entries] (
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        lore_id NVARCHAR(450),
        primary_key NVARCHAR(450) NOT NULL DEFAULT '',
        secondary_key NVARCHAR(MAX) NOT NULL DEFAULT '',
        insert_order INT NOT NULL DEFAULT 0,
        comment NVARCHAR(MAX) NOT NULL DEFAULT '',
        content NVARCHAR(MAX) NOT NULL DEFAULT '',
        mode NVARCHAR(64) NOT NULL DEFAULT 'normal',
        always_active BIT NOT NULL DEFAULT 0,
        selective BIT NOT NULL DEFAULT 0,
        case_sensitive BIT,
        activation_percent FLOAT,
        use_regex BIT,
        book_version INT,
        folder NVARCHAR(450),
        cache_payload NVARCHAR(MAX),
        PRIMARY KEY (character_id, position)
    );
    CREATE INDEX character_lore_primary_key_idx ON [character].[lore_entries] (primary_key);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[character].[lore_cache_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [character].[lore_cache_items] (
        character_id NVARCHAR(450) NOT NULL,
        lore_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (character_id, lore_position, position),
        FOREIGN KEY (character_id, lore_position)
            REFERENCES [character].[lore_entries](character_id, position) ON DELETE CASCADE
    );
END;

-- ============================================================
-- chat 스키마
-- ============================================================

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[chats]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[chats] (
        id NVARCHAR(450) PRIMARY KEY,
        character_id NVARCHAR(450) NOT NULL REFERENCES [character].[characters](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        name NVARCHAR(MAX) NOT NULL DEFAULT '',
        note NVARCHAR(MAX) NOT NULL DEFAULT '',
        sd_data NVARCHAR(MAX),
        supa_memory_data NVARCHAR(MAX),
        last_memory NVARCHAR(MAX),
        is_streaming BIT,
        streaming_optimization_mode NVARCHAR(128),
        bound_persona_id NVARCHAR(450),
        first_message_index INT,
        folder_id NVARCHAR(450),
        last_message_time BIGINT,
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX chats_character_position_idx ON [chat].[chats] (character_id, position);
    CREATE INDEX chats_folder_idx ON [chat].[chats] (character_id, folder_id);
    CREATE INDEX chats_last_message_idx ON [chat].[chats] (last_message_time DESC);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[attributes]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[attributes] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (chat_id, [key])
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[suggestions]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[suggestions] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        content NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (chat_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[modules]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[modules] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        module_id NVARCHAR(450) NOT NULL,
        PRIMARY KEY (chat_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[script_state]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[script_state] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        [key] NVARCHAR(450) NOT NULL,
        value_type NVARCHAR(32) NOT NULL CHECK (value_type IN ('text', 'number', 'boolean')),
        text_value NVARCHAR(MAX),
        number_value FLOAT,
        boolean_value BIT,
        PRIMARY KEY (chat_id, [key]),
        CHECK (
            (value_type = 'text' AND text_value IS NOT NULL AND number_value IS NULL AND boolean_value IS NULL)
            OR (value_type = 'number' AND text_value IS NULL AND number_value IS NOT NULL AND boolean_value IS NULL)
            OR (value_type = 'boolean' AND text_value IS NULL AND number_value IS NULL AND boolean_value IS NOT NULL)
        )
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[bookmarks]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[bookmarks] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        message_id NVARCHAR(450) NOT NULL,
        name NVARCHAR(MAX),
        PRIMARY KEY (chat_id, position)
    );
    CREATE INDEX chat_bookmarks_message_idx ON [chat].[bookmarks] (chat_id, message_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[memory]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[memory] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        memory_type NVARCHAR(128) NOT NULL,
        payload NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (chat_id, memory_type)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[lore_entries]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[lore_entries] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        lore_id NVARCHAR(450),
        primary_key NVARCHAR(450) NOT NULL DEFAULT '',
        secondary_key NVARCHAR(MAX) NOT NULL DEFAULT '',
        insert_order INT NOT NULL DEFAULT 0,
        comment NVARCHAR(MAX) NOT NULL DEFAULT '',
        content NVARCHAR(MAX) NOT NULL DEFAULT '',
        mode NVARCHAR(64) NOT NULL DEFAULT 'normal',
        always_active BIT NOT NULL DEFAULT 0,
        selective BIT NOT NULL DEFAULT 0,
        case_sensitive BIT,
        activation_percent FLOAT,
        use_regex BIT,
        book_version INT,
        folder NVARCHAR(450),
        cache_payload NVARCHAR(MAX),
        PRIMARY KEY (chat_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[lore_cache_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[lore_cache_items] (
        chat_id NVARCHAR(450) NOT NULL,
        lore_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (chat_id, lore_position, position),
        FOREIGN KEY (chat_id, lore_position)
            REFERENCES [chat].[lore_entries](chat_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[messages]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[messages] (
        chat_id NVARCHAR(450) NOT NULL REFERENCES [chat].[chats](id) ON DELETE CASCADE,
        id NVARCHAR(450) NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        role NVARCHAR(32) NOT NULL CHECK (role IN ('user', 'char')),
        content_text NVARCHAR(MAX),
        content_binary VARBINARY(MAX),
        saying_character_id NVARCHAR(MAX),
        sent_time BIGINT,
        sender_name NVARCHAR(MAX),
        other_user BIT,
        disabled_scope NVARCHAR(32) CHECK (disabled_scope IN ('false', 'true', 'allBefore')),
        is_comment BIT,
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
        PRIMARY KEY (chat_id, id),
        CHECK (
            (content_text IS NOT NULL AND content_binary IS NULL)
            OR (content_text IS NULL AND content_binary IS NOT NULL)
        )
    );
    CREATE INDEX messages_chat_position_idx ON [chat].[messages] (chat_id, position);
    CREATE INDEX messages_role_idx ON [chat].[messages] (role);
    CREATE INDEX messages_sent_time_idx ON [chat].[messages] (sent_time DESC);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[message_attributes]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[message_attributes] (
        chat_id NVARCHAR(450) NOT NULL,
        message_id NVARCHAR(450) NOT NULL,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (chat_id, message_id, [key]),
        FOREIGN KEY (chat_id, message_id) REFERENCES [chat].[messages](chat_id, id) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[message_generation]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[message_generation] (
        chat_id NVARCHAR(450) NOT NULL,
        message_id NVARCHAR(450) NOT NULL,
        model NVARCHAR(512),
        generation_id NVARCHAR(450),
        input_tokens INT,
        output_tokens INT,
        max_context INT,
        stage1_time FLOAT,
        stage2_time FLOAT,
        stage3_time FLOAT,
        stage4_time FLOAT,
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (chat_id, message_id) REFERENCES [chat].[messages](chat_id, id) ON DELETE CASCADE
    );
    CREATE INDEX message_generation_model_idx ON [chat].[message_generation] (model);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[message_prompt_info]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[message_prompt_info] (
        chat_id NVARCHAR(450) NOT NULL,
        message_id NVARCHAR(450) NOT NULL,
        prompt_name NVARCHAR(MAX),
        PRIMARY KEY (chat_id, message_id),
        FOREIGN KEY (chat_id, message_id) REFERENCES [chat].[messages](chat_id, id) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[message_prompt_toggles]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[message_prompt_toggles] (
        chat_id NVARCHAR(450) NOT NULL,
        message_id NVARCHAR(450) NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        toggle_key NVARCHAR(450) NOT NULL,
        toggle_value NVARCHAR(MAX),
        PRIMARY KEY (chat_id, message_id, position),
        FOREIGN KEY (chat_id, message_id) REFERENCES [chat].[messages](chat_id, id) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[chat].[message_prompt_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [chat].[message_prompt_items] (
        chat_id NVARCHAR(450) NOT NULL,
        message_id NVARCHAR(450) NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        payload NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (chat_id, message_id, position),
        FOREIGN KEY (chat_id, message_id) REFERENCES [chat].[messages](chat_id, id) ON DELETE CASCADE
    );
END;

-- ============================================================
-- cold 스키마
-- ============================================================

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[archives]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[archives] (
        id NVARCHAR(64) PRIMARY KEY,
        kind NVARCHAR(32) NOT NULL CHECK (kind IN ('character', 'chat', 'legacy')),
        owner_character_id NVARCHAR(450),
        character_kind NVARCHAR(32) CHECK (character_kind IN ('character', 'group')),
        character_name NVARCHAR(MAX),
        character_image NVARCHAR(MAX),
        character_first_message NVARCHAR(MAX),
        character_description NVARCHAR(MAX),
        character_notes NVARCHAR(MAX),
        character_creator_notes NVARCHAR(MAX),
        character_system_prompt NVARCHAR(MAX),
        character_post_history_instructions NVARCHAR(MAX),
        character_personality NVARCHAR(MAX),
        character_scenario NVARCHAR(MAX),
        character_example_message NVARCHAR(MAX),
        character_creator NVARCHAR(MAX),
        character_version NVARCHAR(MAX),
        character_nickname NVARCHAR(MAX),
        character_view_screen NVARCHAR(MAX),
        character_chat_page INT,
        character_first_message_index INT,
        character_utility_bot BIT,
        character_is_private BIT,
        character_realm_id NVARCHAR(MAX),
        character_license NVARCHAR(MAX),
        character_default_variables NVARCHAR(MAX),
        character_additional_text NVARCHAR(MAX),
        character_translator_note NVARCHAR(MAX),
        character_background_html NVARCHAR(MAX),
        character_background_css NVARCHAR(MAX),
        character_creation_time BIGINT,
        character_modification_time BIGINT,
        character_last_interaction_time BIGINT,
        character_trash_time BIGINT,
        revision BIGINT NOT NULL DEFAULT 1,
        created_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET(),
        updated_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
    CREATE INDEX cold_archives_kind_updated_idx ON [cold].[archives] (kind, updated_at DESC);
    CREATE INDEX cold_archives_owner_idx ON [cold].[archives] (owner_character_id);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[archive_attributes]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[archive_attributes] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, [key])
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[field_presence]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[field_presence] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        entity_type NVARCHAR(32) NOT NULL CHECK (entity_type IN ('character', 'chat', 'message')),
        chat_position INT NOT NULL DEFAULT -1,
        entity_position INT NOT NULL DEFAULT -1,
        field_name NVARCHAR(450) NOT NULL,
        PRIMARY KEY (archive_id, entity_type, chat_position, entity_position, field_name)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_tags]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_tags] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        tag NVARCHAR(450) NOT NULL,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_greetings]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_greetings] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        greeting_type NVARCHAR(32) NOT NULL CHECK (greeting_type IN ('alternate', 'group-only')),
        position INT NOT NULL,
        content NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, greeting_type, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_biases]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_biases] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        phrase NVARCHAR(450) NOT NULL,
        bias FLOAT NOT NULL,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_emotions]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_emotions] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        emotion NVARCHAR(450) NOT NULL,
        asset NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_modules]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_modules] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        module_id NVARCHAR(450) NOT NULL,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[group_members]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[group_members] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        character_id NVARCHAR(450) NOT NULL,
        talk_weight FLOAT,
        active BIT,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_folders]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_folders] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        folder_id NVARCHAR(450) NOT NULL,
        name NVARCHAR(MAX),
        color NVARCHAR(64),
        folded BIT NOT NULL DEFAULT 0,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_scripts]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_scripts] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        script_kind NVARCHAR(32) NOT NULL CHECK (script_kind IN ('custom', 'trigger')),
        position INT NOT NULL,
        comment NVARCHAR(MAX),
        input_text NVARCHAR(MAX),
        output_text NVARCHAR(MAX),
        script_type NVARCHAR(128),
        flag NVARCHAR(450),
        able_flag BIT,
        trigger_payload NVARCHAR(MAX),
        PRIMARY KEY (archive_id, script_kind, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_sd_data]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_sd_data] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_assets]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_assets] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        asset_source NVARCHAR(32) NOT NULL CHECK (asset_source IN ('additional', 'character-card')),
        asset_type NVARCHAR(128),
        uri NVARCHAR(MAX),
        name NVARCHAR(MAX),
        extension NVARCHAR(64),
        extra_value NVARCHAR(MAX),
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_lore_entries]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_lore_entries] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL,
        lore_id NVARCHAR(450),
        primary_key NVARCHAR(450) NOT NULL DEFAULT '',
        secondary_key NVARCHAR(MAX) NOT NULL DEFAULT '',
        insert_order INT NOT NULL DEFAULT 0,
        comment NVARCHAR(MAX) NOT NULL DEFAULT '',
        content NVARCHAR(MAX) NOT NULL DEFAULT '',
        mode NVARCHAR(64) NOT NULL DEFAULT 'normal',
        always_active BIT NOT NULL DEFAULT 0,
        selective BIT NOT NULL DEFAULT 0,
        case_sensitive BIT,
        activation_percent FLOAT,
        use_regex BIT,
        book_version INT,
        folder NVARCHAR(450),
        cache_payload NVARCHAR(MAX),
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[character_lore_cache_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[character_lore_cache_items] (
        archive_id NVARCHAR(64) NOT NULL,
        lore_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, lore_position, position),
        FOREIGN KEY (archive_id, lore_position)
            REFERENCES [cold].[character_lore_entries](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chats]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chats] (
        archive_id NVARCHAR(64) NOT NULL REFERENCES [cold].[archives](id) ON DELETE CASCADE,
        position INT NOT NULL CHECK (position >= 0),
        original_chat_id NVARCHAR(450),
        name NVARCHAR(MAX) NOT NULL DEFAULT '',
        note NVARCHAR(MAX) NOT NULL DEFAULT '',
        sd_data NVARCHAR(MAX),
        supa_memory_data NVARCHAR(MAX),
        last_memory NVARCHAR(MAX),
        is_streaming BIT,
        streaming_optimization_mode NVARCHAR(128),
        bound_persona_id NVARCHAR(450),
        first_message_index INT,
        folder_id NVARCHAR(450),
        last_message_time BIGINT,
        PRIMARY KEY (archive_id, position)
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_attributes]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_attributes] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, chat_position, [key]),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_suggestions]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_suggestions] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        position INT NOT NULL,
        content NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, chat_position, position),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_modules]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_modules] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        position INT NOT NULL,
        module_id NVARCHAR(450) NOT NULL,
        PRIMARY KEY (archive_id, chat_position, position),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_script_state]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_script_state] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        [key] NVARCHAR(450) NOT NULL,
        value_type NVARCHAR(32) NOT NULL CHECK (value_type IN ('text', 'number', 'boolean')),
        text_value NVARCHAR(MAX),
        number_value FLOAT,
        boolean_value BIT,
        PRIMARY KEY (archive_id, chat_position, [key]),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_bookmarks]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_bookmarks] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        position INT NOT NULL,
        message_id NVARCHAR(450) NOT NULL,
        name NVARCHAR(MAX),
        PRIMARY KEY (archive_id, chat_position, position),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_memory]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_memory] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        memory_type NVARCHAR(128) NOT NULL,
        payload NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, chat_position, memory_type),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_lore_entries]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_lore_entries] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        position INT NOT NULL,
        lore_id NVARCHAR(450),
        primary_key NVARCHAR(450) NOT NULL DEFAULT '',
        secondary_key NVARCHAR(MAX) NOT NULL DEFAULT '',
        insert_order INT NOT NULL DEFAULT 0,
        comment NVARCHAR(MAX) NOT NULL DEFAULT '',
        content NVARCHAR(MAX) NOT NULL DEFAULT '',
        mode NVARCHAR(64) NOT NULL DEFAULT 'normal',
        always_active BIT NOT NULL DEFAULT 0,
        selective BIT NOT NULL DEFAULT 0,
        case_sensitive BIT,
        activation_percent FLOAT,
        use_regex BIT,
        book_version INT,
        folder NVARCHAR(450),
        cache_payload NVARCHAR(MAX),
        PRIMARY KEY (archive_id, chat_position, position),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[chat_lore_cache_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[chat_lore_cache_items] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        lore_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, chat_position, lore_position, position),
        FOREIGN KEY (archive_id, chat_position, lore_position)
            REFERENCES [cold].[chat_lore_entries](archive_id, chat_position, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[messages]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[messages] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        original_message_id NVARCHAR(450),
        role NVARCHAR(32) NOT NULL CHECK (role IN ('user', 'char')),
        content_text NVARCHAR(MAX),
        content_binary VARBINARY(MAX),
        saying_character_id NVARCHAR(MAX),
        sent_time BIGINT,
        sender_name NVARCHAR(MAX),
        other_user BIT,
        disabled_scope NVARCHAR(32) CHECK (disabled_scope IN ('false', 'true', 'allBefore')),
        is_comment BIT,
        PRIMARY KEY (archive_id, chat_position, position),
        FOREIGN KEY (archive_id, chat_position) REFERENCES [cold].[chats](archive_id, position) ON DELETE CASCADE,
        CHECK (
            (content_text IS NOT NULL AND content_binary IS NULL)
            OR (content_text IS NULL AND content_binary IS NOT NULL)
        )
    );
    CREATE INDEX cold_messages_role_idx ON [cold].[messages] (role);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[message_attributes]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[message_attributes] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        message_position INT NOT NULL,
        [key] NVARCHAR(450) NOT NULL,
        value NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, chat_position, message_position, [key]),
        FOREIGN KEY (archive_id, chat_position, message_position)
            REFERENCES [cold].[messages](archive_id, chat_position, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[message_generation]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[message_generation] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        message_position INT NOT NULL,
        model NVARCHAR(512),
        generation_id NVARCHAR(450),
        input_tokens INT,
        output_tokens INT,
        max_context INT,
        stage1_time FLOAT,
        stage2_time FLOAT,
        stage3_time FLOAT,
        stage4_time FLOAT,
        PRIMARY KEY (archive_id, chat_position, message_position),
        FOREIGN KEY (archive_id, chat_position, message_position)
            REFERENCES [cold].[messages](archive_id, chat_position, position) ON DELETE CASCADE
    );
    CREATE INDEX cold_message_generation_model_idx ON [cold].[message_generation] (model);
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[message_prompt_info]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[message_prompt_info] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        message_position INT NOT NULL,
        prompt_name NVARCHAR(MAX),
        PRIMARY KEY (archive_id, chat_position, message_position),
        FOREIGN KEY (archive_id, chat_position, message_position)
            REFERENCES [cold].[messages](archive_id, chat_position, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[message_prompt_toggles]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[message_prompt_toggles] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        message_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        toggle_key NVARCHAR(450) NOT NULL,
        toggle_value NVARCHAR(MAX),
        PRIMARY KEY (archive_id, chat_position, message_position, position),
        FOREIGN KEY (archive_id, chat_position, message_position)
            REFERENCES [cold].[messages](archive_id, chat_position, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[message_prompt_items]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[message_prompt_items] (
        archive_id NVARCHAR(64) NOT NULL,
        chat_position INT NOT NULL,
        message_position INT NOT NULL,
        position INT NOT NULL CHECK (position >= 0),
        payload NVARCHAR(MAX) NOT NULL,
        PRIMARY KEY (archive_id, chat_position, message_position, position),
        FOREIGN KEY (archive_id, chat_position, message_position)
            REFERENCES [cold].[messages](archive_id, chat_position, position) ON DELETE CASCADE
    );
END;

IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[cold].[legacy_imports]') AND type in (N'U'))
BEGIN
    CREATE TABLE [cold].[legacy_imports] (
        id NVARCHAR(64) PRIMARY KEY,
        imported_at DATETIMEOFFSET NOT NULL DEFAULT SYSDATETIMEOFFSET()
    );
END;

-- ============================================================
-- 뷰: [chat].[all_messages]
-- ============================================================

IF OBJECT_ID(N'[chat].[all_messages]', 'V') IS NOT NULL DROP VIEW [chat].[all_messages];
IF OBJECT_ID(N'[chat].[all_messages]', 'U') IS NOT NULL DROP TABLE [chat].[all_messages];
IF OBJECT_ID(N'[dbo].[all_messages]', 'V') IS NOT NULL DROP VIEW [dbo].[all_messages];
IF OBJECT_ID(N'[dbo].[all_messages]', 'U') IS NOT NULL DROP TABLE [dbo].[all_messages];

EXEC('
CREATE OR ALTER VIEW [chat].[all_messages] AS
SELECT
    ''active'' AS storage_state,
    CAST(NULL AS NVARCHAR(64)) AS archive_id,
    chat_id,
    id AS message_id,
    position,
    role,
    content_text,
    content_binary,
    sent_time,
    sender_name
FROM [chat].[messages]
UNION ALL
SELECT
    ''cold'' AS storage_state,
    archive_id,
    CAST(NULL AS NVARCHAR(450)) AS chat_id,
    original_message_id AS message_id,
    position,
    role,
    content_text,
    content_binary,
    sent_time,
    sender_name
FROM [cold].[messages];
');
