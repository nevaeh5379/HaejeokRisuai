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
    const pluginStorage = this.parsePluginStorage(payload.pluginStorage);
    const entities = this.parseEntities(payload);

    return {
      replaceAll: Boolean(payload.replaceAll),
      action: this.parseAction(payload.action),
      baseRevision,
      ...root,
      ...pluginStorage,
      presets,
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
