const PLUGIN_STORAGE_ENCODING_KEY = "__risuai_plugin_storage_encoding__";
const PLUGIN_STORAGE_ENCODING = "base64-json-v1";

type EncodedPluginStorageValue = {
  [PLUGIN_STORAGE_ENCODING_KEY]: typeof PLUGIN_STORAGE_ENCODING;
  data: string;
};

function containsUnsupportedSqlUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0) return true;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index++;
        continue;
      }
      return true;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function requiresEncoding(
  value: unknown,
  visited = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return containsUnsupportedSqlUnicode(value);
  if (value === null || typeof value !== "object") return false;
  if (visited.has(value)) return false;
  visited.add(value);

  for (const [key, child] of Object.entries(value)) {
    if (
      containsUnsupportedSqlUnicode(key) ||
      requiresEncoding(child, visited)
    ) {
      return true;
    }
  }
  return false;
}

function isEncodedPluginStorageValue(
  value: unknown,
): value is EncodedPluginStorageValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    record[PLUGIN_STORAGE_ENCODING_KEY] === PLUGIN_STORAGE_ENCODING &&
    typeof record.data === "string"
  );
}

/**
 * PostgreSQL JSONB and some native SQL JSON implementations cannot represent
 * NUL or unpaired UTF-16 surrogates. Only affected values are wrapped so the
 * ordinary plugin-storage path keeps its current size and JSON shape.
 */
export function encodePluginStorageValue(value: unknown): unknown {
  if (!requiresEncoding(value)) return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  return {
    [PLUGIN_STORAGE_ENCODING_KEY]: PLUGIN_STORAGE_ENCODING,
    data: Buffer.from(serialized, "utf8").toString("base64"),
  } satisfies EncodedPluginStorageValue;
}

export function decodePluginStorageValue(value: unknown): unknown {
  if (!isEncodedPluginStorageValue(value)) return value;
  try {
    return JSON.parse(Buffer.from(value.data, "base64").toString("utf8"));
  } catch {
    // A user-owned legacy object can coincidentally resemble the envelope.
    return value;
  }
}

export function decodePluginStorageRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      decodePluginStorageValue(value),
    ]),
  );
}
