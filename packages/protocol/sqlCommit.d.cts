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
    chatManifests: {
        characterId: string;
        ids: string[];
    }[];
    chatDeletes?: string[];
    messages: SqlMessageUpsert[];
    messageManifests: {
        chatId: string;
        ids: string[];
    }[];
    messageDeletes?: {
        chatId: string;
        ids: string[];
    }[];
}
export interface SqlCommitResult {
    revision: number;
}
type PayloadErrorConstructor = new (message: string) => Error;
export interface SqlCommitValidatorOptions {
    PayloadError: PayloadErrorConstructor;
    maxIdLength?: number;
}
export interface NormalizedSqlCommit {
    replaceAll: boolean;
    action?: string;
    baseRevision: number;
    rootUpserts: SqlSettingUpsert[];
    rootDeletes: string[];
    pluginStorageUpserts: SqlSettingUpsert[];
    pluginStorageDeletes: string[];
    pluginStorageClear: boolean;
    presets?: {
        upserts: SqlPresetUpsert[];
        deletes: string[];
        order?: string[];
        activeId?: string;
    };
    characters: SqlCharacterUpsert[];
    characterTouches: SqlCharacterTouch[];
    chats: SqlChatUpsert[];
    messages: SqlMessageUpsert[];
    chatManifests: {
        characterId: string;
        ids: string[];
    }[];
    chatDeletes?: string[];
    messageManifests: {
        chatId: string;
        ids: string[];
    }[];
    messageDeletes?: {
        chatId: string;
        ids: string[];
    }[];
    characterIds?: string[];
    characterDeletes?: string[];
}
export type SqlCommitValidator = (payload: SqlCommit) => NormalizedSqlCommit;
export declare const RESERVED_ROOT_SETTING_KEYS: readonly ["botPresets", "botPresetsId"];
export declare function createSqlCommitValidator(options: SqlCommitValidatorOptions): SqlCommitValidator;
export {};
