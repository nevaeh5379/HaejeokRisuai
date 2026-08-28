export interface SqlSettingUpsert {
  key: string;
  value: unknown;
}

export interface SqlCharacterUpsert {
  id: string;
  position: number;
  data: unknown;
}

export interface SqlCharacterTouch {
  id: string;
  lastInteraction: number;
}

export interface SqlChatUpsert {
  id: string;
  characterId: string;
  position: number;
  data: unknown;
}

export interface SqlMessageUpsert {
  id: string;
  chatId: string;
  position: number;
  data: unknown;
}

export interface SqlPresetUpsert<TPreset extends object = Record<string, unknown>> {
  id: string;
  position?: number;
  data: TPreset;
}

export interface SqlCommit<TPreset extends object = Record<string, unknown>> {
  baseRevision: number;
  idempotencyKey?: string;
  replaceAll?: boolean;
  action?: string;
  root: {
    upserts: SqlSettingUpsert[];
    deletes: string[];
  };
  pluginStorage?: {
    upserts: SqlSettingUpsert[];
    deletes: string[];
    clear?: boolean;
  };
  presets?: {
    upserts: SqlPresetUpsert<TPreset>[];
    deletes: string[];
    order?: string[];
    activeId?: string;
  };
  characters: SqlCharacterUpsert[];
  characterTouches?: SqlCharacterTouch[];
  characterIds?: string[];
  characterDeletes?: string[];
  chats: SqlChatUpsert[];
  chatManifests: { characterId: string; ids: string[] }[];
  messages: SqlMessageUpsert[];
  messageManifests: { chatId: string; ids: string[] }[];
  messageDeletes?: { chatId: string; ids: string[] }[];
}

export interface SqlCommitResult {
  revision: number;
}

export const RESERVED_ROOT_SETTING_KEYS: readonly ['botPresets', 'botPresetsId'];

export function createSqlCommitValidator(options: {
  PayloadError: new (message: string) => Error;
  maxIdLength?: number;
}): (payload: unknown) => Record<string, unknown>;
