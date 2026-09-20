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

export interface SqlPresetUpsert<
  TPreset extends object = Record<string, unknown>,
> {
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
  chatManifests: { characterId: string; ids: string[] }[];
  chatDeletes?: string[];
  messages: SqlMessageUpsert[];
  messageManifests: { chatId: string; ids: string[] }[];
  messageDeletes?: { chatId: string; ids: string[] }[];
}

export interface SqlCommitResult {
  revision: number;
}

type PayloadErrorConstructor = new (message: string) => Error;
type UnknownRecord = Record<string, unknown>;
type OwnerKey = "characterId" | "chatId";

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
  chatManifests: { characterId: string; ids: string[] }[];
  chatDeletes?: string[];
  messageManifests: { chatId: string; ids: string[] }[];
  messageDeletes?: { chatId: string; ids: string[] }[];
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
export const SQL_COMMIT_IMPACT_CHANNEL: symbol = Symbol.for(
  "risuai.sqlCommitImpactSink",
);

/**
 * Installs the internal impact sink on an options object. The property is
 * non-enumerable, so plain spreads and JSON responses cannot leak it.
 * 옵션 객체에 내부 영향 콜백을 설치합니다. 프로퍼티는 열거 불가능하므로
 * 일반 스프레드나 JSON 응답으로 새어 나가지 않습니다.
 *
 * @param options - Mutation options traveling into storage.sync(). storage.sync()로 전달되는 뮤테이션 옵션입니다.
 * @param sink - Callback receiving the derived impact. 도출된 영향을 받는 콜백입니다.
 */
export function attachSqlCommitImpactSink(
  options: object,
  sink: SqlCommitImpactSink,
): void {
  Object.defineProperty(options, SQL_COMMIT_IMPACT_CHANNEL, {
    value: sink,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Reads the impact sink previously attached to mutation options, tolerating
 * plain objects, option wrappers, and legacy function-form options.
 * 뮤테이션 옵션에 설치된 영향 콜백을 읽습니다. 일반 객체, 옵션 래퍼,
 * 구식 함수 형태 옵션까지 모두 허용합니다.
 *
 * @param options - Raw options value. 원시 옵션 값입니다.
 * @returns The installed sink, or null when absent. 설치된 콜백 또는 null입니다.
 */
export function readSqlCommitImpactSink(
  options: unknown,
): SqlCommitImpactSink | null {
  if (options === null) return null;
  if (typeof options !== "object" && typeof options !== "function") {
    return null;
  }
  const candidate: unknown = (options as Record<PropertyKey, unknown>)[
    SQL_COMMIT_IMPACT_CHANNEL
  ];
  return typeof candidate === "function"
    ? (candidate as SqlCommitImpactSink)
    : null;
}

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
export function deriveSqlCommitImpact(
  commit: NormalizedSqlCommit,
): SqlCommitImpact {
  const replaceAll: boolean = commit.replaceAll;

  // Insertion order mirrors the legacy realtime extraction so replayed event
  // payloads keep their historical ordering.
  // 삽입 순서는 기존 실시간 추출 순서와 동일하게 유지되어, 재생 이벤트의
  // 배열 순서도 이전과 같게 유지됩니다.
  const chatIdSet: Set<string> = new Set<string>();
  for (const message of commit.messages) chatIdSet.add(message.chatId);
  for (const manifest of commit.messageManifests) {
    chatIdSet.add(manifest.chatId);
  }
  for (const deletion of commit.messageDeletes ?? []) {
    chatIdSet.add(deletion.chatId);
  }
  for (const chat of commit.chats) chatIdSet.add(chat.id);
  for (const chatId of commit.chatDeletes ?? []) chatIdSet.add(chatId);
  const chatIds: string[] = [...chatIdSet];

  const characterIdSet: Set<string> = new Set<string>();
  for (const chat of commit.chats) characterIdSet.add(chat.characterId);
  for (const character of commit.characters) {
    characterIdSet.add(character.id);
  }
  for (const characterId of commit.characterDeletes ?? []) {
    characterIdSet.add(characterId);
  }
  for (const manifest of commit.chatManifests) {
    characterIdSet.add(manifest.characterId);
  }
  const characterIds: string[] = [...characterIdSet];

  const rootUpsertKeySet: Set<string> = new Set<string>();
  for (const upsert of commit.rootUpserts) rootUpsertKeySet.add(upsert.key);
  const rootUpsertKeys: string[] = [...rootUpsertKeySet];
  const rootDeleteKeys: string[] = [...new Set<string>(commit.rootDeletes)];

  const pluginStorageUpsertKeySet: Set<string> = new Set<string>();
  for (const upsert of commit.pluginStorageUpserts) {
    pluginStorageUpsertKeySet.add(upsert.key);
  }
  const pluginStorageUpsertKeys: string[] = [...pluginStorageUpsertKeySet];
  const pluginStorageDeleteKeys: string[] = [
    ...new Set<string>(commit.pluginStorageDeletes),
  ];

  return {
    action: commit.action ?? "sync",
    replaceAll,
    chatIds,
    characterIds,
    // Character touches deliberately do not mark the character index as
    // changed: they never alter character rows.
    // 캐릭터 터치는 캐릭터 행을 바꾸지 않으므로 의도적으로 인덱스 갱신
    // 대상에서 제외됩니다.
    charactersChanged: Boolean(
      replaceAll ||
      commit.characters.length > 0 ||
      (commit.characterDeletes?.length ?? 0) > 0 ||
      commit.characterIds !== undefined,
    ),
    rootUpsertKeys,
    rootDeleteKeys,
    rootChanged: Boolean(
      replaceAll || rootUpsertKeys.length > 0 || rootDeleteKeys.length > 0,
    ),
    pluginStorageUpsertKeys,
    pluginStorageDeleteKeys,
    pluginStorageCleared: commit.pluginStorageClear,
    presetsChanged: Boolean(
      replaceAll ||
      (commit.presets !== undefined &&
        (commit.presets.upserts.length > 0 ||
          commit.presets.deletes.length > 0 ||
          commit.presets.order !== undefined ||
          commit.presets.activeId !== undefined)),
    ),
    modulesChanged: Boolean(
      replaceAll ||
      (commit.modules !== undefined &&
        (commit.modules.upserts.length > 0 ||
          commit.modules.deletes.length > 0 ||
          commit.modules.order !== undefined)),
    ),
  };
}

export const RESERVED_ROOT_SETTING_KEYS = Object.freeze([
  "botPresets",
  "botPresetsId",
] as const);

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isReservedRootSettingKey(key: string): boolean {
  return (RESERVED_ROOT_SETTING_KEYS as readonly string[]).includes(key);
}

const ERROR_MESSAGES = {
  UPSERT: (key: string) => `${key} must be written through presets`,
  DELETE: (key: string) => `${key} is not a root setting`,
} as const;
type RejectReservedRootType = keyof typeof ERROR_MESSAGES;
// Holds validator configuration and exposes each commit-section parser as a
// private method, so validation state does not depend on nested function scopes.
class SqlCommitParser {
  constructor(
    private readonly PayloadError: PayloadErrorConstructor,
    private readonly maxIdLength: number,
  ) {}

  // Reads an optional array field, defaulting omitted fields to an empty array
  // and rejecting values of any other type.
  private asArray(value: unknown, field: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new this.PayloadError(`${field} must be an array`);
    }
    return value;
  }

  private assertId(value: unknown, field: string): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > this.maxIdLength
    ) {
      throw new this.PayloadError(
        `${field} must be a non-empty string of at most ${this.maxIdLength} characters`,
      );
    }
  }

  private assertPosition(
    value: unknown,
    field: string,
  ): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new this.PayloadError(`${field} must be a non-negative integer`);
    }
  }

  private assertData(
    row: UnknownRecord,
    field: string,
  ): asserts row is UnknownRecord & { data: UnknownRecord } {
    if (
      !Object.prototype.hasOwnProperty.call(row, "data") ||
      !isRecord(row.data)
    ) {
      throw new this.PayloadError(`${field} must be a JSON object`);
    }
  }

  // Parses an array of JSON objects and delegates each validated row to the
  // domain-specific row parser.
  private parseRows<T>(
    value: unknown,
    field: string,
    parseRow: (row: UnknownRecord, index: number) => T,
  ): T[] {
    return this.asArray(value, field).map((row, index) => {
      if (!isRecord(row)) {
        throw new this.PayloadError(`${field}[${index}] must be an object`);
      }
      return parseRow(row, index);
    });
  }

  // Parses an ID array and optionally applies an additional domain rule after
  // each ID passes the shared string and length checks.
  private parseIds(
    value: unknown,
    field: string,
    validateId?: (id: string, index: number) => void,
  ): string[] {
    return this.asArray(value, field).map((id, index) => {
      this.assertId(id, `${field}[${index}]`);
      validateId?.(id, index);
      return id;
    });
  }

  // Parses setting upserts into { key, value } rows and optionally applies a
  // section-specific key rule.
  private parseSettingUpserts(
    value: unknown,
    field: string,
    validateKey?: (key: string, index: number) => void,
  ): SqlSettingUpsert[] {
    return this.parseRows(value, field, (row, index) => {
      this.assertId(row.key, `${field}[${index}].key`);
      validateKey?.(row.key, index);
      return { key: row.key, value: row.value };
    });
  }

  // Parses character upserts directly and chat/message upserts with their
  // characterId or chatId owner field.
  private parseEntityRows(value: unknown, field: string): SqlCharacterUpsert[];
  private parseEntityRows(
    value: unknown,
    field: string,
    ownerKey: "characterId",
  ): SqlChatUpsert[];
  private parseEntityRows(
    value: unknown,
    field: string,
    ownerKey: "chatId",
  ): SqlMessageUpsert[];
  private parseEntityRows(
    value: unknown,
    field: string,
    ownerKey?: OwnerKey,
  ): Array<SqlCharacterUpsert | SqlChatUpsert | SqlMessageUpsert> {
    return this.parseRows(value, field, (row, index) => {
      const rowField = `${field}[${index}]`;
      this.assertId(row.id, `${rowField}.id`);

      if (ownerKey === undefined) {
        this.assertPosition(row.position, `${rowField}.position`);
        this.assertData(row, `${rowField}.data`);
        return { id: row.id, position: row.position, data: row.data };
      }

      const ownerId = row[ownerKey];
      this.assertId(ownerId, `${rowField}.${ownerKey}`);
      this.assertPosition(row.position, `${rowField}.position`);
      this.assertData(row, `${rowField}.data`);
      if (ownerKey === "characterId") {
        return {
          id: row.id,
          characterId: ownerId,
          position: row.position,
          data: row.data,
        };
      }
      return {
        id: row.id,
        chatId: ownerId,
        position: row.position,
        data: row.data,
      };
    });
  }

  // Preserves undefined for optional deletion collections while reusing the
  // standard ID-array parser when the field is present.
  private parseOptionalIds(
    value: unknown,
    field: string,
  ): string[] | undefined {
    if (value === undefined) return undefined;
    return this.parseIds(value, field);
  }

  // Parses owner-to-child-ID manifests used to synchronize chat and message
  // membership and explicit message deletions.
  private parseManifests<K extends OwnerKey>(
    value: unknown,
    field: string,
    ownerKey: K,
  ): Array<Record<K, string> & { ids: string[] }> {
    return this.parseRows(value, field, (item, index) => {
      const itemField = `${field}[${index}]`;
      const idsField = `${itemField}.ids`;
      const ownerId = item[ownerKey];
      this.assertId(ownerId, `${itemField}.${ownerKey}`);
      const ids = this.parseIds(item.ids, idsField);
      return { [ownerKey]: ownerId, ids } as Record<K, string> & {
        ids: string[];
      };
    });
  }

  // Rejects non-object request bodies and narrows the top-level payload to a
  // record for the section parsers below.
  private parsePayload(rawPayload: unknown): UnknownRecord {
    if (!isRecord(rawPayload))
      throw new this.PayloadError("Sync payload must be an object");

    return rawPayload;
  }

  private parseBaseRevision(value: unknown): number {
    this.assertPosition(value, "baseRevision");
    return value;
  }

  // Prevents preset-owned settings from being written or deleted through the
  // generic root-settings section.
  // private rejectReservedRootUpsert(key: string): void {
  //   if (isReservedRootSettingKey(key))
  //     throw new this.PayloadError(`${key} must be written through presets`);
  // }

  // private rejectReservedRootDelete(key: string): void {
  //   if (isReservedRootSettingKey(key))
  //     throw new this.PayloadError(`${key} is not a root setting`);
  // }

  private rejectReservedRoot(action: RejectReservedRootType, key: string) {
    if (!isReservedRootSettingKey(key)) return;

    throw new this.PayloadError(ERROR_MESSAGES[action](key));
  }
  // Parses generic root-setting upserts and deletes, applying the reserved-key
  // policy to both operations.
  private parseRoot(value: unknown): {
    rootUpserts: SqlSettingUpsert[];
    rootDeletes: string[];
  } {
    if (value === undefined) return { rootUpserts: [], rootDeletes: [] };

    if (!isRecord(value)) throw new this.PayloadError("root must be an object");

    const rootUpserts = this.parseSettingUpserts(
      value.upserts,
      "root.upserts",
      (key) => this.rejectReservedRoot("UPSERT", key),
    );
    const rootDeletes = this.parseIds(value.deletes, "root.deletes", (key) =>
      this.rejectReservedRoot("DELETE", key),
    );
    return { rootUpserts, rootDeletes };
  }

  // Parses preset upserts, deletes, ordering, and the active preset identifier.
  private parsePresets(value: unknown): NormalizedSqlCommit["presets"] {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      throw new this.PayloadError("presets must be an object");
    }
    const upserts = this.parseRows(
      value.upserts,
      "presets.upserts",
      (item, index) => {
        this.assertId(item.id, `presets.upserts[${index}].id`);

        if (item.position !== undefined)
          this.assertPosition(
            item.position,
            `presets.upserts[${index}].position`,
          );

        if (!isRecord(item.data))
          throw new this.PayloadError(
            `presets.upserts[${index}].data must be an object`,
          );

        return { id: item.id, position: item.position, data: item.data };
      },
    );
    const deletes = this.parseIds(value.deletes, "presets.deletes");
    const order =
      value.order === undefined
        ? undefined
        : this.parseIds(value.order, "presets.order");
    if (value.activeId !== undefined) {
      this.assertId(value.activeId, "presets.activeId");
    }
    return {
      upserts,
      deletes,
      order,
      activeId: value.activeId,
    };
  }

  private parseModules(value: unknown): NormalizedSqlCommit["modules"] {
    if (value === undefined) return undefined;
    if (!isRecord(value))
      throw new this.PayloadError("modules must be an object");

    const upserts = this.parseRows(
      value.upserts,
      "modules.upserts",
      (item, index) => {
        this.assertId(item.id, `modules.upserts[${index}].id`);
        if (item.position !== undefined)
          this.assertPosition(
            item.position,
            `modules.upserts[${index}].position`,
          );
        if (!isRecord(item.data))
          throw new this.PayloadError(
            `modules.upserts[${index}].data must be an object`,
          );
        return { id: item.id, position: item.position, data: item.data };
      },
    );
    const deletes = this.parseIds(value.deletes, "modules.deletes");
    const order =
      value.order === undefined
        ? undefined
        : this.parseIds(value.order, "modules.order");
    return { upserts, deletes, order };
  }

  // Parses plugin-storage upserts, deletes, and the optional clear operation.
  private parsePluginStorage(value: unknown): {
    pluginStorageUpserts: SqlSettingUpsert[];
    pluginStorageDeletes: string[];
    pluginStorageClear: boolean;
  } {
    if (value === undefined) {
      return {
        pluginStorageUpserts: [],
        pluginStorageDeletes: [],
        pluginStorageClear: false,
      };
    }
    if (!isRecord(value)) {
      throw new this.PayloadError("pluginStorage must be an object");
    }
    const pluginStorageUpserts = this.parseSettingUpserts(
      value.upserts,
      "pluginStorage.upserts",
    );
    const pluginStorageDeletes = this.parseIds(
      value.deletes,
      "pluginStorage.deletes",
    );
    return {
      pluginStorageUpserts,
      pluginStorageDeletes,
      pluginStorageClear: Boolean(value.clear),
    };
  }

  private parseCharacterTouches(value: unknown): SqlCharacterTouch[] {
    return this.parseRows(value, "characterTouches", (row, index) => {
      const rowField = `characterTouches[${index}]`;
      this.assertId(row.id, `${rowField}.id`);
      if (
        !Number.isSafeInteger(row.lastInteraction) ||
        (row.lastInteraction as number) < 0
      ) {
        throw new this.PayloadError(
          `${rowField}.lastInteraction must be a non-negative safe integer`,
        );
      }
      return { id: row.id, lastInteraction: row.lastInteraction as number };
    });
  }

  private parseAction(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= 64
      ? value
      : undefined;
  }

  private parseEntities(
    payload: UnknownRecord,
  ): Pick<
    NormalizedSqlCommit,
    | "characters"
    | "characterTouches"
    | "characterIds"
    | "characterDeletes"
    | "chats"
    | "chatManifests"
    | "chatDeletes"
    | "messages"
    | "messageManifests"
    | "messageDeletes"
  > {
    // Parses every character, chat, message, manifest, and explicit deletion
    // collection into the normalized entity portion of the commit.
    const characters = this.parseEntityRows(payload.characters, "characters");
    const characterTouches = this.parseCharacterTouches(
      payload.characterTouches,
    );
    const chats = this.parseEntityRows(payload.chats, "chats", "characterId");
    const messages = this.parseEntityRows(
      payload.messages,
      "messages",
      "chatId",
    );
    const chatManifests = this.parseManifests(
      payload.chatManifests,
      "chatManifests",
      "characterId",
    );
    const messageManifests = this.parseManifests(
      payload.messageManifests,
      "messageManifests",
      "chatId",
    );
    const messageDeletes =
      payload.messageDeletes === undefined
        ? undefined
        : this.parseManifests(
            payload.messageDeletes,
            "messageDeletes",
            "chatId",
          );
    const chatDeletes = this.parseOptionalIds(
      payload.chatDeletes,
      "chatDeletes",
    );
    const characterIds = this.parseOptionalIds(
      payload.characterIds,
      "characterIds",
    );
    const characterDeletes = this.parseOptionalIds(
      payload.characterDeletes,
      "characterDeletes",
    );

    return {
      characters,
      characterTouches,
      chats,
      messages,
      chatManifests,
      chatDeletes,
      messageManifests,
      messageDeletes,
      characterIds,
      characterDeletes,
    };
  }

  // Parses each commit section in validation order and assembles the normalized
  // payload returned to the storage backend.
  public validate(rawPayload: unknown): NormalizedSqlCommit {
    const payload = this.parsePayload(rawPayload);
    const baseRevision = this.parseBaseRevision(payload.baseRevision);
    const root = this.parseRoot(payload.root);
    const presets = this.parsePresets(payload.presets);
    const modules = this.parseModules(payload.modules);
    const pluginStorage = this.parsePluginStorage(payload.pluginStorage);
    const entities = this.parseEntities(payload);

    return {
      replaceAll: Boolean(payload.replaceAll),
      action: this.parseAction(payload.action),
      baseRevision,
      ...root,
      ...pluginStorage,
      presets,
      modules,
      ...entities,
    };
  }
}

export function createSqlCommitValidator(
  options: SqlCommitValidatorOptions,
): SqlCommitValidator {
  const { PayloadError, maxIdLength = 4000 } = options ?? {};
  if (typeof PayloadError !== "function") {
    throw new TypeError("PayloadError must be an error constructor");
  }

  const parser = new SqlCommitParser(PayloadError, maxIdLength);
  return parser.validate.bind(parser);
}
