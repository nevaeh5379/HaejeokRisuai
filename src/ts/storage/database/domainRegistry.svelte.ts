import type {
  PortableDatabase,
  Database,
  character,
  groupChat,
  RisuPersona,
  RisuModule,
  botPreset,
} from "./schema";

import { characterStore } from "../../stores/domain/characterStore.svelte";
import { personaStore } from "../../stores/domain/personaStore.svelte";
import { moduleStore } from "../../stores/domain/moduleStore.svelte";
import { presetStore } from "../../stores/domain/presetStore.svelte";
import { getSqlStorage } from "../sql/sqlStorageFactory";

export type BackupAssetScope = "all" | "essential";

export interface DomainAssetInfo {
  category: string;
  name: string;
}

export type DatabaseDraft = Partial<Database> & {
  botPresets?: botPreset[];
  botPresetsId?: number;
};

export interface DomainHandler<T = unknown> {
  readonly key: CoreDomainKey;
  collectAssets(
    data: T,
    scope: BackupAssetScope,
    addAsset: (key: string | undefined, category: string, name: string) => void,
    db: PortableDatabase,
  ): void;
  ensureDomain(db: DatabaseDraft): void;
}

export const CharacterDomainHandler: DomainHandler<(character | groupChat)[]> = {
  key: "characters",
  collectAssets(characters, scope, addAsset) {
    for (const char of characters ?? []) {
      if (!char) continue;
      const charName = char.name ?? "Unknown Character";
      addAsset(
        char.image,
        charName,
        scope === "essential" ? "Profile Image" : "Main Image",
      );
      if (scope === "essential") continue;

      for (const emotion of char.emotionImages ?? []) {
        if (emotion?.[1]) {
          addAsset(emotion[1], charName, emotion[0]);
        }
      }
      if (char.type === "group") continue;
      for (const asset of char.additionalAssets ?? []) {
        if (asset?.[1]) {
          addAsset(asset[1], charName, asset[0]);
        }
      }
      for (const [name, key] of Object.entries(char.vits?.files ?? {})) {
        if (typeof key === "string" && key.length > 0) {
          addAsset(key, charName, name);
        }
      }
      for (const asset of char.ccAssets ?? []) {
        if (asset?.uri) {
          addAsset(asset.uri, charName, asset.name);
        }
      }
    }
  },
  ensureDomain(db) {
    if (!Array.isArray(db.characters) || db.characters.length === 0) {
      if (characterStore.characters.length > 0) {
        db.characters = $state.snapshot(characterStore.characters);
      } else {
        db.characters ??= [];
      }
    }
  },
};

export const PersonaDomainHandler: DomainHandler<RisuPersona[]> = {
  key: "personas",
  collectAssets(personas, _scope, addAsset) {
    for (const persona of personas ?? []) {
      if (persona?.icon) {
        addAsset(persona.icon, "Persona", `${persona.name} Icon`);
      }
    }
  },
  ensureDomain(db) {
    if (!Array.isArray(db.personas) || db.personas.length === 0) {
      if (personaStore.personas.length > 0) {
        db.personas = $state.snapshot(personaStore.personas);
        db.selectedPersona = personaStore.activeIndex;
      } else {
        db.personas = [
          {
            name: db.username || "User",
            icon: db.userIcon || "",
            personaPrompt: db.personaPrompt || "",
            note: db.userNote || "",
            largePortrait: false,
          },
        ];
        db.selectedPersona = 0;
      }
    }
  },
};

export const ModuleDomainHandler: DomainHandler<RisuModule[]> = {
  key: "modules",
  collectAssets(modules, scope, addAsset) {
    for (const mod of modules ?? []) {
      if (!mod) continue;
      const modName = mod.name ?? "Unknown Module";
      addAsset(mod.icon, "Module", `${modName} Icon`);
      if (scope !== "essential") {
        for (const asset of mod.assets ?? []) {
          if (asset?.[1]) {
            addAsset(
              asset[1],
              "Module",
              `${modName} - ${asset[0] || "Asset"}`,
            );
          }
        }
      }
    }
  },
  ensureDomain(db) {
    if (!Array.isArray(db.modules) || db.modules.length === 0) {
      if (moduleStore.modules.length > 0) {
        db.modules = $state.snapshot(moduleStore.modules);
      } else {
        db.modules ??= [];
      }
    }
  },
};

export const PresetDomainHandler: DomainHandler<botPreset[]> = {
  key: "botPresets",
  collectAssets(presets, scope, addAsset) {
    if (scope === "essential") {
      for (const preset of presets ?? []) {
        if (preset?.image) {
          addAsset(
            preset.image,
            "Preset",
            `${preset.name} Preset Image`,
          );
        }
      }
    }
  },
  ensureDomain(db) {
    if (!Array.isArray(db.botPresets) || db.botPresets.length === 0) {
      if (presetStore.summaries.length > 0) {
        db.botPresets = presetStore.list;
        db.botPresetsId = presetStore.activeIndex;
      } else {
        db.botPresets ??= [];
        db.botPresetsId ??= 0;
      }
    }
  },
};

export const PluginStorageDomainHandler: DomainHandler<Record<string, unknown>> = {
  key: "pluginCustomStorage",
  collectAssets(_storage, _scope, _addAsset) {
    // Plugin custom storage does not reference core managed asset files directly
  },
  ensureDomain(db) {
    db.pluginCustomStorage ??= {};
  },
};

export const SettingsDomainHandler: DomainHandler<Partial<Database>> = {
  key: "settings",
  collectAssets(_settings, scope, addAsset, db) {
    addAsset(db.userIcon, "User Settings", "User Icon");
    addAsset(db.customBackground, "User Settings", "Custom Background");

    if (scope === "essential") {
      for (const item of db.characterOrder ?? []) {
        if (typeof item === "string" || !item) continue;
        addAsset(item.img, "Folder", `${item.name} Folder Image`);
        addAsset(item.imgFile, "Folder", `${item.name} Folder Image File`);
      }
    }
  },
  ensureDomain(db) {
    db.botPresets ??= [];
    db.botPresetsId ??= 0;
  },
};

/**
 * Core domain keys of the canonical database schema.
 * Adding a domain key without registering its handler will cause a compile error.
 */
export type CoreDomainKey =
  | "characters"
  | "personas"
  | "modules"
  | "botPresets"
  | "pluginCustomStorage"
  | "settings";

export const DOMAIN_REGISTRY: Record<CoreDomainKey, DomainHandler<any>> = {
  characters: CharacterDomainHandler,
  personas: PersonaDomainHandler,
  modules: ModuleDomainHandler,
  botPresets: PresetDomainHandler,
  pluginCustomStorage: PluginStorageDomainHandler,
  settings: SettingsDomainHandler,
};

export function ensureAllDomains(
  db: DatabaseDraft,
): DatabaseDraft {
  for (const handler of Object.values(DOMAIN_REGISTRY)) {
    handler.ensureDomain(db);
  }
  return db;
}

/**
 * Collects all backup assets across all registered domain handlers.
 */
export function collectAllDomainAssets(
  db: PortableDatabase,
  scope: BackupAssetScope,
): Map<string, { charName: string; assetName: string }> {
  const assets = new Map<string, { charName: string; assetName: string }>();

  const addAsset = (
    key: string | undefined,
    category: string,
    name: string,
  ) => {
    if (key && typeof key === "string" && key.length > 0) {
      assets.set(key, { charName: category, assetName: name });
    }
  };

  CharacterDomainHandler.collectAssets(db.characters, scope, addAsset, db);
  PersonaDomainHandler.collectAssets(db.personas, scope, addAsset, db);
  ModuleDomainHandler.collectAssets(db.modules, scope, addAsset, db);
  PresetDomainHandler.collectAssets(db.botPresets, scope, addAsset, db);
  PluginStorageDomainHandler.collectAssets(db.pluginCustomStorage, scope, addAsset, db);
  SettingsDomainHandler.collectAssets(db, scope, addAsset, db);

  return assets;
}
