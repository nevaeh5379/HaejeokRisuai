import { loadTokenizer } from "./runtimeModules.ts";
("use strict");

import { TOKENIZER_ENCODINGS } from "../../../packages/protocol/compute.ts";

const SUPPORTED_ENCODINGS: any = new Set(TOKENIZER_ENCODINGS);
const encoderCache: any = new Map();

async function getEncoder(encoding?: any): Promise<any> {
  if (!SUPPORTED_ENCODINGS.has(encoding)) {
    throw new TypeError(`Unsupported tokenizer encoding: ${encoding}`);
  }
  let encoder: any = encoderCache.get(encoding);
  if (!encoder) {
    const { get_encoding } = await loadTokenizer();
    encoder = encoderCache.get(encoding);
    if (encoder) return encoder;
    encoder = get_encoding(encoding);
    encoderCache.set(encoding, encoder);
  }
  return encoder;
}

async function countTokensBatch(
  texts?: any,
  encoding?: any,
): Promise<number[]> {
  if (!Array.isArray(texts)) {
    throw new TypeError("texts must be an array");
  }
  const count = texts.length;
  if (count > 4096) {
    throw new RangeError("A tokenize batch may contain at most 4096 texts");
  }

  let totalChars = 0;
  for (let i = 0; i < count; i++) {
    const text = texts[i];
    if (typeof text !== "string") {
      throw new TypeError("Every tokenize input must be a string");
    }
    totalChars += text.length;
  }
  if (totalChars > 32 * 1024 * 1024) {
    throw new RangeError("A tokenize batch may contain at most 32 MiB of text");
  }

  const encoder: any = await getEncoder(encoding);
  const result = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    result[i] = encoder.encode(texts[i]).length;
  }
  return result;
}

function disposeEncoders(): any {
  for (const encoder of encoderCache.values()) {
    try {
      encoder.free();
    } catch {}
  }
  encoderCache.clear();
}

export { SUPPORTED_ENCODINGS, countTokensBatch, disposeEncoders };
