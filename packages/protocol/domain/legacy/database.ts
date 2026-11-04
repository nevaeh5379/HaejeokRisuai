import type {
  DatabaseSettings,
  CharacterStoreData,
  PersonaStoreData,
  ModuleStoreData,
  PresetStoreData,
  LegacyPersonaMirrorData,
  botPreset,
} from "../database.ts";
import type { AuthorNoteRow } from "../../src/authorNotes.ts";

/** Aggregate used only at legacy import/export and plugin API compatibility boundaries. */
export interface Database
  extends
    DatabaseSettings,
    CharacterStoreData,
    PersonaStoreData,
    ModuleStoreData,
    PresetStoreData,
    LegacyPersonaMirrorData {
  botPresets: botPreset[];
  botPresetsId: number;
  globalAuthorNotes?: AuthorNoteRow[];
  globalAuthorNoteSettings?: { allowScriptWrite: boolean };
}
