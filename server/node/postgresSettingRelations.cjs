const { canUsePostgresText } = require('./postgresSettingsCodec.cjs');

const DEFINITIONS = [
    {
        table: 'system.bot_presets',
        columns: [
            'setting_key', 'position', 'name', 'api_type', 'ai_model', 'sub_model', 'main_prompt',
            'jailbreak', 'global_note', 'temperature', 'max_context', 'max_response',
            'frequency_penalty', 'presence_penalty', 'prompt_preprocess', 'proxy_model',
            'openrouter_model', 'image',
        ],
        types: [
            'text', 'integer', 'text', 'text', 'text', 'text', 'text', 'text', 'text',
            'double precision', 'integer', 'integer', 'double precision', 'double precision',
            'boolean', 'text', 'text', 'text',
        ],
    },
    {
        table: 'system.personas',
        columns: [
            'setting_key', 'position', 'persona_id', 'name', 'prompt', 'icon', 'large_portrait',
            'note', 'embedded_module_id',
        ],
        types: ['text', 'integer', 'text', 'text', 'text', 'text', 'boolean', 'text', 'text'],
    },
    {
        table: 'system.modules',
        columns: [
            'setting_key', 'position', 'module_id', 'name', 'description', 'cjs',
            'low_level_access', 'hide_icon', 'background_embedding', 'namespace',
            'custom_toggle', 'mcp_url', 'icon',
        ],
        types: [
            'text', 'integer', 'text', 'text', 'text', 'text', 'boolean', 'boolean', 'text',
            'text', 'text', 'text', 'text',
        ],
    },
    {
        table: 'system.plugins',
        columns: [
            'setting_key', 'position', 'name', 'display_name', 'script', 'api_version',
            'plugin_version', 'update_url', 'enabled',
        ],
        types: ['text', 'integer', 'text', 'text', 'text', 'text', 'text', 'text', 'boolean'],
    },
    {
        table: 'system.global_lorebooks',
        columns: ['setting_key', 'position', 'name'],
        types: ['text', 'integer', 'text'],
    },
    {
        table: 'system.global_lore_entries',
        columns: [
            'setting_key', 'book_position', 'position', 'lore_id', 'primary_key', 'secondary_key',
            'insert_order', 'comment', 'content', 'mode', 'always_active', 'selective',
            'case_sensitive', 'activation_percent', 'use_regex', 'book_version', 'folder',
            'cache_key',
        ],
        types: [
            'text', 'integer', 'integer', 'text', 'text', 'text', 'integer', 'text', 'text',
            'text', 'boolean', 'boolean', 'boolean', 'double precision', 'boolean', 'integer',
            'text', 'text',
        ],
    },
    {
        table: 'system.global_lore_cache_items',
        columns: ['setting_key', 'book_position', 'lore_position', 'position', 'value'],
        types: ['text', 'integer', 'integer', 'integer', 'text'],
    },
    {
        table: 'system.translator_presets',
        columns: ['setting_key', 'position', 'name', 'prompt', 'max_response'],
        types: ['text', 'integer', 'text', 'text', 'integer'],
    },
    {
        table: 'system.hotkeys',
        columns: ['setting_key', 'position', 'key', 'control', 'shift', 'alt', 'action'],
        types: ['text', 'integer', 'text', 'boolean', 'boolean', 'boolean', 'text'],
    },
    {
        table: 'system.custom_models',
        columns: [
            'setting_key', 'position', 'id', 'internal_id', 'url', 'format', 'tokenizer',
            'api_key', 'name', 'params',
        ],
        types: ['text', 'integer', 'text', 'text', 'text', 'integer', 'integer', 'text', 'text', 'text'],
    },
    {
        table: 'system.custom_model_flags',
        columns: ['setting_key', 'model_position', 'position', 'flag'],
        types: ['text', 'integer', 'integer', 'integer'],
    },
    {
        table: 'system.loadouts',
        columns: [
            'setting_key', 'position', 'id', 'name', 'last_used', 'favorite', 'preset_name',
            'persona_id', 'icons_present',
        ],
        types: ['text', 'integer', 'text', 'text', 'bigint', 'boolean', 'text', 'text', 'boolean'],
    },
    {
        table: 'system.loadout_character_refs',
        columns: ['setting_key', 'loadout_position', 'position', 'character_id'],
        types: ['text', 'integer', 'integer', 'text'],
    },
    {
        table: 'system.loadout_module_refs',
        columns: ['setting_key', 'loadout_position', 'position', 'module_id'],
        types: ['text', 'integer', 'integer', 'text'],
    },
    {
        table: 'system.loadout_variables',
        columns: ['setting_key', 'loadout_position', 'key', 'value'],
        types: ['text', 'integer', 'text', 'text'],
    },
    {
        table: 'system.loadout_icons',
        columns: ['setting_key', 'loadout_position', 'position', 'asset_id'],
        types: ['text', 'integer', 'integer', 'text'],
    },
    {
        table: 'system.custom_sidebar_items',
        columns: ['setting_key', 'position', 'id', 'item_type', 'subtype', 'label'],
        types: ['text', 'integer', 'text', 'text', 'text', 'text'],
    },
    {
        table: 'system.ordered_text_settings',
        columns: ['setting_key', 'position', 'value'],
        types: ['text', 'integer', 'text'],
    },
    {
        table: 'system.ordered_number_settings',
        columns: ['setting_key', 'position', 'value'],
        types: ['text', 'integer', 'double precision'],
    },
    {
        table: 'system.string_map_settings',
        columns: ['setting_key', 'key', 'value'],
        types: ['text', 'text', 'text'],
    },
    {
        table: 'system.bias_entries',
        columns: ['setting_key', 'position', 'phrase', 'bias'],
        types: ['text', 'integer', 'text', 'double precision'],
    },
    {
        table: 'system.additional_parameters',
        columns: ['setting_key', 'position', 'key', 'value'],
        types: ['text', 'integer', 'text', 'text'],
    },
    {
        table: 'system.fallback_models',
        columns: ['setting_key', 'category', 'position', 'model'],
        types: ['text', 'text', 'integer', 'text'],
    },
    {
        table: 'system.openrouter_provider_rules',
        columns: ['setting_key', 'rule_type', 'position', 'provider'],
        types: ['text', 'text', 'integer', 'text'],
    },
];

const ORDERED_TEXT_KEYS = new Set([
    'formatingOrder', 'localStopStrings', 'enabledModules', 'banCharacterset', 'modelTools',
]);
const STRING_MAP_KEYS = new Set(['globalChatVariables', 'OaiCompAPIKeys', 'seperateModels']);
const TABLE_SETTING_KEYS = {
    'system.bot_presets': ['botPresets'],
    'system.personas': ['personas'],
    'system.modules': ['modules'],
    'system.plugins': ['plugins', 'pluginV2'],
    'system.global_lorebooks': ['loreBook'],
    'system.global_lore_entries': ['loreBook'],
    'system.global_lore_cache_items': ['loreBook'],
    'system.translator_presets': ['translatorPresets'],
    'system.hotkeys': ['hotkeys'],
    'system.custom_models': ['customModels'],
    'system.custom_model_flags': ['customModels'],
    'system.loadouts': ['loadouts'],
    'system.loadout_character_refs': ['loadouts'],
    'system.loadout_module_refs': ['loadouts'],
    'system.loadout_variables': ['loadouts'],
    'system.loadout_icons': ['loadouts'],
    'system.custom_sidebar_items': ['customSidebarItems'],
    'system.ordered_text_settings': [...ORDERED_TEXT_KEYS],
    'system.ordered_number_settings': ['customFlags'],
    'system.string_map_settings': [...STRING_MAP_KEYS],
    'system.bias_entries': ['bias'],
    'system.additional_parameters': ['additionalParams'],
    'system.fallback_models': ['fallbackModels'],
    'system.openrouter_provider_rules': ['openrouterProvider'],
};

for (const definition of DEFINITIONS) {
    definition.settingKeys = TABLE_SETTING_KEYS[definition.table];
}

function text(value) {
    return typeof value === 'string' && canUsePostgresText(value) ? value : null;
}

function scalarText(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return text(value);
}

function number(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boolean(value) {
    return typeof value === 'boolean' ? value : null;
}

function array(value) {
    return Array.isArray(value) ? value : [];
}

function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function projectSettings(upserts) {
    const rows = Object.fromEntries(DEFINITIONS.map((definition) => [definition.table, []]));
    for (const { key, value } of upserts) {
        if (key === 'botPresets') {
            for (const [position, rawPreset] of array(value).entries()) {
                const preset = record(rawPreset);
                rows['system.bot_presets'].push({
                    setting_key: key,
                    position,
                    name: text(preset.name),
                    api_type: text(preset.apiType),
                    ai_model: text(preset.aiModel),
                    sub_model: text(preset.subModel),
                    main_prompt: text(preset.mainPrompt),
                    jailbreak: text(preset.jailbreak),
                    global_note: text(preset.globalNote),
                    temperature: number(preset.temperature),
                    max_context: number(preset.maxContext),
                    max_response: number(preset.maxResponse),
                    frequency_penalty: number(preset.frequencyPenalty),
                    presence_penalty: number(preset.PresensePenalty),
                    prompt_preprocess: boolean(preset.promptPreprocess),
                    proxy_model: text(preset.proxyRequestModel),
                    openrouter_model: text(preset.openrouterRequestModel),
                    image: text(preset.image),
                });
            }
            continue;
        }
        if (key === 'personas') {
            for (const [position, rawPersona] of array(value).entries()) {
                const persona = record(rawPersona);
                const embeddedModule = record(persona.embeddedModule);
                rows['system.personas'].push({
                    setting_key: key, position, persona_id: text(persona.id), name: text(persona.name),
                    prompt: text(persona.personaPrompt), icon: text(persona.icon),
                    large_portrait: boolean(persona.largePortrait), note: text(persona.note),
                    embedded_module_id: text(embeddedModule.id),
                });
            }
            continue;
        }
        if (key === 'modules') {
            for (const [position, rawModule] of array(value).entries()) {
                const module = record(rawModule);
                const mcp = record(module.mcp);
                rows['system.modules'].push({
                    setting_key: key, position, module_id: text(module.id), name: text(module.name),
                    description: text(module.description), cjs: text(module.cjs),
                    low_level_access: boolean(module.lowLevelAccess), hide_icon: boolean(module.hideIcon),
                    background_embedding: text(module.backgroundEmbedding),
                    namespace: text(module.namespace), custom_toggle: text(module.customModuleToggle),
                    mcp_url: text(mcp.url), icon: text(module.icon),
                });
            }
            continue;
        }
        if (key === 'plugins' || key === 'pluginV2') {
            for (const [position, rawPlugin] of array(value).entries()) {
                const plugin = record(rawPlugin);
                rows['system.plugins'].push({
                    setting_key: key, position, name: text(plugin.name),
                    display_name: text(plugin.displayName), script: text(plugin.script),
                    api_version: scalarText(plugin.version), plugin_version: text(plugin.versionOfPlugin),
                    update_url: text(plugin.updateURL), enabled: boolean(plugin.enabled),
                });
            }
            continue;
        }
        if (key === 'loreBook') {
            for (const [bookPosition, rawBook] of array(value).entries()) {
                const book = record(rawBook);
                rows['system.global_lorebooks'].push({
                    setting_key: key, position: bookPosition, name: text(book.name),
                });
                for (const [lorePosition, rawLore] of array(book.data).entries()) {
                    const lore = record(rawLore);
                    const extensions = record(lore.extentions);
                    const cache = record(lore.loreCache);
                    rows['system.global_lore_entries'].push({
                        setting_key: key,
                        book_position: bookPosition,
                        position: lorePosition,
                        lore_id: text(lore.id),
                        primary_key: text(lore.key),
                        secondary_key: text(lore.secondkey),
                        insert_order: number(lore.insertorder),
                        comment: text(lore.comment),
                        content: text(lore.content),
                        mode: text(lore.mode),
                        always_active: boolean(lore.alwaysActive),
                        selective: boolean(lore.selective),
                        case_sensitive: boolean(extensions.risu_case_sensitive),
                        activation_percent: number(lore.activationPercent),
                        use_regex: boolean(lore.useRegex),
                        book_version: number(lore.bookVersion),
                        folder: text(lore.folder),
                        cache_key: text(cache.key),
                    });
                    for (const [cachePosition, cacheValue] of array(cache.data).entries()) {
                        const projected = text(cacheValue);
                        if (projected === null) continue;
                        rows['system.global_lore_cache_items'].push({
                            setting_key: key,
                            book_position: bookPosition,
                            lore_position: lorePosition,
                            position: cachePosition,
                            value: projected,
                        });
                    }
                }
            }
            continue;
        }
        if (key === 'translatorPresets') {
            for (const [position, rawPreset] of array(value).entries()) {
                const preset = record(rawPreset);
                rows['system.translator_presets'].push({
                    setting_key: key, position, name: text(preset.name), prompt: text(preset.prompt),
                    max_response: number(preset.maxResponse),
                });
            }
            continue;
        }
        if (key === 'hotkeys') {
            for (const [position, rawHotkey] of array(value).entries()) {
                const hotkey = record(rawHotkey);
                rows['system.hotkeys'].push({
                    setting_key: key, position, key: text(hotkey.key), control: boolean(hotkey.ctrl),
                    shift: boolean(hotkey.shift), alt: boolean(hotkey.alt), action: text(hotkey.action),
                });
            }
            continue;
        }
        if (key === 'customModels') {
            for (const [position, rawModel] of array(value).entries()) {
                const model = record(rawModel);
                rows['system.custom_models'].push({
                    setting_key: key, position, id: text(model.id), internal_id: text(model.internalId),
                    url: text(model.url), format: number(model.format), tokenizer: number(model.tokenizer),
                    api_key: text(model.key), name: text(model.name), params: text(model.params),
                });
                for (const [flagPosition, flag] of array(model.flags).entries()) {
                    const projected = number(flag);
                    if (projected === null) continue;
                    rows['system.custom_model_flags'].push({
                        setting_key: key, model_position: position, position: flagPosition, flag: projected,
                    });
                }
            }
            continue;
        }
        if (key === 'loadouts') {
            for (const [position, rawLoadout] of array(value).entries()) {
                const loadout = record(rawLoadout);
                rows['system.loadouts'].push({
                    setting_key: key, position, id: text(loadout.id), name: text(loadout.name),
                    last_used: number(loadout.lastUsed), favorite: boolean(loadout.favorite),
                    preset_name: text(loadout.presetName), persona_id: text(loadout.personaId),
                    icons_present: Object.prototype.hasOwnProperty.call(loadout, 'icons'),
                });
                for (const [refPosition, characterId] of array(loadout.characterIds).entries()) {
                    const projected = text(characterId);
                    if (projected !== null) rows['system.loadout_character_refs'].push({
                        setting_key: key, loadout_position: position, position: refPosition,
                        character_id: projected,
                    });
                }
                for (const [refPosition, moduleId] of array(loadout.modules).entries()) {
                    const projected = text(moduleId);
                    if (projected !== null) rows['system.loadout_module_refs'].push({
                        setting_key: key, loadout_position: position, position: refPosition,
                        module_id: projected,
                    });
                }
                for (const [variableKey, variableValue] of Object.entries(record(loadout.globalVariables))) {
                    const projectedKey = text(variableKey);
                    const projectedValue = text(variableValue);
                    if (projectedKey !== null && projectedValue !== null) rows['system.loadout_variables'].push({
                        setting_key: key, loadout_position: position, key: projectedKey,
                        value: projectedValue,
                    });
                }
                for (const [iconPosition, assetId] of array(loadout.icons).entries()) {
                    const projected = text(assetId);
                    if (projected !== null) rows['system.loadout_icons'].push({
                        setting_key: key, loadout_position: position, position: iconPosition,
                        asset_id: projected,
                    });
                }
            }
            continue;
        }
        if (key === 'customSidebarItems') {
            for (const [position, rawItem] of array(value).entries()) {
                const item = record(rawItem);
                rows['system.custom_sidebar_items'].push({
                    setting_key: key, position, id: text(item.id), item_type: text(item.type),
                    subtype: text(item.subType), label: text(item.label),
                });
            }
            continue;
        }
        if (ORDERED_TEXT_KEYS.has(key)) {
            for (const [position, item] of array(value).entries()) {
                const projected = text(item);
                if (projected !== null) rows['system.ordered_text_settings'].push({
                    setting_key: key, position, value: projected,
                });
            }
            continue;
        }
        if (key === 'customFlags') {
            for (const [position, item] of array(value).entries()) {
                const projected = number(item);
                if (projected !== null) rows['system.ordered_number_settings'].push({
                    setting_key: key, position, value: projected,
                });
            }
            continue;
        }
        if (STRING_MAP_KEYS.has(key)) {
            for (const [mapKey, mapValue] of Object.entries(record(value))) {
                const projectedKey = text(mapKey);
                const projectedValue = text(mapValue);
                if (projectedKey !== null && projectedValue !== null) rows['system.string_map_settings'].push({
                    setting_key: key, key: projectedKey, value: projectedValue,
                });
            }
            continue;
        }
        if (key === 'bias') {
            for (const [position, item] of array(value).entries()) {
                const phrase = text(array(item)[0]);
                const bias = number(array(item)[1]);
                if (phrase !== null && bias !== null) rows['system.bias_entries'].push({
                    setting_key: key, position, phrase, bias,
                });
            }
            continue;
        }
        if (key === 'additionalParams') {
            for (const [position, item] of array(value).entries()) {
                const parameterKey = text(array(item)[0]);
                const parameterValue = text(array(item)[1]);
                if (parameterKey !== null && parameterValue !== null) rows['system.additional_parameters'].push({
                    setting_key: key, position, key: parameterKey, value: parameterValue,
                });
            }
            continue;
        }
        if (key === 'fallbackModels') {
            for (const [category, models] of Object.entries(record(value))) {
                const projectedCategory = text(category);
                if (projectedCategory === null) continue;
                for (const [position, model] of array(models).entries()) {
                    const projectedModel = text(model);
                    if (projectedModel !== null) rows['system.fallback_models'].push({
                        setting_key: key, category: projectedCategory, position, model: projectedModel,
                    });
                }
            }
            continue;
        }
        if (key === 'openrouterProvider') {
            for (const [ruleType, providers] of Object.entries(record(value))) {
                if (!['order', 'only', 'ignore'].includes(ruleType)) continue;
                const projectedType = text(ruleType);
                if (projectedType === null) continue;
                for (const [position, provider] of array(providers).entries()) {
                    const projectedProvider = text(provider);
                    if (projectedProvider !== null) rows['system.openrouter_provider_rules'].push({
                        setting_key: key, rule_type: projectedType, position,
                        provider: projectedProvider,
                    });
                }
            }
        }
    }
    return rows;
}

module.exports = {
    SETTING_RELATION_DEFINITIONS: DEFINITIONS,
    projectSettings,
};
