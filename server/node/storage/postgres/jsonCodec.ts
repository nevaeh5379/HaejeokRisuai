// Persisted tag values must remain compatible with previously stored data.
const TEXT_TAG = "__risu_pg_text_utf16le_v1_8e81b0b9__";
const OBJECT_ENTRIES_TAG = "__risu_pg_object_entries_v1_8e81b0b9__";
const SCRIPT_TAG = "__risu_pg_script_utf16le_v1_8e81b0b9__:";

function encodeScript(script: string): string;
function encodeScript(script?: unknown): unknown;
function encodeScript(script?: unknown): unknown {
  if (typeof script !== "string") return script;
  if (canUseText(script) && !script.startsWith(SCRIPT_TAG)) return script;

  return SCRIPT_TAG + Buffer.from(script, "utf16le").toString("base64");
}

function decodeScript(script: string): string;
function decodeScript(script?: unknown): unknown;
function decodeScript(script?: unknown): unknown {
  if (typeof script !== "string" || !script.startsWith(SCRIPT_TAG)) {
    return script;
  }

  const encoded = script.slice(SCRIPT_TAG.length);
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

function mapJsonArrayCopyOnWrite<T>(values: T[], mapper: (val: T) => T): T[] {
  let mapped: T[] | null = null;
  for (let index = 0; index < values.length; index++) {
    const original = values[index];
    const next = mapper(original);
    if (next !== original && mapped === null) mapped = values.slice(0, index);

    if (mapped !== null) mapped.push(next);
  }
  return mapped || values;
}

type TextWrapper = { [TEXT_TAG]: string };

// Only unsafe strings are wrapped; unrelated values retain their original shape.
function encodeJsonValue(value: string): string | TextWrapper;
function encodeJsonValue(value?: unknown): unknown;
function encodeJsonValue(value?: unknown): unknown {
  if (typeof value === "string") {
    if (!value.includes("\0")) return value;

    return {
      [TEXT_TAG]: Buffer.from(value, "utf16le").toString("base64"),
    };
  }
  if (Array.isArray(value)) {
    return mapJsonArrayCopyOnWrite(value, encodeJsonValue);
  }

  if (!value || typeof value !== "object") return value;

  const rec = value as Record<string, unknown>;
  const keys: (keyof typeof rec)[] = Object.keys(rec);

  const requiresEntriesWrapper = keys.some(
    (key) =>
      key.includes("\0") || key === TEXT_TAG || key === OBJECT_ENTRIES_TAG,
  );
  if (requiresEntriesWrapper) return encodeObjectEntries(rec, keys);

  let encoded: Record<string, unknown> | null = null;

  keys
    .map((key) => {
      return { key, item: rec[key], next: encodeJsonValue(rec[key]) };
    })
    .forEach(({ key, item, next }) => {
      if (next !== item && encoded === null) encoded = { ...rec };

      if (encoded !== null) defineJsonProperty(encoded, key, next);
    });

  return encoded ?? rec;
}

function encodeObjectEntries(
  rec: Record<string, unknown>,
  keys: readonly string[],
) {
  const entries: Array<[string | TextWrapper, unknown]> = new Array(
    keys.length,
  );
  for (let i = 0; i < keys.length; i++) {
    entries[i] = [encodeJsonValue(keys[i]), encodeJsonValue(rec[keys[i]])];
  }

  return {
    [OBJECT_ENTRIES_TAG]: entries,
  };
}

function decodeTextWrapper(value: Record<string, unknown>): string | null {
  if (!Object.hasOwn(value, TEXT_TAG) || typeof value[TEXT_TAG] !== "string") {
    return null;
  }

  for (const k in value) if (k !== TEXT_TAG) return null;

  const encoded = value[TEXT_TAG];
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length % 2 !== 0 || buffer.toString("base64") !== encoded) {
    return null;
  }

  const decoded = buffer.toString("utf16le");
  return decoded.includes("\0") ? decoded : null;
}

// Decoding storage tags does not validate the caller's domain schema.
function decodeJsonValue(value?: unknown): unknown {
  if (Array.isArray(value)) {
    return mapJsonArrayCopyOnWrite(value, decodeJsonValue);
  }

  if (!value || typeof value !== "object") return value;

  const rec = value as Record<string, unknown>;
  const decodedText = decodeTextWrapper(rec);
  if (decodedText !== null) return decodedText;

  if (
    Object.hasOwn(rec, OBJECT_ENTRIES_TAG) &&
    Array.isArray(rec[OBJECT_ENTRIES_TAG])
  ) {
    let onlyEntriesTag = true;
    for (const k in rec) {
      if (k !== OBJECT_ENTRIES_TAG) {
        onlyEntriesTag = false;
        break;
      }
    }

    if (onlyEntriesTag) {
      const entries = rec[OBJECT_ENTRIES_TAG] as unknown[];
      const decodedObject: Record<string, unknown> = {};
      for (const element of entries) {
        const entry = element;
        if (!Array.isArray(entry) || entry.length !== 2) {
          return decodeJsonObject(rec);
        }

        const key = decodeJsonValue(entry[0]);
        if (typeof key !== "string") return decodeJsonObject(rec);

        defineJsonProperty(decodedObject, key, decodeJsonValue(entry[1]));
      }
      return decodedObject;
    }
  }
  return decodeJsonObject(rec);
}

function decodeJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(value);
  let decoded: Record<string, unknown> | null = null;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    const item = value[key];
    const next = decodeJsonValue(item);
    if (next !== item && decoded === null) {
      decoded = {};
      for (let previous = 0; previous < index; previous++) {
        const prevKey = keys[previous];
        defineJsonProperty(decoded, prevKey, value[prevKey]);
      }
    }
    if (decoded !== null) defineJsonProperty(decoded, key, next);
  }
  return decoded || value;
}

function canUseText(value?: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0")) return false;

  const text = value as string & { isWellFormed?: () => boolean };
  if (typeof text.isWellFormed === "function") return text.isWellFormed();

  return Buffer.from(value, "utf8").toString("utf8") === value;
}

export {
  canUseText,
  decodeScript,
  decodeJsonValue,
  encodeScript,
  encodeJsonValue,
};
