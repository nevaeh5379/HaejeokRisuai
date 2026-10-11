const POSTGRES_TEXT_TAG: any = "__risu_pg_text_utf16le_v1_8e81b0b9__";
const POSTGRES_OBJECT_ENTRIES_TAG: any =
  "__risu_pg_object_entries_v1_8e81b0b9__";
const POSTGRES_SCRIPT_TAG: any = "__risu_pg_script_utf16le_v1_8e81b0b9__:";

function encodePostgresScript(script?: any): any {
  if (canUsePostgresText(script) && !script.startsWith(POSTGRES_SCRIPT_TAG)) {
    return script;
  }
  return (
    POSTGRES_SCRIPT_TAG + Buffer.from(script, "utf16le").toString("base64")
  );
}

function decodePostgresScript(script?: any): any {
  if (typeof script !== "string" || !script.startsWith(POSTGRES_SCRIPT_TAG)) {
    return script;
  }
  const encoded: any = script.slice(POSTGRES_SCRIPT_TAG.length);
  const buffer: any = Buffer.from(encoded, "base64");
  if (buffer.length % 2 !== 0 || buffer.toString("base64") !== encoded) {
    return script;
  }
  return buffer.toString("utf16le");
}

function defineJsonProperty(target?: any, key?: any, value?: any): any {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function mapJsonArrayCopyOnWrite(values?: any, mapper?: any): any {
  let mapped: any = null;
  for (let index: any = 0; index < values.length; index++) {
    const original: any = values[index];
    const next: any = mapper(original);
    if (next !== original && mapped === null) {
      mapped = values.slice(0, index);
    }
    if (mapped !== null) {
      mapped.push(next);
    }
  }
  return mapped || values;
}

function encodePostgresJsonValue(value?: any): any {
  if (typeof value === "string") {
    if (!value.includes("\0")) {
      return value;
    }
    return {
      [POSTGRES_TEXT_TAG]: Buffer.from(value, "utf16le").toString("base64"),
    };
  }
  if (Array.isArray(value)) {
    return mapJsonArrayCopyOnWrite(value, encodePostgresJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const entries: any = Object.entries(value);
  const requiresEntriesWrapper: any = entries.some(
    ([key]: any) =>
      key.includes("\0") ||
      key === POSTGRES_TEXT_TAG ||
      key === POSTGRES_OBJECT_ENTRIES_TAG,
  );
  if (requiresEntriesWrapper) {
    return {
      [POSTGRES_OBJECT_ENTRIES_TAG]: entries.map(([key, item]: any) => [
        encodePostgresJsonValue(key),
        encodePostgresJsonValue(item),
      ]),
    };
  }

  let encoded: any = null;
  for (let index: any = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    const next: any = encodePostgresJsonValue(item);
    if (next !== item && encoded === null) {
      encoded = {};
      for (let previous: any = 0; previous < index; previous++) {
        defineJsonProperty(encoded, entries[previous][0], entries[previous][1]);
      }
    }
    if (encoded !== null) {
      defineJsonProperty(encoded, key, next);
    }
  }
  return encoded || value;
}

function decodePostgresTextWrapper(value?: any): any {
  if (
    Object.keys(value).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value, POSTGRES_TEXT_TAG) ||
    typeof value[POSTGRES_TEXT_TAG] !== "string"
  ) {
    return null;
  }
  const encoded: any = value[POSTGRES_TEXT_TAG];
  const buffer: any = Buffer.from(encoded, "base64");
  if (buffer.length % 2 !== 0 || buffer.toString("base64") !== encoded) {
    return null;
  }
  const decoded: any = buffer.toString("utf16le");
  return decoded.includes("\0") ? decoded : null;
}

function decodePostgresJsonValue(value?: any): any {
  if (Array.isArray(value)) {
    return mapJsonArrayCopyOnWrite(value, decodePostgresJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const decodedText: any = decodePostgresTextWrapper(value);
  if (decodedText !== null) {
    return decodedText;
  }

  if (
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, POSTGRES_OBJECT_ENTRIES_TAG) &&
    Array.isArray(value[POSTGRES_OBJECT_ENTRIES_TAG])
  ) {
    const decodedObject: any = {};
    for (const entry of value[POSTGRES_OBJECT_ENTRIES_TAG]) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        return decodePostgresJsonObject(value);
      }
      const key: any = decodePostgresJsonValue(entry[0]);
      if (typeof key !== "string") {
        return decodePostgresJsonObject(value);
      }
      defineJsonProperty(decodedObject, key, decodePostgresJsonValue(entry[1]));
    }
    return decodedObject;
  }
  return decodePostgresJsonObject(value);
}

function decodePostgresJsonObject(value?: any): any {
  const entries: any = Object.entries(value);
  let decoded: any = null;
  for (let index: any = 0; index < entries.length; index++) {
    const [key, item] = entries[index];
    const next: any = decodePostgresJsonValue(item);
    if (next !== item && decoded === null) {
      decoded = {};
      for (let previous: any = 0; previous < index; previous++) {
        defineJsonProperty(decoded, entries[previous][0], entries[previous][1]);
      }
    }
    if (decoded !== null) {
      defineJsonProperty(decoded, key, next);
    }
  }
  return decoded || value;
}

function canUsePostgresText(value?: any): any {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

export {
  canUsePostgresText,
  decodePostgresScript,
  decodePostgresJsonValue,
  encodePostgresScript,
  encodePostgresJsonValue,
};
