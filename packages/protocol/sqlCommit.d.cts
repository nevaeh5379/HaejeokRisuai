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
export interface SqlModuleUpsert {
    id: string;
    position?: number;
    data: object;
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
    modules?: {
        upserts: SqlModuleUpsert[];
        deletes: string[];
        order?: string[];
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
    modules?: {
        upserts: SqlModuleUpsert[];
        deletes: string[];
        order?: string[];
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
/**
 * Validates a raw SQL commit body and returns the normalized commit consumed by
 * storage backends. The raw body is unknown until these runtime checks pass.
 * 원시 SQL 커밋 본문을 검증하고 저장소 백엔드가 소비하는 정규화 커밋을 반환합니다.
 * 원시 본문은 이 런타임 검사가 통과할 때까지 unknown입니다.
 */
export type SqlCommitValidator = (rawPayload: unknown) => NormalizedSqlCommit;
/**
 * A compact, payload-free description of the realtime domains and entity IDs
 * an SQL commit touched. It is derived once from the normalized commit right
 * after validation and never carries row data, so it is safe to broadcast and
 * to coalesce in low-memory clients.
 * SQL 커밋이 건드린 실시간 영역과 엔터티 ID를 압축적으로, 페이로드 없이
 * 설명합니다. 검증 직후 정규화 커밋에서 한 번만 도출되며 행 데이터를 담지
 * 않으므로 전파와 저메모리 클라이언트 병합에 안전합니다.
 */
export interface SqlCommitImpact {
    readonly action: string;
    readonly replaceAll: boolean;
    readonly chatIds: readonly string[];
    readonly characterIds: readonly string[];
    readonly charactersChanged: boolean;
    readonly rootUpsertKeys: readonly string[];
    readonly rootDeleteKeys: readonly string[];
    readonly rootChanged: boolean;
    readonly pluginStorageUpsertKeys: readonly string[];
    readonly pluginStorageDeleteKeys: readonly string[];
    readonly pluginStorageCleared: boolean;
    readonly presetsChanged: boolean;
    readonly modulesChanged: boolean;
}
/**
 * Internal callback installed on mutation options. Vendors invoke it once per
 * validated commit; databaseMutations keeps the impact in memory and only
 * forwards it to the realtime hub after the mutation succeeds. The channel is
 * a symbol property, so it can never appear in serialized HTTP responses.
 * 뮤테이션 옵션에 설치되는 내부 콜백입니다. 벤더는 검증된 커밋마다 한 번
 * 호출하고, databaseMutations는 그 영향을 메모리에 보관한 뒤 쓰기가 성공한
 * 후에만 실시간 허브로 전달합니다. 심볼 프로퍼티라서 직렬화된 HTTP 응답에는
 * 절대 나타나지 않습니다.
 */
export type SqlCommitImpactSink = (impact: SqlCommitImpact) => void;
/**
 * Non-enumerable option key that carries the internal impact sink between
 * databaseMutations and the storage vendors. Symbol.for keeps the key stable
 * even when the protocol module is inlined into separate generated bundles.
 * databaseMutations와 저장소 벤더 사이에서 내부 영향 콜백을 전달하는,
 * 열거되지 않는 옵션 키입니다. Symbol.for를 사용하므로 프로토콜 모듈이 서로
 * 다른 생성 번들에 인라인되어도 같은 키를 공유합니다.
 */
export declare const SQL_COMMIT_IMPACT_CHANNEL: symbol;
/**
 * Installs the internal impact sink on an options object. The property is
 * non-enumerable, so plain spreads and JSON responses cannot leak it.
 * 옵션 객체에 내부 영향 콜백을 설치합니다. 프로퍼티는 열거 불가능하므로
 * 일반 스프레드나 JSON 응답으로 새어 나가지 않습니다.
 *
 * @param options - Mutation options traveling into storage.sync(). storage.sync()로 전달되는 뮤테이션 옵션입니다.
 * @param sink - Callback receiving the derived impact. 도출된 영향을 받는 콜백입니다.
 */
export declare function attachSqlCommitImpactSink(options: object, sink: SqlCommitImpactSink): void;
/**
 * Reads the impact sink previously attached to mutation options, tolerating
 * plain objects, option wrappers, and legacy function-form options.
 * 뮤테이션 옵션에 설치된 영향 콜백을 읽습니다. 일반 객체, 옵션 래퍼,
 * 구식 함수 형태 옵션까지 모두 허용합니다.
 *
 * @param options - Raw options value. 원시 옵션 값입니다.
 * @returns The installed sink, or null when absent. 설치된 콜백 또는 null입니다.
 */
export declare function readSqlCommitImpactSink(options: unknown): SqlCommitImpactSink | null;
/**
 * Derives the compact realtime impact from an already validated, normalized
 * commit. IDs and keys are copied by reference-free value into plain arrays so
 * callers may not mutate the normalized commit through the impact.
 * 이미 검증된 정규화 커밋에서 압축된 실시간 영향을 도출합니다. ID와 키는
 * 정규화 커밋을 통해 변경할 수 없도록 값 배열로 복사됩니다.
 *
 * @param commit - Normalized commit from the SQL commit validator. SQL 커밋 검증기가 만든 정규화 커밋입니다.
 * @returns The compact impact description. 압축된 영향 설명입니다.
 */
export declare function deriveSqlCommitImpact(commit: NormalizedSqlCommit): SqlCommitImpact;
export declare const RESERVED_ROOT_SETTING_KEYS: readonly ["botPresets", "botPresetsId"];
export declare function createSqlCommitValidator(options: SqlCommitValidatorOptions): SqlCommitValidator;
export {};
