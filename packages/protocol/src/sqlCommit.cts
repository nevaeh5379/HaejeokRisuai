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

/**
 * Validates a raw SQL commit body and returns the normalized commit consumed by
 * storage backends. The raw body is unknown until these runtime checks pass.
 */
export type SqlCommitValidator = (rawPayload: unknown) => NormalizedSqlCommit;

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

  // Reads an optional array field, defaulting omitted fields to an empty array
  // and rejecting values of any other type.
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

  // Parses an array of JSON objects and delegates each validated row to the
  // domain-specific row parser.
  function parseRows<T>(
    value: unknown,
    field: string,
    parseRow: (row: UnknownRecord, index: number) => T,
  ): T[] {
    return asArray(value, field).map((row, index) => {
      if (!isRecord(row)) {
        throw new PayloadError(`${field}[${index}] must be an object`);
      }
      return parseRow(row, index);
    });
  }

  // Parses an ID array and optionally applies an additional domain rule after
  // each ID passes the shared string and length checks.
  function parseIds(
    value: unknown,
    field: string,
    validateId?: (id: string, index: number) => void,
  ): string[] {
    return asArray(value, field).map((id, index) => {
      assertId(id, `${field}[${index}]`);
      validateId?.(id, index);
      return id;
    });
  }

  // Parses setting upserts into { key, value } rows and optionally applies a
  // section-specific key rule.
  function parseSettingUpserts(
    value: unknown,
    field: string,
    validateKey?: (key: string, index: number) => void,
  ): SqlSettingUpsert[] {
    return parseRows(value, field, (row, index) => {
      assertId(row.key, `${field}[${index}].key`);
      validateKey?.(row.key, index);
      return { key: row.key, value: row.value };
    });
  }

  // Parses character upserts directly and chat/message upserts with their
  // characterId or chatId owner field.
  function parseEntityRows(value: unknown, field: string): SqlCharacterUpsert[];
  function parseEntityRows(
    value: unknown,
    field: string,
    ownerKey: "characterId",
  ): SqlChatUpsert[];
  function parseEntityRows(
    value: unknown,
    field: string,
    ownerKey: "chatId",
  ): SqlMessageUpsert[];
  function parseEntityRows(
    value: unknown,
    field: string,
    ownerKey?: OwnerKey,
  ): Array<SqlCharacterUpsert | SqlChatUpsert | SqlMessageUpsert> {
    return parseRows(value, field, (row, index) => {
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

  // Preserves undefined for optional deletion collections while reusing the
  // standard ID-array parser when the field is present.
  function parseOptionalIds(
    value: unknown,
    field: string,
  ): string[] | undefined {
    if (value === undefined) return undefined;
    return parseIds(value, field);
  }

  // Parses owner-to-child-ID manifests used to synchronize chat and message
  // membership and explicit message deletions.
  function parseManifests<K extends OwnerKey>(
    value: unknown,
    field: string,
    ownerKey: K,
  ): Array<Record<K, string> & { ids: string[] }> {
    return parseRows(value, field, (item, index) => {
      const itemField = `${field}[${index}]`;
      const idsField = `${itemField}.ids`;
      const ownerId = item[ownerKey];
      assertId(ownerId, `${itemField}.${ownerKey}`);
      const ids = parseIds(item.ids, idsField);
      return { [ownerKey]: ownerId, ids } as Record<K, string> & {
        ids: string[];
      };
    });
  }

  // Rejects non-object request bodies and narrows the top-level payload to a
  // record for the section parsers below.
  function parsePayload(rawPayload: unknown): UnknownRecord {
    if (!isRecord(rawPayload))
      throw new PayloadError("Sync payload must be an object");

    return rawPayload;
  }

  function parseBaseRevision(value: unknown): number {
    assertPosition(value, "baseRevision");
    return value;
  }

  // Prevents preset-owned settings from being written or deleted through the
  // generic root-settings section.
  function rejectReservedRootUpsert(key: string): void {
    if (isReservedRootSettingKey(key))
      throw new PayloadError(`${key} must be written through presets`);
  }

  function rejectReservedRootDelete(key: string): void {
    if (isReservedRootSettingKey(key))
      throw new PayloadError(`${key} is not a root setting`);
  }

  // Parses generic root-setting upserts and deletes, applying the reserved-key
  // policy to both operations.
  function parseRoot(value: unknown): {
    rootUpserts: SqlSettingUpsert[];
    rootDeletes: string[];
  } {
    if (value === undefined) return { rootUpserts: [], rootDeletes: [] };

    if (!isRecord(value)) throw new PayloadError("root must be an object");

    const rootUpserts = parseSettingUpserts(
      value.upserts,
      "root.upserts",
      rejectReservedRootUpsert,
    );
    const rootDeletes = parseIds(
      value.deletes,
      "root.deletes",
      rejectReservedRootDelete,
    );
    return { rootUpserts, rootDeletes };
  }

  // Parses preset upserts, deletes, ordering, and the active preset identifier.
  function parsePresets(value: unknown): NormalizedSqlCommit["presets"] {
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
      throw new PayloadError("presets must be an object");
    }
    const upserts = parseRows(
      value.upserts,
      "presets.upserts",
      (item, index) => {
        assertId(item.id, `presets.upserts[${index}].id`);

        if (item.position !== undefined)
          assertPosition(item.position, `presets.upserts[${index}].position`);

        if (!isRecord(item.data))
          throw new PayloadError(
            `presets.upserts[${index}].data must be an object`,
          );

        return { id: item.id, position: item.position, data: item.data };
      },
    );
    const deletes = parseIds(value.deletes, "presets.deletes");
    const order =
      value.order === undefined
        ? undefined
        : parseIds(value.order, "presets.order");
    if (value.activeId !== undefined) {
      assertId(value.activeId, "presets.activeId");
    }
    return {
      upserts,
      deletes,
      order,
      activeId: value.activeId,
    };
  }

  // Parses plugin-storage upserts, deletes, and the optional clear operation.
  function parsePluginStorage(value: unknown): {
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
      throw new PayloadError("pluginStorage must be an object");
    }
    const pluginStorageUpserts = parseSettingUpserts(
      value.upserts,
      "pluginStorage.upserts",
    );
    const pluginStorageDeletes = parseIds(
      value.deletes,
      "pluginStorage.deletes",
    );
    return {
      pluginStorageUpserts,
      pluginStorageDeletes,
      pluginStorageClear: Boolean(value.clear),
    };
  }

  function parseCharacterTouches(value: unknown): SqlCharacterTouch[] {
    return parseRows(value, "characterTouches", (row, index) => {
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
    });
  }

  function parseAction(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 && value.length <= 64
      ? value
      : undefined;
  }

  function parseEntities(
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
    const characters = parseEntityRows(payload.characters, "characters");
    const characterTouches = parseCharacterTouches(payload.characterTouches);
    const chats = parseEntityRows(payload.chats, "chats", "characterId");
    const messages = parseEntityRows(payload.messages, "messages", "chatId");
    const chatManifests = parseManifests(
      payload.chatManifests,
      "chatManifests",
      "characterId",
    );
    const messageManifests = parseManifests(
      payload.messageManifests,
      "messageManifests",
      "chatId",
    );
    const messageDeletes =
      payload.messageDeletes === undefined
        ? undefined
        : parseManifests(payload.messageDeletes, "messageDeletes", "chatId");
    const chatDeletes = parseOptionalIds(payload.chatDeletes, "chatDeletes");
    const characterIds = parseOptionalIds(payload.characterIds, "characterIds");
    const characterDeletes = parseOptionalIds(
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
  return function validateSqlCommit(rawPayload: unknown): NormalizedSqlCommit {
    const payload = parsePayload(rawPayload);
    const baseRevision = parseBaseRevision(payload.baseRevision);
    const root = parseRoot(payload.root);
    const presets = parsePresets(payload.presets);
    const pluginStorage = parsePluginStorage(payload.pluginStorage);
    const entities = parseEntities(payload);

    return {
      replaceAll: Boolean(payload.replaceAll),
      action: parseAction(payload.action),
      baseRevision,
      ...root,
      ...pluginStorage,
      presets,
      ...entities,
    };
  };
}
