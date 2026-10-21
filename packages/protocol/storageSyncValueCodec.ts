"use strict";

const SPECIAL_TAG = "__risu_storage_sync_special_v1_4bd9821f__";
const OBJECT_TAG = "__risu_storage_sync_object_v1_4bd9821f__";

function defineValue(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function encodeSpecialNumber(value: number): unknown {
  if (Number.isNaN(value)) return { [SPECIAL_TAG]: "nan" };
  if (value === Number.POSITIVE_INFINITY) return { [SPECIAL_TAG]: "infinity" };
  if (value === Number.NEGATIVE_INFINITY) return { [SPECIAL_TAG]: "-infinity" };
  if (Object.is(value, -0)) return { [SPECIAL_TAG]: "-0" };
  return value;
}

function encodeStorageSyncValue(value: unknown): unknown {
  if (value === undefined) return { [SPECIAL_TAG]: "undefined" };
  if (typeof value === "number") return encodeSpecialNumber(value);
  if (Array.isArray(value)) return value.map(encodeStorageSyncValue);
  if (!value || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  let mustEscape = false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (key === SPECIAL_TAG || key === OBJECT_TAG) {
      mustEscape = true;
      break;
    }
  }

  if (mustEscape) {
    const encodedEntries: [string, unknown][] = new Array(keys.length);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      encodedEntries[index] = [key, encodeStorageSyncValue(record[key])];
    }
    return {
      [OBJECT_TAG]: encodedEntries,
    };
  }

  let encoded: Record<string, unknown> | null = null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const item = record[key];
    const next = encodeStorageSyncValue(item);
    if (next !== item && encoded === null) {
      encoded = {};
      for (let previous = 0; previous < index; previous++) {
        const prevKey = keys[previous];
        defineValue(encoded, prevKey, record[prevKey]);
      }
    }
    if (encoded !== null) defineValue(encoded, key, next);
  }
  return encoded || value;
}

function decodeSpecial(
  value: unknown,
): { matched: true; value: unknown } | { matched: false; value: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { matched: false, value };
  }
  const record = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, SPECIAL_TAG)) {
    return { matched: false, value };
  }
  for (const k in record) {
    if (k !== SPECIAL_TAG && Object.prototype.hasOwnProperty.call(record, k)) {
      return { matched: false, value };
    }
  }
  switch (record[SPECIAL_TAG]) {
    case "undefined":
      return { matched: true, value: undefined };
    case "nan":
      return { matched: true, value: Number.NaN };
    case "infinity":
      return { matched: true, value: Number.POSITIVE_INFINITY };
    case "-infinity":
      return { matched: true, value: Number.NEGATIVE_INFINITY };
    case "-0":
      return { matched: true, value: -0 };
    default:
      return { matched: false, value };
  }
}

function decodeStorageSyncValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeStorageSyncValue);
  if (!value || typeof value !== "object") return value;

  const special = decodeSpecial(value);
  if (special.matched) return special.value;

  const record = value as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(record, OBJECT_TAG) &&
    Array.isArray(record[OBJECT_TAG])
  ) {
    let isSingleProp = true;
    for (const k in record) {
      if (k !== OBJECT_TAG && Object.prototype.hasOwnProperty.call(record, k)) {
        isSingleProp = false;
        break;
      }
    }
    if (isSingleProp) {
      const decoded: Record<string, unknown> = {};
      const entries = record[OBJECT_TAG] as unknown[];
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string"
        ) {
          return decodeStorageSyncObject(record);
        }
        defineValue(decoded, entry[0], decodeStorageSyncValue(entry[1]));
      }
      return decoded;
    }
  }
  return decodeStorageSyncObject(record);
}

function decodeStorageSyncObject(record: Record<string, unknown>): unknown {
  let decoded: Record<string, unknown> | null = null;
  const keys = Object.keys(record);
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const item = record[key];
    const next = decodeStorageSyncValue(item);
    if (next !== item && decoded === null) {
      decoded = {};
      for (let previous = 0; previous < index; previous++) {
        const prevKey = keys[previous];
        defineValue(decoded, prevKey, record[prevKey]);
      }
    }
    if (decoded !== null) defineValue(decoded, key, next);
  }
  return decoded || record;
}

export {
  OBJECT_TAG as STORAGE_SYNC_OBJECT_TAG,
  SPECIAL_TAG as STORAGE_SYNC_SPECIAL_TAG,
  decodeStorageSyncValue,
  encodeStorageSyncValue,
};
