const POSTGRES_TEXT_TAG = "__risu_pg_text_utf16le_v1_8e81b0b9__";
const POSTGRES_OBJECT_ENTRIES_TAG = "__risu_pg_object_entries_v1_8e81b0b9__";
const POSTGRES_SCRIPT_TAG = "__risu_pg_script_utf16le_v1_8e81b0b9__:";

function encodePostgresScript(script?: unknown): unknown {
  if (typeof script !== "string") return script;
  if (canUsePostgresText(script) && !script.startsWith(POSTGRES_SCRIPT_TAG)) {
    return script;
  }
  return (
    POSTGRES_SCRIPT_TAG + Buffer.from(script, "utf16le").toString("base64")
  );
}

function decodePostgresScript(script?: unknown): unknown {
  if (typeof script !== "string" || !script.startsWith(POSTGRES_SCRIPT_TAG)) {
    return script;
  }
  const encoded = script.slice(POSTGRES_SCRIPT_TAG.length);
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length % 2 !== 0 || buffer.toString("base64") !== encoded) {
    return script;
  }
  return buffer.toString("utf16le");
}

function defineJsonProperty(
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

function mapJsonArrayCopyOnWrite(
  values: unknown[],
  mapper: (val: unknown) => unknown,
): unknown[] {
  let mapped: unknown[] | null = null;
  for (let index = 0; index < values.length; index++) {
    const original = values[index];
    const next = mapper(original);
    if (next !== original && mapped === null) {
      mapped = values.slice(0, index);
    }
    if (mapped !== null) {
      mapped.push(next);
    }
  }
  return mapped || values;
}

function encodePostgresJsonValue(value?: unknown): unknown {
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

  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec);

  let requiresEntriesWrapper = false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (
      key.includes("\0") ||
      key === POSTGRES_TEXT_TAG ||
      key === POSTGRES_OBJECT_ENTRIES_TAG
    ) {
      requiresEntriesWrapper = true;
      break;
    }
  }

  if (requiresEntriesWrapper) {
    const entries: Array<[unknown, unknown]> = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      entries[i] = [
        encodePostgresJsonValue(key),
        encodePostgresJsonValue(rec[key]),
      ];
    }
    return {
      [POSTGRES_OBJECT_ENTRIES_TAG]: entries,
    };
  }

  let encoded: Record<string, unknown> | null = null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const item = rec[key];
    const next = encodePostgresJsonValue(item);
    if (next !== item && encoded === null) {
      encoded = {};
      for (let previous = 0; previous < index; previous++) {
        const prevKey = keys[previous];
        defineJsonProperty(encoded, prevKey, rec[prevKey]);
      }
    }
    if (encoded !== null) {
      defineJsonProperty(encoded, key, next);
    }
  }
  return encoded || value;
}

function decodePostgresTextWrapper(
  value: Record<string, unknown>,
): string | null {
  if (
    !Object.prototype.hasOwnProperty.call(value, POSTGRES_TEXT_TAG) ||
    typeof value[POSTGRES_TEXT_TAG] !== "string"
  ) {
    return null;
  }
  for (const k in value) {
    if (k !== POSTGRES_TEXT_TAG) return null;
  }
  const encoded = value[POSTGRES_TEXT_TAG] as string;
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length % 2 !== 0 || buffer.toString("base64") !== encoded) {
    return null;
  }
  const decoded = buffer.toString("utf16le");
  return decoded.includes("\0") ? decoded : null;
}

function decodePostgresJsonValue(value?: unknown): any {
  if (Array.isArray(value)) {
    return mapJsonArrayCopyOnWrite(value, decodePostgresJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const rec = value as Record<string, unknown>;
  const decodedText = decodePostgresTextWrapper(rec);
  if (decodedText !== null) {
    return decodedText;
  }

  if (
    Object.prototype.hasOwnProperty.call(rec, POSTGRES_OBJECT_ENTRIES_TAG) &&
    Array.isArray(rec[POSTGRES_OBJECT_ENTRIES_TAG])
  ) {
    let onlyEntriesTag = true;
    for (const k in rec) {
      if (k !== POSTGRES_OBJECT_ENTRIES_TAG) {
        onlyEntriesTag = false;
        break;
      }
    }
    if (onlyEntriesTag) {
      const entries = rec[POSTGRES_OBJECT_ENTRIES_TAG] as unknown[];
      const decodedObject: Record<string, unknown> = {};
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (!Array.isArray(entry) || entry.length !== 2) {
          return decodePostgresJsonObject(rec);
        }
        const key = decodePostgresJsonValue(entry[0]);
        if (typeof key !== "string") {
          return decodePostgresJsonObject(rec);
        }
        defineJsonProperty(
          decodedObject,
          key,
          decodePostgresJsonValue(entry[1]),
        );
      }
      return decodedObject;
    }
  }
  return decodePostgresJsonObject(rec);
}

function decodePostgresJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(value);
  let decoded: Record<string, unknown> | null = null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const item = value[key];
    const next = decodePostgresJsonValue(item);
    if (next !== item && decoded === null) {
      decoded = {};
      for (let previous = 0; previous < index; previous++) {
        const prevKey = keys[previous];
        defineJsonProperty(decoded, prevKey, value[prevKey]);
      }
    }
    if (decoded !== null) {
      defineJsonProperty(decoded, key, next);
    }
  }
  return decoded || value;
}

function canUsePostgresText(value?: unknown): boolean {
  if (typeof value !== "string" || value.includes("\0")) {
    return false;
  }
  if (typeof (value as any).isWellFormed === "function") {
    return (value as any).isWellFormed();
  }
  return Buffer.from(value, "utf8").toString("utf8") === value;
}

export {
  canUsePostgresText,
  decodePostgresScript,
  decodePostgresJsonValue,
  encodePostgresScript,
  encodePostgresJsonValue,
};
