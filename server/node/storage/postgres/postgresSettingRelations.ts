import { canUsePostgresText } from "./postgresJsonCodec.ts";

const DEFINITIONS: any = [
  {
    table: "system.personas",
    columns: [
      "setting_key",
      "position",
      "persona_id",
      "name",
      "prompt",
      "icon",
      "large_portrait",
      "note",
      "embedded_module_id",
    ],
    types: [
      "text",
      "integer",
      "text",
      "text",
      "text",
      "text",
      "boolean",
      "text",
      "text",
    ],
  },
  {
    table: "system.modules",
    columns: [
      "setting_key",
      "position",
      "module_id",
      "name",
      "description",
      "cjs",
      "low_level_access",
      "hide_icon",
      "background_embedding",
      "namespace",
      "custom_toggle",
      "mcp_url",
      "icon",
    ],
    types: [
      "text",
      "integer",
      "text",
      "text",
      "text",
      "text",
      "boolean",
      "boolean",
      "text",
      "text",
      "text",
      "text",
      "text",
    ],
  },
  {
    table: "system.plugins",
    columns: [
      "setting_key",
      "position",
      "name",
      "display_name",
      "script",
      "api_version",
      "plugin_version",
      "update_url",
      "enabled",
    ],
    types: [
      "text",
      "integer",
      "text",
      "text",
      "text",
      "text",
      "text",
      "text",
      "boolean",
    ],
  },
  {
    table: "system.global_lorebooks",
    columns: ["setting_key", "position", "name"],
    types: ["text", "integer", "text"],
  },
  {
    table: "system.global_lore_entries",
    columns: [
      "setting_key",
      "book_position",
      "position",
      "lore_id",
      "primary_key",
      "secondary_key",
      "insert_order",
      "comment",
      "content",
      "mode",
      "always_active",
      "selective",
      "case_sensitive",
      "activation_percent",
      "use_regex",
      "book_version",
      "folder",
      "cache_key",
    ],
    types: [
      "text",
      "integer",
      "integer",
      "text",
      "text",
      "text",
      "integer",
      "text",
      "text",
      "text",
      "boolean",
      "boolean",
      "boolean",
      "double precision",
      "boolean",
      "integer",
      "text",
      "text",
    ],
  },
  {
    table: "system.global_lore_cache_items",
    columns: [
      "setting_key",
      "book_position",
      "lore_position",
      "position",
      "value",
    ],
    types: ["text", "integer", "integer", "integer", "text"],
  },
  {
    table: "system.translator_presets",
    columns: ["setting_key", "position", "name", "prompt", "max_response"],
    types: ["text", "integer", "text", "text", "integer"],
  },
  {
    table: "system.hotkeys",
    columns: [
      "setting_key",
      "position",
      "key",
      "control",
      "shift",
      "alt",
      "action",
    ],
    types: ["text", "integer", "text", "boolean", "boolean", "boolean", "text"],
  },
  {
    table: "system.custom_models",
    columns: [
      "setting_key",
      "position",
      "id",
      "internal_id",
      "url",
      "format",
      "tokenizer",
      "api_key",
      "name",
      "params",
    ],
    types: [
      "text",
      "integer",
      "text",
      "text",
      "text",
      "integer",
      "integer",
      "text",
      "text",
      "text",
    ],
  },
  {
    table: "system.custom_model_flags",
    columns: ["setting_key", "model_position", "position", "flag"],
    types: ["text", "integer", "integer", "integer"],
  },
  {
    table: "system.loadouts",
    columns: [
      "setting_key",
      "position",
      "id",
      "name",
      "last_used",
      "favorite",
      "preset_name",
      "persona_id",
      "icons_present",
    ],
    types: [
      "text",
      "integer",
      "text",
      "text",
      "bigint",
      "boolean",
      "text",
      "text",
      "boolean",
    ],
  },
  {
    table: "system.loadout_character_refs",
    columns: ["setting_key", "loadout_position", "position", "character_id"],
    types: ["text", "integer", "integer", "text"],
  },
  {
    table: "system.loadout_module_refs",
    columns: ["setting_key", "loadout_position", "position", "module_id"],
    types: ["text", "integer", "integer", "text"],
  },
  {
    table: "system.loadout_variables",
    columns: ["setting_key", "loadout_position", "key", "value"],
    types: ["text", "integer", "text", "text"],
  },
  {
    table: "system.loadout_icons",
    columns: ["setting_key", "loadout_position", "position", "asset_id"],
    types: ["text", "integer", "integer", "text"],
  },
  {
    table: "system.custom_sidebar_items",
    columns: ["setting_key", "position", "id", "item_type", "subtype", "label"],
    types: ["text", "integer", "text", "text", "text", "text"],
  },
  {
    table: "system.ordered_text_settings",
    columns: ["setting_key", "position", "value"],
    types: ["text", "integer", "text"],
  },
  {
    table: "system.ordered_number_settings",
    columns: ["setting_key", "position", "value"],
    types: ["text", "integer", "double precision"],
  },
  {
    table: "system.string_map_settings",
    columns: ["setting_key", "key", "value"],
    types: ["text", "text", "text"],
  },
  {
    table: "system.bias_entries",
    columns: ["setting_key", "position", "phrase", "bias"],
    types: ["text", "integer", "text", "double precision"],
  },
  {
    table: "system.additional_parameters",
    columns: ["setting_key", "position", "key", "value"],
    types: ["text", "integer", "text", "text"],
  },
  {
    table: "system.fallback_models",
    columns: ["setting_key", "category", "position", "model"],
    types: ["text", "text", "integer", "text"],
  },
  {
    table: "system.openrouter_provider_rules",
    columns: ["setting_key", "rule_type", "position", "provider"],
    types: ["text", "text", "integer", "text"],
  },
];

const ORDERED_TEXT_KEYS: any = new Set([
  "formatingOrder",
  "localStopStrings",
  "enabledModules",
  "banCharacterset",
  "modelTools",
]);
const STRING_MAP_KEYS: any = new Set([
  "globalChatVariables",
  "OaiCompAPIKeys",
  "seperateModels",
]);
const TABLE_SETTING_KEYS: any = {
  "system.personas": ["personas"],
  "system.modules": ["modules"],
  "system.plugins": ["plugins", "pluginV2"],
  "system.global_lorebooks": ["loreBook"],
  "system.global_lore_entries": ["loreBook"],
  "system.global_lore_cache_items": ["loreBook"],
  "system.translator_presets": ["translatorPresets"],
  "system.hotkeys": ["hotkeys"],
  "system.custom_models": ["customModels"],
  "system.custom_model_flags": ["customModels"],
  "system.loadouts": ["loadouts"],
  "system.loadout_character_refs": ["loadouts"],
  "system.loadout_module_refs": ["loadouts"],
  "system.loadout_variables": ["loadouts"],
  "system.loadout_icons": ["loadouts"],
  "system.custom_sidebar_items": ["customSidebarItems"],
  "system.ordered_text_settings": [...ORDERED_TEXT_KEYS],
  "system.ordered_number_settings": ["customFlags"],
  "system.string_map_settings": [...STRING_MAP_KEYS],
  "system.bias_entries": ["bias"],
  "system.additional_parameters": ["additionalParams"],
  "system.fallback_models": ["fallbackModels"],
  "system.openrouter_provider_rules": ["openrouterProvider"],
};

for (const definition of DEFINITIONS) {
  definition.settingKeys = TABLE_SETTING_KEYS[definition.table];
}

function text(value?: any): any {
  return typeof value === "string" && canUsePostgresText(value) ? value : null;
}

function scalarText(value?: any): any {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

function number(value?: any): any {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value?: any): any {
  return typeof value === "boolean" ? value : null;
}

function array(value?: any): any {
  return Array.isArray(value) ? value : [];
}

function record(value?: any): any {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function projectSettings(upserts?: any): any {
  const rows: any = Object.fromEntries(
    DEFINITIONS.map((definition?: any) => [definition.table, []]),
  );
  for (const { key, value } of upserts) {
    if (key === "personas") {
      const personasArr = array(value);
      for (let position = 0; position < personasArr.length; position++) {
        const rawPersona = personasArr[position];
        const persona: any = record(rawPersona);
        const embeddedModule: any = record(persona.embeddedModule);
        rows["system.personas"].push({
          setting_key: key,
          position,
          persona_id: text(persona.id),
          name: text(persona.name),
          prompt: text(persona.personaPrompt),
          icon: text(persona.icon),
          large_portrait: boolean(persona.largePortrait),
          note: text(persona.note),
          embedded_module_id: text(embeddedModule.id),
        });
      }
      continue;
    }
    if (key === "modules") {
      const modulesArr = array(value);
      for (let position = 0; position < modulesArr.length; position++) {
        const rawModule = modulesArr[position];
        const module: any = record(rawModule);
        const mcp: any = record(module.mcp);
        rows["system.modules"].push({
          setting_key: key,
          position,
          module_id: text(module.id),
          name: text(module.name),
          description: text(module.description),
          cjs: text(module.cjs),
          low_level_access: boolean(module.lowLevelAccess),
          hide_icon: boolean(module.hideIcon),
          background_embedding: text(module.backgroundEmbedding),
          namespace: text(module.namespace),
          custom_toggle: text(module.customModuleToggle),
          mcp_url: text(mcp.url),
          icon: text(module.icon),
        });
      }
      continue;
    }
    if (key === "plugins" || key === "pluginV2") {
      const pluginsArr = array(value);
      for (let position = 0; position < pluginsArr.length; position++) {
        const rawPlugin = pluginsArr[position];
        const plugin: any = record(rawPlugin);
        rows["system.plugins"].push({
          setting_key: key,
          position,
          name: text(plugin.name),
          display_name: text(plugin.displayName),
          script: text(plugin.script),
          api_version: scalarText(plugin.version),
          plugin_version: text(plugin.versionOfPlugin),
          update_url: text(plugin.updateURL),
          enabled: boolean(plugin.enabled),
        });
      }
      continue;
    }
    if (key === "loreBook") {
      const booksArr = array(value);
      for (
        let bookPosition = 0;
        bookPosition < booksArr.length;
        bookPosition++
      ) {
        const rawBook = booksArr[bookPosition];
        const book: any = record(rawBook);
        rows["system.global_lorebooks"].push({
          setting_key: key,
          position: bookPosition,
          name: text(book.name),
        });
        const loreArr = array(book.data);
        for (
          let lorePosition = 0;
          lorePosition < loreArr.length;
          lorePosition++
        ) {
          const rawLore = loreArr[lorePosition];
          const lore: any = record(rawLore);
          const extensions: any = record(lore.extentions);
          const cache: any = record(lore.loreCache);
          rows["system.global_lore_entries"].push({
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
          const cacheArr = array(cache.data);
          for (
            let cachePosition = 0;
            cachePosition < cacheArr.length;
            cachePosition++
          ) {
            const cacheValue = cacheArr[cachePosition];
            const projected: any = text(cacheValue);
            if (projected === null) continue;
            rows["system.global_lore_cache_items"].push({
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
    if (key === "translatorPresets") {
      const presetsArr = array(value);
      for (let position = 0; position < presetsArr.length; position++) {
        const rawPreset = presetsArr[position];
        const preset: any = record(rawPreset);
        rows["system.translator_presets"].push({
          setting_key: key,
          position,
          name: text(preset.name),
          prompt: text(preset.prompt),
          max_response: number(preset.maxResponse),
        });
      }
      continue;
    }
    if (key === "hotkeys") {
      const hotkeysArr = array(value);
      for (let position = 0; position < hotkeysArr.length; position++) {
        const rawHotkey = hotkeysArr[position];
        const hotkey: any = record(rawHotkey);
        rows["system.hotkeys"].push({
          setting_key: key,
          position,
          key: text(hotkey.key),
          control: boolean(hotkey.ctrl),
          shift: boolean(hotkey.shift),
          alt: boolean(hotkey.alt),
          action: text(hotkey.action),
        });
      }
      continue;
    }
    if (key === "customModels") {
      const modelsArr = array(value);
      for (let position = 0; position < modelsArr.length; position++) {
        const rawModel = modelsArr[position];
        const model: any = record(rawModel);
        rows["system.custom_models"].push({
          setting_key: key,
          position,
          id: text(model.id),
          internal_id: text(model.internalId),
          url: text(model.url),
          format: number(model.format),
          tokenizer: number(model.tokenizer),
          api_key: text(model.key),
          name: text(model.name),
          params: text(model.params),
        });
        const flagsArr = array(model.flags);
        for (
          let flagPosition = 0;
          flagPosition < flagsArr.length;
          flagPosition++
        ) {
          const flag = flagsArr[flagPosition];
          const projected: any = number(flag);
          if (projected === null) continue;
          rows["system.custom_model_flags"].push({
            setting_key: key,
            model_position: position,
            position: flagPosition,
            flag: projected,
          });
        }
      }
      continue;
    }
    if (key === "loadouts") {
      const loadoutsArr = array(value);
      for (let position = 0; position < loadoutsArr.length; position++) {
        const rawLoadout = loadoutsArr[position];
        const loadout: any = record(rawLoadout);
        rows["system.loadouts"].push({
          setting_key: key,
          position,
          id: text(loadout.id),
          name: text(loadout.name),
          last_used: number(loadout.lastUsed),
          favorite: boolean(loadout.favorite),
          preset_name: text(loadout.presetName),
          persona_id: text(loadout.personaId),
          icons_present: Object.prototype.hasOwnProperty.call(loadout, "icons"),
        });
        const charIdsArr = array(loadout.characterIds);
        for (
          let refPosition = 0;
          refPosition < charIdsArr.length;
          refPosition++
        ) {
          const characterId = charIdsArr[refPosition];
          const projected: any = text(characterId);
          if (projected !== null)
            rows["system.loadout_character_refs"].push({
              setting_key: key,
              loadout_position: position,
              position: refPosition,
              character_id: projected,
            });
        }
        const modulesArr = array(loadout.modules);
        for (
          let refPosition = 0;
          refPosition < modulesArr.length;
          refPosition++
        ) {
          const moduleId = modulesArr[refPosition];
          const projected: any = text(moduleId);
          if (projected !== null)
            rows["system.loadout_module_refs"].push({
              setting_key: key,
              loadout_position: position,
              position: refPosition,
              module_id: projected,
            });
        }
        const globalVars = record(loadout.globalVariables);
        const varKeys = Object.keys(globalVars);
        for (let i = 0; i < varKeys.length; i++) {
          const variableKey = varKeys[i];
          const variableValue = globalVars[variableKey];
          const projectedKey: any = text(variableKey);
          const projectedValue: any = text(variableValue);
          if (projectedKey !== null && projectedValue !== null)
            rows["system.loadout_variables"].push({
              setting_key: key,
              loadout_position: position,
              key: projectedKey,
              value: projectedValue,
            });
        }
        const iconsArr = array(loadout.icons);
        for (
          let iconPosition = 0;
          iconPosition < iconsArr.length;
          iconPosition++
        ) {
          const assetId = iconsArr[iconPosition];
          const projected: any = text(assetId);
          if (projected !== null)
            rows["system.loadout_icons"].push({
              setting_key: key,
              loadout_position: position,
              position: iconPosition,
              asset_id: projected,
            });
        }
      }
      continue;
    }
    if (key === "customSidebarItems") {
      const itemsArr = array(value);
      for (let position = 0; position < itemsArr.length; position++) {
        const rawItem = itemsArr[position];
        const item: any = record(rawItem);
        rows["system.custom_sidebar_items"].push({
          setting_key: key,
          position,
          id: text(item.id),
          item_type: text(item.type),
          subtype: text(item.subType),
          label: text(item.label),
        });
      }
      continue;
    }
    if (ORDERED_TEXT_KEYS.has(key)) {
      const textArr = array(value);
      for (let position = 0; position < textArr.length; position++) {
        const item = textArr[position];
        const projected: any = text(item);
        if (projected !== null)
          rows["system.ordered_text_settings"].push({
            setting_key: key,
            position,
            value: projected,
          });
      }
      continue;
    }
    if (key === "customFlags") {
      const flagsArr = array(value);
      for (let position = 0; position < flagsArr.length; position++) {
        const item = flagsArr[position];
        const projected: any = number(item);
        if (projected !== null)
          rows["system.ordered_number_settings"].push({
            setting_key: key,
            position,
            value: projected,
          });
      }
      continue;
    }
    if (STRING_MAP_KEYS.has(key)) {
      const mapRec = record(value);
      const mapKeys = Object.keys(mapRec);
      for (let i = 0; i < mapKeys.length; i++) {
        const mapKey = mapKeys[i];
        const mapValue = mapRec[mapKey];
        const projectedKey: any = text(mapKey);
        const projectedValue: any = text(mapValue);
        if (projectedKey !== null && projectedValue !== null)
          rows["system.string_map_settings"].push({
            setting_key: key,
            key: projectedKey,
            value: projectedValue,
          });
      }
      continue;
    }
    if (key === "bias") {
      const biasArr = array(value);
      for (let position = 0; position < biasArr.length; position++) {
        const item = biasArr[position];
        const itemArr = array(item);
        const phrase: any = text(itemArr[0]);
        const bias: any = number(itemArr[1]);
        if (phrase !== null && bias !== null)
          rows["system.bias_entries"].push({
            setting_key: key,
            position,
            phrase,
            bias,
          });
      }
      continue;
    }
    if (key === "additionalParams") {
      const paramsArr = array(value);
      for (let position = 0; position < paramsArr.length; position++) {
        const item = paramsArr[position];
        const itemArr = array(item);
        const parameterKey: any = text(itemArr[0]);
        const parameterValue: any = text(itemArr[1]);
        if (parameterKey !== null && parameterValue !== null)
          rows["system.additional_parameters"].push({
            setting_key: key,
            position,
            key: parameterKey,
            value: parameterValue,
          });
      }
      continue;
    }
    if (key === "fallbackModels") {
      const catRec = record(value);
      const catKeys = Object.keys(catRec);
      for (let i = 0; i < catKeys.length; i++) {
        const category = catKeys[i];
        const models = catRec[category];
        const projectedCategory: any = text(category);
        if (projectedCategory === null) continue;
        const modelsArr = array(models);
        for (let position = 0; position < modelsArr.length; position++) {
          const model = modelsArr[position];
          const projectedModel: any = text(model);
          if (projectedModel !== null)
            rows["system.fallback_models"].push({
              setting_key: key,
              category: projectedCategory,
              position,
              model: projectedModel,
            });
        }
      }
      continue;
    }
    if (key === "openrouterProvider") {
      const ruleRec = record(value);
      const ruleKeys = Object.keys(ruleRec);
      for (let i = 0; i < ruleKeys.length; i++) {
        const ruleType = ruleKeys[i];
        const providers = ruleRec[ruleType];
        if (!["order", "only", "ignore"].includes(ruleType)) continue;
        const projectedType: any = text(ruleType);
        if (projectedType === null) continue;
        const provArr = array(providers);
        for (let position = 0; position < provArr.length; position++) {
          const provider = provArr[position];
          const projectedProvider: any = text(provider);
          if (projectedProvider !== null)
            rows["system.openrouter_provider_rules"].push({
              setting_key: key,
              rule_type: projectedType,
              position,
              provider: projectedProvider,
            });
        }
      }
    }
  }
  return rows;
}

export { DEFINITIONS as SETTING_RELATION_DEFINITIONS, projectSettings };
