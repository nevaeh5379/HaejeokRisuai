const {
    decodePostgresJsonValue,
    encodePostgresJsonValue,
} = require('./postgresJsonCodec.cjs');

const CHARACTER_SCALARS = {
    name: 'name',
    image: 'image',
    firstMessage: 'first_message',
    desc: 'description',
    notes: 'notes',
    creatorNotes: 'creator_notes',
    systemPrompt: 'system_prompt',
    postHistoryInstructions: 'post_history_instructions',
    personality: 'personality',
    scenario: 'scenario',
    exampleMessage: 'example_message',
    creator: 'creator',
    characterVersion: 'character_version',
    nickname: 'nickname',
    viewScreen: 'view_screen',
    chatPage: 'chat_page',
    firstMsgIndex: 'first_message_index',
    utilityBot: 'utility_bot',
    private: 'is_private',
    realmId: 'realm_id',
    license: 'license',
    defaultVariables: 'default_variables',
    additionalText: 'additional_text',
    translatorNote: 'translator_note',
    backgroundHTML: 'background_html',
    backgroundCSS: 'background_css',
    creation_date: 'creation_time',
    modification_date: 'modification_time',
    lastInteraction: 'last_interaction_time',
    trashTime: 'trash_time',
};

const CHAT_SCALARS = {
    name: 'name',
    note: 'note',
    sdData: 'sd_data',
    supaMemoryData: 'supa_memory_data',
    lastMemory: 'last_memory',
    isStreaming: 'is_streaming',
    activeStreamingDisplayOptimizationMode: 'streaming_optimization_mode',
    bindedPersona: 'bound_persona_id',
    fmIndex: 'first_message_index',
    folderId: 'folder_id',
    lastDate: 'last_message_time',
};
const CHARACTER_BIGINT_COLUMNS = new Set([
    'creation_time', 'modification_time', 'last_interaction_time', 'trash_time',
]);

function own(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function encodeJson(value) {
    return encodePostgresJsonValue(value);
}

function decodeJson(value) {
    return decodePostgresJsonValue(value);
}

function containsNul(value, seen = new Set()) {
    if (typeof value === 'string') return value.includes('\0');
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    return Object.entries(value).some(([key, item]) => key.includes('\0') || containsNul(item, seen));
}

function relationalArray(source, property, attributes) {
    const value = source[property] || [];
    if (containsNul(value)) {
        attributes.push({ key: property, value: encodeJson(value) });
        return [];
    }
    return value;
}

function extractScalarProperties(source, mappings, core, attributes) {
    for (const [property, column] of Object.entries(mappings)) {
        if (!own(source, property)) {
            continue;
        }
        const value = source[property];
        delete source[property];
        if (typeof value === 'string' && value.includes('\0')) {
            attributes.push({ key: property, value: encodeJson(value) });
            continue;
        }
        core[column] = value ?? null;
    }
}

function remainingAttributes(source) {
    return Object.entries(source).map(([key, value]) => ({
        key,
        value: encodeJson(value),
    }));
}

function encodeSetting(key, value) {
    const row = {
        key,
        value_type: 'null',
        text_value: null,
        number_value: null,
        boolean_value: null,
        json_value: undefined,
    };
    if (value === null || value === undefined) {
        return row;
    }
    if (typeof value === 'string' && !value.includes('\0')) {
        row.value_type = 'text';
        row.text_value = value;
        return row;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        row.value_type = 'number';
        row.number_value = value;
        return row;
    }
    if (typeof value === 'boolean') {
        row.value_type = 'boolean';
        row.boolean_value = value;
        return row;
    }
    row.value_type = 'json';
    row.json_value = encodeJson(value);
    return row;
}

function decodeSetting(row) {
    switch (row.value_type) {
        case 'null': return null;
        case 'text': return row.text_value;
        case 'number': return Number(row.number_value);
        case 'boolean': return row.boolean_value;
        case 'json': return decodeJson(row.json_value);
        default: throw new Error(`Unknown PostgreSQL setting type: ${row.value_type}`);
    }
}

function splitLore(owner, entries = []) {
    return entries.map((entry, position) => ({
        ...owner,
        position,
        lore_id: entry.id ?? null,
        primary_key: entry.key ?? '',
        secondary_key: entry.secondkey ?? '',
        insert_order: entry.insertorder ?? 0,
        comment: entry.comment ?? '',
        content: entry.content ?? '',
        mode: entry.mode ?? 'normal',
        always_active: entry.alwaysActive ?? false,
        selective: entry.selective ?? false,
        case_sensitive: entry.extentions?.risu_case_sensitive ?? null,
        activation_percent: entry.activationPercent ?? null,
        use_regex: entry.useRegex ?? null,
        book_version: entry.bookVersion ?? null,
        folder: entry.folder ?? null,
        cache_payload: entry.loreCache === undefined ? null : encodeJson(entry.loreCache),
    }));
}

function rebuildLore(row) {
    const lore = {
        key: row.primary_key,
        secondkey: row.secondary_key,
        insertorder: row.insert_order,
        comment: row.comment,
        content: row.content,
        mode: row.mode,
        alwaysActive: row.always_active,
        selective: row.selective,
    };
    if (row.case_sensitive !== null) lore.extentions = { risu_case_sensitive: row.case_sensitive };
    if (row.activation_percent !== null) lore.activationPercent = Number(row.activation_percent);
    if (row.use_regex !== null) lore.useRegex = row.use_regex;
    if (row.book_version !== null) lore.bookVersion = row.book_version;
    if (row.lore_id !== null) lore.id = row.lore_id;
    if (row.folder !== null) lore.folder = row.folder;
    if (row.cache_payload !== null) lore.loreCache = decodeJson(row.cache_payload);
    return lore;
}

function splitCharacter(row) {
    const source = { ...row.data };
    const attributes = [];
    const core = {
        id: row.id,
        position: row.position,
        kind: source.type === 'group' ? 'group' : 'character',
        name: '',
        first_message: '',
        chat_page: 0,
    };
    delete source.type;
    extractScalarProperties(source, CHARACTER_SCALARS, core, attributes);
    core.name ??= '';
    core.first_message ??= '';
    core.chat_page ??= 0;

    const tags = relationalArray(source, 'tags', attributes).map((tag, position) => ({ character_id: row.id, position, tag }));
    const greetings = [
        ...relationalArray(source, 'alternateGreetings', attributes).map((content, position) => ({
            character_id: row.id, greeting_type: 'alternate', position, content,
        })),
        ...relationalArray(source, 'group_only_greetings', attributes).map((content, position) => ({
            character_id: row.id, greeting_type: 'group-only', position, content,
        })),
    ];
    const biases = relationalArray(source, 'bias', attributes).map(([phrase, bias], position) => ({
        character_id: row.id, position, phrase, bias,
    }));
    const emotions = relationalArray(source, 'emotionImages', attributes).map(([emotion, asset], position) => ({
        character_id: row.id, position, emotion, asset,
    }));
    const modules = relationalArray(source, 'modules', attributes).map((moduleId, position) => ({
        character_id: row.id, position, module_id: moduleId,
    }));
    const groupCharacters = relationalArray(source, 'characters', attributes);
    const groupTalks = relationalArray(source, 'characterTalks', attributes);
    const groupActive = relationalArray(source, 'characterActive', attributes);
    const groupMembers = groupCharacters.map((characterId, position) => ({
        group_id: row.id,
        position,
        character_id: characterId,
        talk_weight: groupTalks[position] ?? null,
        active: groupActive[position] ?? null,
    }));
    const chatFolders = relationalArray(source, 'chatFolders', attributes).map((folder, position) => ({
        character_id: row.id,
        position,
        folder_id: folder.id,
        name: folder.name ?? null,
        color: folder.color ?? null,
        folded: folder.folded ?? false,
    }));
    const scripts = [
        ...relationalArray(source, 'customscript', attributes).map((script, position) => ({
            character_id: row.id,
            script_kind: 'custom',
            position,
            comment: script.comment ?? null,
            input_text: script.in ?? null,
            output_text: script.out ?? null,
            script_type: script.type ?? null,
            flag: script.flag ?? null,
            able_flag: script.ableFlag ?? null,
            trigger_payload: null,
        })),
        ...relationalArray(source, 'triggerscript', attributes).map((script, position) => ({
            character_id: row.id,
            script_kind: 'trigger',
            position,
            comment: script.comment ?? null,
            input_text: script.in ?? null,
            output_text: script.out ?? null,
            script_type: script.type ?? null,
            flag: script.flag ?? null,
            able_flag: script.ableFlag ?? null,
            trigger_payload: encodeJson(script),
        })),
    ];
    const sdData = relationalArray(source, 'sdData', attributes).map(([key, value], position) => ({
        character_id: row.id, position, key, value,
    }));
    const assets = [
        ...relationalArray(source, 'additionalAssets', attributes).map((asset, position) => ({
            character_id: row.id, position, asset_source: 'additional', asset_type: null,
            uri: asset[1] ?? null, name: asset[0] ?? null, extension: asset[2] ?? null,
            extra_value: null,
        })),
        ...relationalArray(source, 'ccAssets', attributes).map((asset, offset) => ({
            character_id: row.id,
            position: (source.additionalAssets?.length || 0) + offset,
            asset_source: 'character-card', asset_type: asset.type ?? null,
            uri: asset.uri ?? null, name: asset.name ?? null,
            extension: asset.ext ?? null, extra_value: null,
        })),
    ];
    const lore = splitLore({ character_id: row.id }, relationalArray(source, 'globalLore', attributes));

    for (const key of [
        'tags', 'alternateGreetings', 'group_only_greetings', 'bias', 'emotionImages', 'modules',
        'characters', 'characterTalks', 'characterActive', 'chatFolders', 'customscript',
        'triggerscript', 'sdData', 'additionalAssets', 'ccAssets', 'globalLore',
    ]) delete source[key];

    attributes.push(...remainingAttributes(source));
    return { core, attributes, tags, greetings, biases, emotions, modules, groupMembers, chatFolders, scripts, sdData, assets, lore };
}

function splitChat(row) {
    const source = { ...row.data };
    const attributes = [];
    const core = {
        id: row.id,
        character_id: row.characterId,
        position: row.position,
        name: '',
        note: '',
    };
    extractScalarProperties(source, CHAT_SCALARS, core, attributes);
    core.name ??= '';
    core.note ??= '';
    const suggestions = relationalArray(source, 'suggestMessages', attributes).map((content, position) => ({
        chat_id: row.id, position, content,
    }));
    const modules = relationalArray(source, 'modules', attributes).map((moduleId, position) => ({
        chat_id: row.id, position, module_id: moduleId,
    }));
    const scriptState = [];
    if (source.scriptstate && typeof source.scriptstate === 'object' && containsNul(source.scriptstate)) {
        attributes.push({ key: 'scriptstate', value: encodeJson(source.scriptstate) });
    } else if (source.scriptstate && typeof source.scriptstate === 'object') {
        for (const [key, value] of Object.entries(source.scriptstate)) {
            if (typeof value === 'string' && !value.includes('\0')) {
                scriptState.push({ chat_id: row.id, key, value_type: 'text', text_value: value, number_value: null, boolean_value: null });
            } else if (typeof value === 'number' && Number.isFinite(value)) {
                scriptState.push({ chat_id: row.id, key, value_type: 'number', text_value: null, number_value: value, boolean_value: null });
            } else if (typeof value === 'boolean') {
                scriptState.push({ chat_id: row.id, key, value_type: 'boolean', text_value: null, number_value: null, boolean_value: value });
            } else {
                attributes.push({ key: 'scriptstate', value: encodeJson(source.scriptstate) });
                scriptState.length = 0;
                break;
            }
        }
    }
    const unsafeBookmarkNames = containsNul(source.bookmarkNames);
    if (unsafeBookmarkNames) attributes.push({ key: 'bookmarkNames', value: encodeJson(source.bookmarkNames) });
    const bookmarks = relationalArray(source, 'bookmarks', attributes).map((messageId, position) => ({
        chat_id: row.id,
        position,
        message_id: messageId,
        name: unsafeBookmarkNames ? null : source.bookmarkNames?.[messageId] ?? null,
    }));
    const memory = [];
    for (const [property, memoryType] of [['hypaV2Data', 'hypa-v2'], ['hypaV3Data', 'hypa-v3']]) {
        if (own(source, property)) {
            memory.push({ chat_id: row.id, memory_type: memoryType, payload: encodeJson(source[property]) });
        }
    }
    const lore = splitLore({ chat_id: row.id }, relationalArray(source, 'localLore', attributes));
    for (const key of [
        'suggestMessages', 'modules', 'scriptstate', 'bookmarks', 'bookmarkNames',
        'hypaV2Data', 'hypaV3Data', 'localLore',
    ]) delete source[key];
    attributes.push(...remainingAttributes(source));
    return { core, attributes, suggestions, modules, scriptState, bookmarks, memory, lore };
}

function splitMessage(row) {
    const source = { ...row.data };
    const attributes = [];
    const safeText = (property) => {
        const value = source[property];
        if (typeof value === 'string' && value.includes('\0')) {
            attributes.push({ key: property, value: encodeJson(value) });
            return null;
        }
        return value ?? null;
    };
    const content = typeof source.data === 'string' ? source.data : String(source.data ?? '');
    const core = {
        chat_id: row.chatId,
        id: row.id,
        position: row.position,
        role: source.role === 'char' ? 'char' : 'user',
        content_text: content.includes('\0') ? null : content,
        content_binary: content.includes('\0') ? Buffer.from(content, 'utf16le') : null,
        saying_character_id: safeText('saying'),
        sent_time: source.time ?? null,
        sender_name: safeText('name'),
        other_user: source.otherUser ?? null,
        disabled_scope: source.disabled === undefined ? null : String(source.disabled),
        is_comment: source.isComment ?? null,
    };
    const generationInfo = containsNul(source.generationInfo) ? null : source.generationInfo;
    if (source.generationInfo && generationInfo === null) {
        attributes.push({ key: 'generationInfo', value: encodeJson(source.generationInfo) });
    }
    const generation = generationInfo ? {
        chat_id: row.chatId,
        message_id: row.id,
        model: generationInfo.model ?? null,
        generation_id: generationInfo.generationId ?? null,
        input_tokens: generationInfo.inputTokens ?? null,
        output_tokens: generationInfo.outputTokens ?? null,
        max_context: generationInfo.maxContext ?? null,
        stage1_time: generationInfo.stageTiming?.stage1 ?? null,
        stage2_time: generationInfo.stageTiming?.stage2 ?? null,
        stage3_time: generationInfo.stageTiming?.stage3 ?? null,
        stage4_time: generationInfo.stageTiming?.stage4 ?? null,
    } : null;
    const promptInfo = containsNul(source.promptInfo) ? null : source.promptInfo;
    if (source.promptInfo && promptInfo === null) {
        attributes.push({ key: 'promptInfo', value: encodeJson(source.promptInfo) });
    }
    const prompt = promptInfo ? {
        info: { chat_id: row.chatId, message_id: row.id, prompt_name: promptInfo.promptName ?? null },
        toggles: (promptInfo.promptToggles || []).map((toggle, position) => ({
            chat_id: row.chatId, message_id: row.id, position,
            toggle_key: toggle.key, toggle_value: toggle.value,
        })),
        items: (promptInfo.promptText || []).map((payload, position) => ({
            chat_id: row.chatId, message_id: row.id, position, payload: encodeJson(payload),
        })),
    } : null;
    for (const key of ['role', 'data', 'saying', 'time', 'name', 'otherUser', 'disabled', 'isComment', 'generationInfo', 'promptInfo']) {
        delete source[key];
    }
    attributes.push(...remainingAttributes(source));
    return { core, attributes, generation, prompt };
}

function applyAttributes(target, rows) {
    for (const row of rows || []) target[row.key] = decodeJson(row.value);
}

function rebuildCharacter(row, related = {}) {
    const character = {};
    if (row.kind === 'group') character.type = 'group';
    for (const [property, column] of Object.entries(CHARACTER_SCALARS)) {
        if (row[column] !== null && row[column] !== undefined) {
            character[property] = CHARACTER_BIGINT_COLUMNS.has(column) ? Number(row[column]) : row[column];
        }
    }
    character.name ??= '';
    character.firstMessage ??= '';
    character.chatPage ??= 0;
    character.tags = (related.tags || []).map((item) => item.tag);
    character.alternateGreetings = (related.greetings || []).filter((item) => item.greeting_type === 'alternate').map((item) => item.content);
    if ((related.greetings || []).some((item) => item.greeting_type === 'group-only')) {
        character.group_only_greetings = related.greetings.filter((item) => item.greeting_type === 'group-only').map((item) => item.content);
    }
    character.bias = (related.biases || []).map((item) => [item.phrase, Number(item.bias)]);
    character.emotionImages = (related.emotions || []).map((item) => [item.emotion, item.asset]);
    character.modules = (related.modules || []).map((item) => item.module_id);
    if (row.kind === 'group') {
        character.characters = (related.groupMembers || []).map((item) => item.character_id);
        character.characterTalks = (related.groupMembers || []).map((item) => item.talk_weight === null ? 0 : Number(item.talk_weight));
        character.characterActive = (related.groupMembers || []).map((item) => item.active ?? true);
    }
    character.chatFolders = (related.chatFolders || []).map((item) => ({
        id: item.folder_id, ...(item.name === null ? {} : { name: item.name }),
        ...(item.color === null ? {} : { color: item.color }), folded: item.folded,
    }));
    character.customscript = (related.scripts || []).filter((item) => item.script_kind === 'custom').map((item) => ({
        comment: item.comment ?? '', in: item.input_text ?? '', out: item.output_text ?? '', type: item.script_type ?? '',
        ...(item.flag === null ? {} : { flag: item.flag }), ...(item.able_flag === null ? {} : { ableFlag: item.able_flag }),
    }));
    character.triggerscript = (related.scripts || []).filter((item) => item.script_kind === 'trigger').map((item) => decodeJson(item.trigger_payload));
    character.sdData = (related.sdData || []).map((item) => [item.key, item.value]);
    const additionalAssets = (related.assets || []).filter((item) => item.asset_source === 'additional').map((item) => [item.name, item.uri, item.extension]);
    if (additionalAssets.length) character.additionalAssets = additionalAssets;
    const ccAssets = (related.assets || []).filter((item) => item.asset_source === 'character-card').map((item) => ({
        type: item.asset_type, uri: item.uri, name: item.name, ext: item.extension,
    }));
    if (ccAssets.length) character.ccAssets = ccAssets;
    character.globalLore = (related.lore || []).map(rebuildLore);
    applyAttributes(character, related.attributes);
    character.chaId = row.id;
    character.chats = related.chats || [];
    return character;
}

function rebuildChat(row, related = {}) {
    const chat = {};
    for (const [property, column] of Object.entries(CHAT_SCALARS)) {
        if (row[column] !== null && row[column] !== undefined) {
            chat[property] = column === 'last_message_time' ? Number(row[column]) : row[column];
        }
    }
    chat.name ??= '';
    chat.note ??= '';
    chat.localLore = (related.lore || []).map(rebuildLore);
    if ((related.suggestions || []).length) chat.suggestMessages = related.suggestions.map((item) => item.content);
    if ((related.modules || []).length) chat.modules = related.modules.map((item) => item.module_id);
    if ((related.scriptState || []).length) {
        chat.scriptstate = {};
        for (const item of related.scriptState) {
            chat.scriptstate[item.key] = item.value_type === 'text' ? item.text_value
                : item.value_type === 'number' ? Number(item.number_value) : item.boolean_value;
        }
    }
    if ((related.bookmarks || []).length) {
        chat.bookmarks = related.bookmarks.map((item) => item.message_id);
        chat.bookmarkNames = {};
        for (const item of related.bookmarks) if (item.name !== null) chat.bookmarkNames[item.message_id] = item.name;
    }
    for (const item of related.memory || []) {
        chat[item.memory_type === 'hypa-v2' ? 'hypaV2Data' : 'hypaV3Data'] = decodeJson(item.payload);
    }
    applyAttributes(chat, related.attributes);
    chat.id = row.id;
    chat.message = related.messages || [];
    return chat;
}

function rebuildMessage(row, related = {}) {
    const content = row.content_binary === null
        ? row.content_text
        : Buffer.from(row.content_binary).toString('utf16le');
    const message = { role: row.role, data: content };
    if (row.saying_character_id !== null) message.saying = row.saying_character_id;
    if (row.sent_time !== null) message.time = Number(row.sent_time);
    if (row.sender_name !== null) message.name = row.sender_name;
    if (row.other_user !== null) message.otherUser = row.other_user;
    if (row.disabled_scope !== null) message.disabled = row.disabled_scope === 'false' ? false : row.disabled_scope === 'true' ? true : 'allBefore';
    if (row.is_comment !== null) message.isComment = row.is_comment;
    if (related.generation) {
        const generation = related.generation;
        message.generationInfo = {};
        for (const [column, property] of [['model', 'model'], ['generation_id', 'generationId'], ['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['max_context', 'maxContext']]) {
            if (generation[column] !== null) message.generationInfo[property] = generation[column];
        }
        const timing = {};
        for (const [column, property] of [['stage1_time', 'stage1'], ['stage2_time', 'stage2'], ['stage3_time', 'stage3'], ['stage4_time', 'stage4']]) {
            if (generation[column] !== null) timing[property] = Number(generation[column]);
        }
        if (Object.keys(timing).length) message.generationInfo.stageTiming = timing;
    }
    if (related.promptInfo) {
        message.promptInfo = {};
        if (related.promptInfo.prompt_name !== null) message.promptInfo.promptName = related.promptInfo.prompt_name;
        if ((related.promptToggles || []).length) message.promptInfo.promptToggles = related.promptToggles.map((item) => ({ key: item.toggle_key, value: item.toggle_value }));
        if ((related.promptItems || []).length) message.promptInfo.promptText = related.promptItems.map((item) => decodeJson(item.payload));
    }
    applyAttributes(message, related.attributes);
    message.chatId = row.id;
    return message;
}

module.exports = {
    decodeSetting,
    encodeSetting,
    rebuildCharacter,
    rebuildChat,
    rebuildLore,
    rebuildMessage,
    splitCharacter,
    splitChat,
    splitLore,
    splitMessage,
};
