"use strict";

const SPECIAL_TAG = "__risu_storage_sync_special_v1_4bd9821f__";
const OBJECT_TAG = "__risu_storage_sync_object_v1_4bd9821f__";

function defineValue(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function encodeSpecialNumber(value) {
  if (Number.isNaN(value)) return { [SPECIAL_TAG]: "nan" };
  if (value === Number.POSITIVE_INFINITY) return { [SPECIAL_TAG]: "infinity" };
  if (value === Number.NEGATIVE_INFINITY) return { [SPECIAL_TAG]: "-infinity" };
  if (Object.is(value, -0)) return { [SPECIAL_TAG]: "-0" };
  return value;
}
function encodeStorageSyncValue(value) {
  if (value === undefined) return { [SPECIAL_TAG]: "undefined" };
  if (typeof value === "number") return encodeSpecialNumber(value);
  if (Array.isArray(value)) return value.map(encodeStorageSyncValue);
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value);
  const mustEscape = entries.some(
    ([key]) => key === SPECIAL_TAG || key === OBJECT_TAG,
  );
  if (mustEscape) {
    return {
      [OBJECT_TAG]: entries.map(([key, item]) => [
        key,
        encodeStorageSyncValue(item),
      ]),
    };
  }

  let encoded = null;
  for (let index = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    const next = encodeStorageSyncValue(item);
    if (next !== item && encoded === null) {
      encoded = {};
      for (let previous = 0; previous < index; previous++) {
        defineValue(encoded, entries[previous][0], entries[previous][1]);
      }
    }
    if (encoded !== null) defineValue(encoded, key, next);
  }
  return encoded || value;
}

function decodeSpecial(value) {
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
    case "undefined": return { matched: true, value: undefined };
    case "nan": return { matched: true, value: Number.NaN };
    case "infinity": return { matched: true, value: Number.POSITIVE_INFINITY };
    case "-infinity": return { matched: true, value: Number.NEGATIVE_INFINITY };
    case "-0": return { matched: true, value: -0 };
    default: return { matched: false, value };
  }
}

function decodeStorageSyncValue(value) {
  if (Array.isArray(value)) return value.map(decodeStorageSyncValue);
  if (!value || typeof value !== "object") return value;

  const special = decodeSpecial(value);
  if (special.matched) return special.value;
  if (
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, OBJECT_TAG) &&
    Array.isArray(value[OBJECT_TAG])
  ) {
    const decoded = {};
    for (const entry of value[OBJECT_TAG]) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
        return decodeStorageSyncObject(value);
      }
      defineValue(decoded, entry[0], decodeStorageSyncValue(entry[1]));
    }
    return decoded;
  }
  return decodeStorageSyncObject(value);
}
function decodeStorageSyncObject(value) {
  let decoded = null;
  const entries = Object.entries(value);
  for (let index = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    const next = decodeStorageSyncValue(item);
    if (next !== item && decoded === null) {
      decoded = {};
      for (let previous = 0; previous < index; previous++) {
        defineValue(decoded, entries[previous][0], entries[previous][1]);
      }
    }
    if (decoded !== null) defineValue(decoded, key, next);
  }
  return decoded || value;
}

module.exports = {
  STORAGE_SYNC_OBJECT_TAG: OBJECT_TAG,
  STORAGE_SYNC_SPECIAL_TAG: SPECIAL_TAG,
  decodeStorageSyncValue,
  encodeStorageSyncValue,
};
