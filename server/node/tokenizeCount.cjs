'use strict';

const SUPPORTED_ENCODINGS = new Set(['cl100k_base', 'o200k_base']);
const encoderCache = new Map();

function getEncoder(encoding) {
    if (!SUPPORTED_ENCODINGS.has(encoding)) {
        throw new TypeError(`Unsupported tokenizer encoding: ${encoding}`);
    }
    let encoder = encoderCache.get(encoding);
    if (!encoder) {
        const { get_encoding } = require('@dqbd/tiktoken');
        encoder = get_encoding(encoding);
        encoderCache.set(encoding, encoder);
    }
    return encoder;
}

function countTokensBatch(texts, encoding) {
    if (!Array.isArray(texts)) {
        throw new TypeError('texts must be an array');
    }
    if (texts.length > 4096) {
        throw new RangeError('A tokenize batch may contain at most 4096 texts');
    }

    let totalChars = 0;
    const normalized = texts.map((text) => {
        if (typeof text !== 'string') throw new TypeError('Every tokenize input must be a string');
        totalChars += text.length;
        return text;
    });
    if (totalChars > 32 * 1024 * 1024) {
        throw new RangeError('A tokenize batch may contain at most 32 MiB of text');
    }

    const encoder = getEncoder(encoding);
    return normalized.map((text) => encoder.encode(text).length);
}

function disposeEncoders() {
    for (const encoder of encoderCache.values()) {
        try {
            encoder.free();
        } catch {}
    }
    encoderCache.clear();
}

module.exports = {
    SUPPORTED_ENCODINGS,
    countTokensBatch,
    disposeEncoders,
};
