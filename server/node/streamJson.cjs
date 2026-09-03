"use strict";

const { Readable } = require("stream");

const DEFAULT_CHUNK_BYTES = 64 * 1024;

function prepareValue(value, key) {
  if (
    value &&
    typeof value === "object" &&
    typeof value.toJSON === "function"
  ) {
    return value.toJSON(key);
  }
  return value;
}

function canSerializeAtomically(value) {
  const entries = Array.isArray(value) ? value : Object.values(value);
  if (entries.length > 32) return false;
  for (const child of entries) {
    if (!child || typeof child !== "object") continue;
    if (Array.isArray(child) && child.length > 32) return false;
    if (!Array.isArray(child) && Object.keys(child).length > 32) return false;
  }
  return true;
}

function* serializeValue(input, key, ancestors) {
  const value = prepareValue(input, key);

  if (value === null) {
    yield "null";
    return;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      yield JSON.stringify(value);
      return;
    case "number":
      yield Number.isFinite(value) ? String(value) : "null";
      return;
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    case "object":
      break;
    default:
      yield undefined;
      return;
  }

  if (ancestors.has(value)) {
    throw new TypeError("Converting circular structure to JSON");
  }
  // Most database rows are small, shallow objects. Let V8 serialize each row
  // in native code while retaining streaming for large collections/graphs.
  if (canSerializeAtomically(value)) {
    yield JSON.stringify(value);
    return;
  }
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      yield "[";
      for (let index = 0; index < value.length;) {
        if (index > 0) yield ",";
        let batchEnd = index;
        while (batchEnd < value.length && batchEnd - index < 128) {
          const candidate = prepareValue(value[batchEnd], String(batchEnd));
          if (
            candidate &&
            typeof candidate === "object" &&
            !canSerializeAtomically(candidate)
          )
            break;
          batchEnd += 1;
        }
        if (batchEnd > index) {
          const encodedBatch = JSON.stringify(value.slice(index, batchEnd));
          yield encodedBatch.slice(1, -1);
          index = batchEnd;
          continue;
        }
        const parts = serializeValue(value[index], String(index), ancestors);
        const first = parts.next();
        if (first.done || first.value === undefined) {
          yield "null";
          index += 1;
          continue;
        }
        yield first.value;
        yield* parts;
        index += 1;
      }
      yield "]";
      return;
    }

    yield "{";
    let wroteProperty = false;
    for (const propertyKey of Object.keys(value)) {
      const parts = serializeValue(value[propertyKey], propertyKey, ancestors);
      const first = parts.next();
      if (first.done || first.value === undefined) continue;
      if (wroteProperty) yield ",";
      wroteProperty = true;
      yield JSON.stringify(propertyKey);
      yield ":";
      yield first.value;
      yield* parts;
    }
    yield "}";
  } finally {
    ancestors.delete(value);
  }
}

function* stringifyJsonChunks(value, chunkBytes = DEFAULT_CHUNK_BYTES) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new TypeError("chunkBytes must be a positive safe integer");
  }

  let buffered = [];
  let bufferedBytes = 0;
  for (const part of serializeValue(value, "", new Set())) {
    if (part === undefined) {
      // JSON.stringify(undefined) returns undefined. Readable.from cannot emit it.
      return;
    }
    const partBytes = Buffer.byteLength(part);
    if (bufferedBytes > 0 && bufferedBytes + partBytes >= chunkBytes) {
      yield buffered.join("");
      buffered = [];
      bufferedBytes = 0;
    }
    if (partBytes >= chunkBytes) {
      yield part;
    } else {
      buffered.push(part);
      bufferedBytes += partBytes;
    }
  }
  if (bufferedBytes > 0) yield buffered.join("");
}

function createJsonStream(value, options = {}) {
  return Readable.from(stringifyJsonChunks(value, options.chunkBytes), {
    objectMode: false,
    encoding: "utf8",
    highWaterMark: options.highWaterMark || DEFAULT_CHUNK_BYTES,
  });
}

module.exports = {
  createJsonStream,
  stringifyJsonChunks,
};
