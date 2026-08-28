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

export interface SqlCommit<
  TPreset extends object = Record<string, unknown>,
> {
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

export type SqlCommitValidator = (
  payload: SqlCommit,
) => NormalizedSqlCommit;

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

export function createSqlCommitValidator(
  options: SqlCommitValidatorOptions,
): SqlCommitValidator {
  const { PayloadError, maxIdLength = 4000 } = options ?? {};
  if (typeof PayloadError !== "function") {
    throw new TypeError("PayloadError must be an error constructor");
  }

  function asArray(value: unknown, field: string): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new PayloadError(`${field} must be an array`);
    }
    return value;
  }

  function assertId(value: unknown, field: string): asserts value is string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maxIdLength
    ) {
      throw new PayloadError(
        `${field} must be a non-empty string of at most ${maxIdLength} characters`,
      );
    }
  }

  function assertPosition(
    value: unknown,
    field: string,
  ): asserts value is number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new PayloadError(`${field} must be a non-negative integer`);
    }
  }

  function assertData(
    row: UnknownRecord,
    field: string,
  ): asserts row is UnknownRecord & { data: UnknownRecord } {
    if (
      !Object.prototype.hasOwnProperty.call(row, "data") ||
      !isRecord(row.data)
    ) {
      throw new PayloadError(`${field} must be a JSON object`);
    }
  }

  function validateRows<T>(
    value: unknown,
    field: string,
    validateRow: (row: UnknownRecord, index: number) => T,
  ): T[] {
    return asArray(value, field).map((row, index) => {
      if (!isRecord(row)) {
        throw new PayloadError(`${field}[${index}] must be an object`);
      }
      return validateRow(row, index);
    });
  }

  function validateEntityRows(
    value: unknown,
    field: string,
  ): SqlCharacterUpsert[];
  function validateEntityRows(
    value: unknown,
    field: string,
    ownerKey: "characterId",
  ): SqlChatUpsert[];
  function validateEntityRows(
    value: unknown,
    field: string,
    ownerKey: "chatId",
  ): SqlMessageUpsert[];
  function validateEntityRows(
    value: unknown,
    field: string,
    ownerKey?: OwnerKey,
  ): Array<SqlCharacterUpsert | SqlChatUpsert | SqlMessageUpsert> {
    return validateRows(value, field, (row, index) => {
      const rowField = `${field}[${index}]`;
      assertId(row.id, `${rowField}.id`);

      if (ownerKey === undefined) {
        assertPosition(row.position, `${rowField}.position`);
        assertData(row, `${rowField}.data`);
        return { id: row.id, position: row.position, data: row.data };
      }

      const ownerId = row[ownerKey];
      assertId(ownerId, `${rowField}.${ownerKey}`);
      assertPosition(row.position, `${rowField}.position`);
      assertData(row, `${rowField}.data`);
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

  function validateOptionalIds(
    value: unknown,
    field: string,
  ): string[] | undefined {
    if (value === undefined) return undefined;
    return asArray(value, field).map((id, index) => {
      assertId(id, `${field}[${index}]`);
      return id;
    });
  }

  function validateManifests<K extends OwnerKey>(
    value: unknown,
    field: string,
    ownerKey: K,
  ): Array<Record<K, string> & { ids: string[] }> {
    return validateRows(value, field, (item, index) => {
      const itemField = `${field}[${index}]`;
      const idsField = `${itemField}.ids`;
      const ownerId = item[ownerKey];
      assertId(ownerId, `${itemField}.${ownerKey}`);
      const ids = asArray(item.ids, idsField).map((id, idIndex) => {
        assertId(id, `${idsField}[${idIndex}]`);
        return id;
      });
      return { [ownerKey]: ownerId, ids } as Record<K, string> & {
        ids: string[];
      };
    });
  }

  return function validateSqlCommit(payload: SqlCommit): NormalizedSqlCommit {
    if (!isRecord(payload)) {
      throw new PayloadError("Sync payload must be an object");
    }
    assertPosition(payload.baseRevision, "baseRevision");

    let rootUpserts: SqlSettingUpsert[] = [];
    let rootDeletes: string[] = [];
    if (payload.root !== undefined) {
      if (!isRecord(payload.root)) {
        throw new PayloadError("root must be an object");
      }
      rootUpserts = asArray(payload.root.upserts, "root.upserts").map(
        (item, index) => {
          if (!isRecord(item)) {
            throw new PayloadError(`root.upserts[${index}] must be an object`);
          }
          assertId(item.key, `root.upserts[${index}].key`);
          if (isReservedRootSettingKey(item.key)) {
            throw new PayloadError(`${item.key} must be written through presets`);
          }
          return { key: item.key, value: item.value };
        },
      );
      rootDeletes = asArray(payload.root.deletes, "root.deletes").map(
        (key, index) => {
          assertId(key, `root.deletes[${index}]`);
          if (isReservedRootSettingKey(key)) {
            throw new PayloadError(`${key} is not a root setting`);
          }
          return key;
        },
      );
    }

    let presets: NormalizedSqlCommit["presets"];
    if (payload.presets !== undefined) {
      if (!isRecord(payload.presets)) {
        throw new PayloadError("presets must be an object");
      }
      const upserts = asArray(
        payload.presets.upserts,
        "presets.upserts",
      ).map((item, index) => {
        if (!isRecord(item)) {
          throw new PayloadError(
            `presets.upserts[${index}] must be an object`,
          );
        }
        assertId(item.id, `presets.upserts[${index}].id`);
        if (item.position !== undefined) {
          assertPosition(item.position, `presets.upserts[${index}].position`);
        }
        if (!isRecord(item.data)) {
          throw new PayloadError(
            `presets.upserts[${index}].data must be an object`,
          );
        }
        return { id: item.id, position: item.position, data: item.data };
      });
      const deletes = asArray(
        payload.presets.deletes,
        "presets.deletes",
      ).map((id, index) => {
        assertId(id, `presets.deletes[${index}]`);
        return id;
      });
      const order =
        payload.presets.order === undefined
          ? undefined
          : asArray(payload.presets.order, "presets.order").map(
              (id, index) => {
                assertId(id, `presets.order[${index}]`);
                return id;
              },
            );
      if (payload.presets.activeId !== undefined) {
        assertId(payload.presets.activeId, "presets.activeId");
      }
      presets = {
        upserts,
        deletes,
        order,
        activeId: payload.presets.activeId,
      };
    }

    let pluginStorageUpserts: SqlSettingUpsert[] = [];
    let pluginStorageDeletes: string[] = [];
    let pluginStorageClear = false;
    if (payload.pluginStorage !== undefined) {
      if (!isRecord(payload.pluginStorage)) {
        throw new PayloadError("pluginStorage must be an object");
      }
      pluginStorageClear = Boolean(payload.pluginStorage.clear);
      pluginStorageUpserts = asArray(
        payload.pluginStorage.upserts,
        "pluginStorage.upserts",
      ).map((item, index) => {
        if (!isRecord(item)) {
          throw new PayloadError(
            `pluginStorage.upserts[${index}] must be an object`,
          );
        }
        assertId(item.key, `pluginStorage.upserts[${index}].key`);
        return { key: item.key, value: item.value };
      });
      pluginStorageDeletes = asArray(
        payload.pluginStorage.deletes,
        "pluginStorage.deletes",
      ).map((key, index) => {
        assertId(key, `pluginStorage.deletes[${index}]`);
        return key;
      });
    }

    const characters = validateEntityRows(payload.characters, "characters");
    const characterTouches = validateRows(
      payload.characterTouches,
      "characterTouches",
      (row, index) => {
        const rowField = `characterTouches[${index}]`;
        assertId(row.id, `${rowField}.id`);
        if (
          !Number.isSafeInteger(row.lastInteraction) ||
          (row.lastInteraction as number) < 0
        ) {
          throw new PayloadError(
            `${rowField}.lastInteraction must be a non-negative safe integer`,
          );
        }
        return { id: row.id, lastInteraction: row.lastInteraction as number };
      },
    );
    const chats = validateEntityRows(payload.chats, "chats", "characterId");
    const messages = validateEntityRows(payload.messages, "messages", "chatId");
    const chatManifests = validateManifests(
      payload.chatManifests,
      "chatManifests",
      "characterId",
    );
    const messageManifests = validateManifests(
      payload.messageManifests,
      "messageManifests",
      "chatId",
    );
    const messageDeletes =
      payload.messageDeletes === undefined
        ? undefined
        : validateManifests(payload.messageDeletes, "messageDeletes", "chatId");
    const chatDeletes = validateOptionalIds(payload.chatDeletes, "chatDeletes");
    const characterIds = validateOptionalIds(
      payload.characterIds,
      "characterIds",
    );
    const characterDeletes = validateOptionalIds(
      payload.characterDeletes,
      "characterDeletes",
    );
    const action =
      typeof payload.action === "string" &&
      payload.action.length > 0 &&
      payload.action.length <= 64
        ? payload.action
        : undefined;

    return {
      replaceAll: Boolean(payload.replaceAll),
      action,
      baseRevision: payload.baseRevision,
      rootUpserts,
      rootDeletes,
      pluginStorageUpserts,
      pluginStorageDeletes,
      pluginStorageClear,
      presets,
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
  };
}
