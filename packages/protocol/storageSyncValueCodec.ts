"use strict";

const SPECIAL_TAG: any = "__risu_storage_sync_special_v1_4bd9821f__";
const OBJECT_TAG: any = "__risu_storage_sync_object_v1_4bd9821f__";
//TODO remove any and change it to a struct Type.

function defineValue(target?: any, key?: any, value?: any): any {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function encodeSpecialNumber(value?: any): any {
  if (Number.isNaN(value)) return { [SPECIAL_TAG]: "nan" };
  if (value === Number.POSITIVE_INFINITY) return { [SPECIAL_TAG]: "infinity" };
  if (value === Number.NEGATIVE_INFINITY) return { [SPECIAL_TAG]: "-infinity" };
  if (Object.is(value, -0)) return { [SPECIAL_TAG]: "-0" };
  return value;
}
function encodeStorageSyncValue(value: unknown): unknown;
function encodeStorageSyncValue(value?: any): any {
  if (value === undefined) return { [SPECIAL_TAG]: "undefined" };
  if (typeof value === "number") return encodeSpecialNumber(value);
  if (Array.isArray(value)) return value.map(encodeStorageSyncValue);
  if (!value || typeof value !== "object") return value;

  const entries: any = Object.entries(value);
  const mustEscape: any = entries.some(
    ([key]: any) => key === SPECIAL_TAG || key === OBJECT_TAG,
  );
  if (mustEscape) {
    return {
      [OBJECT_TAG]: entries.map(([key, item]: any) => [
        key,
        encodeStorageSyncValue(item),
      ]),
    };
  }

  let encoded: any = null;
  for (let index: any = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    const next: any = encodeStorageSyncValue(item);
    if (next !== item && encoded === null) {
      encoded = {};
      for (let previous: any = 0; previous < index; previous++) {
        defineValue(encoded, entries[previous][0], entries[previous][1]);
      }
    }
    if (encoded !== null) defineValue(encoded, key, next);
  }
  return encoded || value;
}

function decodeSpecial(value?: any): any {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, SPECIAL_TAG)
  ) {
    return { matched: false, value };
  }
  switch (value[SPECIAL_TAG]) {
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

function decodeStorageSyncValue(value: unknown): unknown;
function decodeStorageSyncValue(value?: any): any {
  if (Array.isArray(value)) return value.map(decodeStorageSyncValue);
  if (!value || typeof value !== "object") return value;

  const special: any = decodeSpecial(value);
  if (special.matched) return special.value;
  if (
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, OBJECT_TAG) &&
    Array.isArray(value[OBJECT_TAG])
  ) {
    const decoded: any = {};
    for (const entry of value[OBJECT_TAG]) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== "string"
      ) {
        return decodeStorageSyncObject(value);
      }
      defineValue(decoded, entry[0], decodeStorageSyncValue(entry[1]));
    }
    return decoded;
  }
  return decodeStorageSyncObject(value);
}
function decodeStorageSyncObject(value?: any): any {
  let decoded: any = null;
  const entries: any = Object.entries(value);
  for (let index: any = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    const next: any = decodeStorageSyncValue(item);
    if (next !== item && decoded === null) {
      decoded = {};
      for (let previous: any = 0; previous < index; previous++) {
        defineValue(decoded, entries[previous][0], entries[previous][1]);
      }
    }
    if (decoded !== null) defineValue(decoded, key, next);
  }
  return decoded || value;
}

export {
  OBJECT_TAG as STORAGE_SYNC_OBJECT_TAG,
  SPECIAL_TAG as STORAGE_SYNC_SPECIAL_TAG,
  decodeStorageSyncValue,
  encodeStorageSyncValue,
};
