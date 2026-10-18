import {
  decodePostgresJsonValue,
  encodePostgresJsonValue,
} from "./postgresJsonCodec.ts";

const CHARACTER_SCALARS: any = {
  name: "name",
  image: "image",
  firstMessage: "first_message",
  desc: "description",
  notes: "notes",
  creatorNotes: "creator_notes",
  systemPrompt: "system_prompt",
  postHistoryInstructions: "post_history_instructions",
  personality: "personality",
  scenario: "scenario",
  exampleMessage: "example_message",
  creator: "creator",
  characterVersion: "character_version",
  nickname: "nickname",
  viewScreen: "view_screen",
  chatPage: "chat_page",
  firstMsgIndex: "first_message_index",
  utilityBot: "utility_bot",
  private: "is_private",
  realmId: "realm_id",
  license: "license",
  defaultVariables: "default_variables",
  additionalText: "additional_text",
  translatorNote: "translator_note",
  backgroundHTML: "background_html",
  backgroundCSS: "background_css",
  creation_date: "creation_time",
  modification_date: "modification_time",
  lastInteraction: "last_interaction_time",
  trashTime: "trash_time",
};

const CHAT_SCALARS: any = {
  name: "name",
  note: "note",
  sdData: "sd_data",
  supaMemoryData: "supa_memory_data",
  lastMemory: "last_memory",
  isStreaming: "is_streaming",
  activeStreamingDisplayOptimizationMode: "streaming_optimization_mode",
  bindedPersona: "bound_persona_id",
  fmIndex: "first_message_index",
  folderId: "folder_id",
  lastDate: "last_message_time",
};
const CHARACTER_BIGINT_COLUMNS: any = new Set([
  "creation_time",
  "modification_time",
  "last_interaction_time",
  "trash_time",
]);

function own(object?: any, key?: any): any {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function encodeJson(value?: any): any {
  return encodePostgresJsonValue(value);
}

function decodeJson(value?: any): any {
  if (typeof value === "string") {
    try {
      return decodePostgresJsonValue(JSON.parse(value));
    } catch (e: any) {
      return decodePostgresJsonValue(value);
    }
  }
  return decodePostgresJsonValue(value);
}

function containsNul(value?: any, seen: any = new Set()): any {
  if (typeof value === "string") return value.includes("\0");
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return (Object.entries(value) as [string, any][]).some(
    ([key, item]: any) => key.includes("\0") || containsNul(item, seen),
  );
}

function relationalArray(source?: any, property?: any, attributes?: any): any {
  const value: any = source[property] || [];
  if (containsNul(value)) {
    attributes.push({ key: property, value: encodeJson(value) });
    return [];
  }
  return value;
}

function extractScalarProperties(
  source?: any,
  mappings?: any,
  core?: any,
  attributes?: any,
): any {
  for (const [property, column] of Object.entries(mappings) as [
    string,
    any,
  ][]) {
    if (!own(source, property)) {
      continue;
    }
    const value: any = source[property];
    delete source[property];
    if (typeof value === "string" && value.includes("\0")) {
      attributes.push({ key: property, value: encodeJson(value) });
      continue;
    }
    core[column] = value ?? null;
  }
}

function remainingAttributes(source?: any): any {
  return (Object.entries(source) as [string, any][]).map(
    ([key, value]: any) => ({
      key,
      value: encodeJson(value),
    }),
  );
}

function encodeSetting(key?: any, value?: any): any {
  const row: any = {
    key,
    value_type: "null",
    text_value: null,
    number_value: null,
    boolean_value: null,
    json_value: undefined,
  };
  if (value === null || value === undefined) {
    return row;
  }
  if (typeof value === "string" && !value.includes("\0")) {
    row.value_type = "text";
    row.text_value = value;
    return row;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    row.value_type = "number";
    row.number_value = value;
    return row;
  }
  if (typeof value === "boolean") {
    row.value_type = "boolean";
    row.boolean_value = value;
    return row;
  }
  row.value_type = "json";
  row.json_value = encodeJson(value);
  return row;
}

function decodeSetting(row?: any): any {
  switch (row.value_type) {
    case "null":
      return null;
    case "text":
      return row.text_value;
    case "number":
      return Number(row.number_value);
    case "boolean":
      return row.boolean_value;
    case "json":
      return decodeJson(row.json_value);
    default:
      throw new Error(`Unknown PostgreSQL setting type: ${row.value_type}`);
  }
}

function splitLore(owner?: any, entries: any = []): any {
  return entries.map((entry?: any, position?: any) => ({
    ...owner,
    position,
    lore_id: entry.id ?? null,
    primary_key: entry.key ?? "",
    secondary_key: entry.secondkey ?? "",
    insert_order: entry.insertorder ?? 0,
    comment: entry.comment ?? "",
    content: entry.content ?? "",
    mode: entry.mode ?? "normal",
    always_active: entry.alwaysActive ?? false,
    selective: entry.selective ?? false,
    case_sensitive: entry.extentions?.risu_case_sensitive ?? null,
    activation_percent: entry.activationPercent ?? null,
    use_regex: entry.useRegex ?? null,
    book_version: entry.bookVersion ?? null,
    folder: entry.folder ?? null,
    cache_payload:
      entry.loreCache === undefined ? null : encodeJson(entry.loreCache),
  }));
}

function rebuildLore(row?: any): any {
  const lore: any = {
    key: row.primary_key,
    secondkey: row.secondary_key,
    insertorder: row.insert_order,
    comment: row.comment,
    content: row.content,
    mode: row.mode,
    alwaysActive: row.always_active,
    selective: row.selective,
  };
  if (row.case_sensitive !== null)
    lore.extentions = { risu_case_sensitive: row.case_sensitive };
  if (row.activation_percent !== null)
    lore.activationPercent = Number(row.activation_percent);
  if (row.use_regex !== null) lore.useRegex = row.use_regex;
  if (row.book_version !== null) lore.bookVersion = row.book_version;
  if (row.lore_id !== null) lore.id = row.lore_id;
  if (row.folder !== null) lore.folder = row.folder;
  if (row.cache_payload !== null)
    lore.loreCache = decodeJson(row.cache_payload);
  return lore;
}

function splitCharacter(row?: any): any {
  const source: any = { ...row.data };
  const attributes: any = [];
  const core: any = {
    id: row.id,
    position: row.position,
    kind: source.type === "group" ? "group" : "character",
    name: "",
    first_message: "",
    chat_page: 0,
  };
  delete source.type;
  extractScalarProperties(source, CHARACTER_SCALARS, core, attributes);
  core.name ??= "";
  core.first_message ??= "";
  core.chat_page ??= 0;

  const tags: any = relationalArray(source, "tags", attributes).map(
    (tag?: any, position?: any) => ({ character_id: row.id, position, tag }),
  );
  const greetings: any = [
    ...relationalArray(source, "alternateGreetings", attributes).map(
      (content?: any, position?: any) => ({
        character_id: row.id,
        greeting_type: "alternate",
        position,
        content,
      }),
    ),
    ...relationalArray(source, "group_only_greetings", attributes).map(
      (content?: any, position?: any) => ({
        character_id: row.id,
        greeting_type: "group-only",
        position,
        content,
      }),
    ),
  ];
  const biases: any = relationalArray(source, "bias", attributes).map(
    ([phrase, bias]: any, position?: any) => ({
      character_id: row.id,
      position,
      phrase,
      bias,
    }),
  );
  const emotions: any = relationalArray(
    source,
    "emotionImages",
    attributes,
  ).map(([emotion, asset]: any, position?: any) => ({
    character_id: row.id,
    position,
    emotion,
    asset,
  }));
  const modules: any = relationalArray(source, "modules", attributes).map(
    (moduleId?: any, position?: any) => ({
      character_id: row.id,
      position,
      module_id: moduleId,
    }),
  );
  const groupCharacters: any = relationalArray(
    source,
    "characters",
    attributes,
  );
  const groupTalks: any = relationalArray(source, "characterTalks", attributes);
  const groupActive: any = relationalArray(
    source,
    "characterActive",
    attributes,
  );
  const groupMembers: any = groupCharacters.map(
    (characterId?: any, position?: any) => ({
      group_id: row.id,
      position,
      character_id: characterId,
      talk_weight: groupTalks[position] ?? null,
      active: groupActive[position] ?? null,
    }),
  );
  const chatFolders: any = relationalArray(
    source,
    "chatFolders",
    attributes,
  ).map((folder?: any, position?: any) => ({
    character_id: row.id,
    position,
    folder_id: folder.id,
    name: folder.name ?? null,
    color: folder.color ?? null,
    folded: folder.folded ?? false,
  }));
  const scripts: any = [
    ...relationalArray(source, "customscript", attributes).map(
      (script?: any, position?: any) => ({
        character_id: row.id,
        script_kind: "custom",
        position,
        comment: script.comment ?? null,
        input_text: script.in ?? null,
        output_text: script.out ?? null,
        script_type: script.type ?? null,
        flag: script.flag ?? null,
        able_flag: script.ableFlag ?? null,
        trigger_payload: null,
      }),
    ),
    ...relationalArray(source, "triggerscript", attributes).map(
      (script?: any, position?: any) => ({
        character_id: row.id,
        script_kind: "trigger",
        position,
        comment: script.comment ?? null,
        input_text: script.in ?? null,
        output_text: script.out ?? null,
        script_type: script.type ?? null,
        flag: script.flag ?? null,
        able_flag: script.ableFlag ?? null,
        trigger_payload: encodeJson(script),
      }),
    ),
  ];
  const sdData: any = relationalArray(source, "sdData", attributes).map(
    ([key, value]: any, position?: any) => ({
      character_id: row.id,
      position,
      key,
      value,
    }),
  );
  const assets: any = [
    ...relationalArray(source, "additionalAssets", attributes).map(
      (asset?: any, position?: any) => ({
        character_id: row.id,
        position,
        asset_source: "additional",
        asset_type: null,
        uri: asset[1] ?? null,
        name: asset[0] ?? null,
        extension: asset[2] ?? null,
        extra_value: null,
      }),
    ),
    ...relationalArray(source, "ccAssets", attributes).map(
      (asset?: any, offset?: any) => ({
        character_id: row.id,
        position: (source.additionalAssets?.length || 0) + offset,
        asset_source: "character-card",
        asset_type: asset.type ?? null,
        uri: asset.uri ?? null,
        name: asset.name ?? null,
        extension: asset.ext ?? null,
        extra_value: null,
      }),
    ),
  ];
  const lore: any = splitLore(
    { character_id: row.id },
    relationalArray(source, "globalLore", attributes),
  );

  for (const key of [
    "tags",
    "alternateGreetings",
    "group_only_greetings",
    "bias",
    "emotionImages",
    "modules",
    "characters",
    "characterTalks",
    "characterActive",
    "chatFolders",
    "customscript",
    "triggerscript",
    "sdData",
    "additionalAssets",
    "ccAssets",
    "globalLore",
  ])
    delete source[key];

  attributes.push(...remainingAttributes(source));
  return {
    core,
    attributes,
    tags,
    greetings,
    biases,
    emotions,
    modules,
    groupMembers,
    chatFolders,
    scripts,
    sdData,
    assets,
    lore,
  };
}

function splitChat(row?: any): any {
  const source: any = { ...row.data };
  const attributes: any = [];
  const core: any = {
    id: row.id,
    character_id: row.characterId,
    position: row.position,
    name: "",
    note: "",
  };
  extractScalarProperties(source, CHAT_SCALARS, core, attributes);
  core.name ??= "";
  core.note ??= "";
  const suggestions: any = relationalArray(
    source,
    "suggestMessages",
    attributes,
  ).map((content?: any, position?: any) => ({
    chat_id: row.id,
    position,
    content,
  }));
  const modules: any = relationalArray(source, "modules", attributes).map(
    (moduleId?: any, position?: any) => ({
      chat_id: row.id,
      position,
      module_id: moduleId,
    }),
  );
  const scriptState: any = [];
  if (
    source.scriptstate &&
    typeof source.scriptstate === "object" &&
    containsNul(source.scriptstate)
  ) {
    attributes.push({
      key: "scriptstate",
      value: encodeJson(source.scriptstate),
    });
  } else if (source.scriptstate && typeof source.scriptstate === "object") {
    for (const [key, value] of Object.entries(source.scriptstate) as [
      string,
      any,
    ][]) {
      if (typeof value === "string" && !value.includes("\0")) {
        scriptState.push({
          chat_id: row.id,
          key,
          value_type: "text",
          text_value: value,
          number_value: null,
          boolean_value: null,
        });
      } else if (typeof value === "number" && Number.isFinite(value)) {
        scriptState.push({
          chat_id: row.id,
          key,
          value_type: "number",
          text_value: null,
          number_value: value,
          boolean_value: null,
        });
      } else if (typeof value === "boolean") {
        scriptState.push({
          chat_id: row.id,
          key,
          value_type: "boolean",
          text_value: null,
          number_value: null,
          boolean_value: value,
        });
      } else {
        attributes.push({
          key: "scriptstate",
          value: encodeJson(source.scriptstate),
        });
        scriptState.length = 0;
        break;
      }
    }
  }
  const unsafeBookmarkNames: any = containsNul(source.bookmarkNames);
  if (unsafeBookmarkNames)
    attributes.push({
      key: "bookmarkNames",
      value: encodeJson(source.bookmarkNames),
    });
  const bookmarks: any = relationalArray(source, "bookmarks", attributes).map(
    (messageId?: any, position?: any) => ({
      chat_id: row.id,
      position,
      message_id: messageId,
      name: unsafeBookmarkNames
        ? null
        : (source.bookmarkNames?.[messageId] ?? null),
    }),
  );
  const memory: any = [];
  for (const [property, memoryType] of [
    ["hypaV2Data", "hypa-v2"],
    ["hypaV3Data", "hypa-v3"],
  ]) {
    if (own(source, property)) {
      memory.push({
        chat_id: row.id,
        memory_type: memoryType,
        payload: encodeJson(source[property]),
      });
    }
  }
  const lore: any = splitLore(
    { chat_id: row.id },
    relationalArray(source, "localLore", attributes),
  );
  for (const key of [
    "suggestMessages",
    "modules",
    "scriptstate",
    "bookmarks",
    "bookmarkNames",
    "hypaV2Data",
    "hypaV3Data",
    "localLore",
  ])
    delete source[key];
  attributes.push(...remainingAttributes(source));
  return {
    core,
    attributes,
    suggestions,
    modules,
    scriptState,
    bookmarks,
    memory,
    lore,
  };
}

function splitMessage(row?: any): any {
  const source: any = { ...row.data };
  const attributes: any = [];
  const safeText: any = (property?: any) => {
    const value: any = source[property];
    if (typeof value === "string" && value.includes("\0")) {
      attributes.push({ key: property, value: encodeJson(value) });
      return null;
    }
    return value ?? null;
  };
  const content: any =
    typeof source.data === "string" ? source.data : String(source.data ?? "");
  const core: any = {
    chat_id: row.chatId,
    id: row.id,
    position: row.position,
    role: source.role === "char" ? "char" : "user",
    content_text: content.includes("\0") ? null : content,
    content_binary: content.includes("\0")
      ? Buffer.from(content, "utf16le")
      : null,
    saying_character_id: safeText("saying"),
    sent_time: source.time ?? null,
    sender_name: safeText("name"),
    other_user: source.otherUser ?? null,
    disabled_scope:
      source.disabled === undefined ? null : String(source.disabled),
    is_comment: source.isComment ?? null,
  };
  const generationInfo: any = containsNul(source.generationInfo)
    ? null
    : source.generationInfo;
  if (source.generationInfo && generationInfo === null) {
    attributes.push({
      key: "generationInfo",
      value: encodeJson(source.generationInfo),
    });
  }
  const generation: any = generationInfo
    ? {
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
      }
    : null;
  const promptInfo: any = containsNul(source.promptInfo)
    ? null
    : source.promptInfo;
  if (source.promptInfo && promptInfo === null) {
    attributes.push({
      key: "promptInfo",
      value: encodeJson(source.promptInfo),
    });
  }
  const prompt: any = promptInfo
    ? {
        info: {
          chat_id: row.chatId,
          message_id: row.id,
          prompt_name: promptInfo.promptName ?? null,
        },
        toggles: (promptInfo.promptToggles || []).map(
          (toggle?: any, position?: any) => ({
            chat_id: row.chatId,
            message_id: row.id,
            position,
            toggle_key: toggle.key,
            toggle_value: toggle.value,
          }),
        ),
        items: (promptInfo.promptText || []).map(
          (payload?: any, position?: any) => ({
            chat_id: row.chatId,
            message_id: row.id,
            position,
            payload: encodeJson(payload),
          }),
        ),
      }
    : null;
  for (const key of [
    "role",
    "data",
    "saying",
    "time",
    "name",
    "otherUser",
    "disabled",
    "isComment",
    "generationInfo",
    "promptInfo",
  ]) {
    delete source[key];
  }
  attributes.push(...remainingAttributes(source));
  return { core, attributes, generation, prompt };
}

function applyAttributes(target?: any, rows?: any): any {
  for (const row of rows || []) target[row.key] = decodeJson(row.value);
}

const SHALLOW_CHARACTER_SCALARS: any = {
  name: "name",
  image: "image",
  creatorNotes: "creator_notes",
  creator: "creator",
  characterVersion: "character_version",
  nickname: "nickname",
  viewScreen: "view_screen",
  chatPage: "chat_page",
  firstMsgIndex: "first_message_index",
  utilityBot: "utility_bot",
  private: "is_private",
  realmId: "realm_id",
  license: "license",
  creation_date: "creation_time",
  modification_date: "modification_time",
  lastInteraction: "last_interaction_time",
  trashTime: "trash_time",
};

const SHALLOW_CHAT_SCALARS: any = {
  name: "name",
  note: "note",
  folderId: "folder_id",
  fmIndex: "first_message_index",
  bindedPersona: "bound_persona_id",
  lastDate: "last_message_time",
};

function rebuildCharacter(
  row?: any,
  related: any = {},
  options: any = {},
  ...legacyRelations: any[]
): any {
  const character: any = {};
  if (row.kind === "group") character.type = "group";
  const scalarMap: any = options.shallow
    ? SHALLOW_CHARACTER_SCALARS
    : CHARACTER_SCALARS;
  for (const [property, column] of Object.entries(scalarMap) as [
    string,
    any,
  ][]) {
    if (row[column] !== null && row[column] !== undefined) {
      character[property] = CHARACTER_BIGINT_COLUMNS.has(column)
        ? Number(row[column])
        : row[column];
    }
  }
  character.name ??= "";
  character.chatPage ??= 0;
  character.tags = (related.tags || []).map((item?: any) => item.tag);
  if (row.kind === "group") {
    character.characters = (related.groupMembers || []).map(
      (item?: any) => item.character_id,
    );
    character.characterTalks = (related.groupMembers || []).map((item?: any) =>
      item.talk_weight === null ? 0 : Number(item.talk_weight),
    );
    character.characterActive = (related.groupMembers || []).map(
      (item?: any) => item.active ?? true,
    );
  }
  character.chatFolders = (related.chatFolders || []).map((item?: any) => ({
    id: item.folder_id,
    ...(item.name === null ? {} : { name: item.name }),
    ...(item.color === null ? {} : { color: item.color }),
    folded: item.folded,
  }));

  if (!options.shallow) {
    character.firstMessage ??= "";
    character.alternateGreetings = (related.greetings || [])
      .filter((item?: any) => item.greeting_type === "alternate")
      .map((item?: any) => item.content);
    if (
      (related.greetings || []).some(
        (item?: any) => item.greeting_type === "group-only",
      )
    ) {
      character.group_only_greetings = related.greetings
        .filter((item?: any) => item.greeting_type === "group-only")
        .map((item?: any) => item.content);
    }
    character.bias = (related.biases || []).map((item?: any) => [
      item.phrase,
      Number(item.bias),
    ]);
    character.emotionImages = (related.emotions || []).map((item?: any) => [
      item.emotion,
      item.asset,
    ]);
    character.modules = (related.modules || []).map(
      (item?: any) => item.module_id,
    );
    character.customscript = (related.scripts || [])
      .filter((item?: any) => item.script_kind === "custom")
      .map((item?: any) => ({
        comment: item.comment ?? "",
        in: item.input_text ?? "",
        out: item.output_text ?? "",
        type: item.script_type ?? "",
        ...(item.flag === null ? {} : { flag: item.flag }),
        ...(item.able_flag === null ? {} : { ableFlag: item.able_flag }),
      }));
    character.triggerscript = (related.scripts || [])
      .filter((item?: any) => item.script_kind === "trigger")
      .map((item?: any) => decodeJson(item.trigger_payload));
    character.sdData = (related.sdData || []).map((item?: any) => [
      item.key,
      item.value,
    ]);
    const additionalAssets: any = (related.assets || [])
      .filter((item?: any) => item.asset_source === "additional")
      .map((item?: any) => [item.name, item.uri, item.extension]);
    if (additionalAssets.length) character.additionalAssets = additionalAssets;
    const ccAssets: any = (related.assets || [])
      .filter((item?: any) => item.asset_source === "character-card")
      .map((item?: any) => ({
        type: item.asset_type,
        uri: item.uri,
        name: item.name,
        ext: item.extension,
      }));
    if (ccAssets.length) character.ccAssets = ccAssets;
    character.globalLore = (related.lore || []).map(rebuildLore);
    applyAttributes(character, related.attributes);
  }

  character.chaId = row.id;
  character.chats = related.chats || [];
  return character;
}

function rebuildChat(
  row?: any,
  related: any = {},
  options: any = {},
  ...legacyRelations: any[]
): any {
  const chat: any = {};
  const scalarMap: any = options.shallow ? SHALLOW_CHAT_SCALARS : CHAT_SCALARS;
  for (const [property, column] of Object.entries(scalarMap) as [
    string,
    any,
  ][]) {
    if (row[column] !== null && row[column] !== undefined) {
      chat[property] =
        column === "last_message_time" ? Number(row[column]) : row[column];
    }
  }
  chat.name ??= "";
  chat.note ??= "";
  if ((related.bookmarks || []).length) {
    chat.bookmarks = related.bookmarks.map((item?: any) => item.message_id);
    chat.bookmarkNames = {};
    for (const item of related.bookmarks)
      if (item.name !== null) chat.bookmarkNames[item.message_id] = item.name;
  }

  if (!options.shallow) {
    chat.localLore = (related.lore || []).map(rebuildLore);
    if ((related.suggestions || []).length)
      chat.suggestMessages = related.suggestions.map(
        (item?: any) => item.content,
      );
    if ((related.modules || []).length)
      chat.modules = related.modules.map((item?: any) => item.module_id);
    if ((related.scriptState || []).length) {
      chat.scriptstate = {};
      for (const item of related.scriptState) {
        chat.scriptstate[item.key] =
          item.value_type === "text"
            ? item.text_value
            : item.value_type === "number"
              ? Number(item.number_value)
              : item.boolean_value;
      }
    }
    for (const item of related.memory || []) {
      chat[item.memory_type === "hypa-v2" ? "hypaV2Data" : "hypaV3Data"] =
        decodeJson(item.payload);
    }
    applyAttributes(chat, related.attributes);
  }

  chat.id = row.id;
  chat.message = related.messages || [];
  return chat;
}

function rebuildMessage(
  row?: any,
  related: any = {},
  ...legacyRelations: any[]
): any {
  const content: any =
    row.content_binary === null
      ? row.content_text
      : Buffer.from(row.content_binary).toString("utf16le");
  const message: any = { role: row.role, data: content };
  if (row.saying_character_id !== null)
    message.saying = row.saying_character_id;
  if (row.sent_time !== null) message.time = Number(row.sent_time);
  if (row.sender_name !== null) message.name = row.sender_name;
  if (row.other_user !== null) message.otherUser = row.other_user;
  if (row.disabled_scope !== null)
    message.disabled =
      row.disabled_scope === "false"
        ? false
        : row.disabled_scope === "true"
          ? true
          : "allBefore";
  if (row.is_comment !== null) message.isComment = row.is_comment;
  if (related.generation) {
    const generation: any = related.generation;
    message.generationInfo = {};
    for (const [column, property] of [
      ["model", "model"],
      ["generation_id", "generationId"],
      ["input_tokens", "inputTokens"],
      ["output_tokens", "outputTokens"],
      ["max_context", "maxContext"],
    ]) {
      if (generation[column] !== null)
        message.generationInfo[property] = generation[column];
    }
    const timing: any = {};
    for (const [column, property] of [
      ["stage1_time", "stage1"],
      ["stage2_time", "stage2"],
      ["stage3_time", "stage3"],
      ["stage4_time", "stage4"],
    ]) {
      if (generation[column] !== null)
        timing[property] = Number(generation[column]);
    }
    if (Object.keys(timing).length) message.generationInfo.stageTiming = timing;
  }
  if (related.promptInfo) {
    message.promptInfo = {};
    if (related.promptInfo.prompt_name !== null)
      message.promptInfo.promptName = related.promptInfo.prompt_name;
    if ((related.promptToggles || []).length)
      message.promptInfo.promptToggles = related.promptToggles.map(
        (item?: any) => ({
          key: item.toggle_key,
          value: item.toggle_value,
        }),
      );
    if ((related.promptItems || []).length)
      message.promptInfo.promptText = related.promptItems.map((item?: any) =>
        decodeJson(item.payload),
      );
  }
  applyAttributes(message, related.attributes);
  message.chatId = row.id;
  return message;
}

export {
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
