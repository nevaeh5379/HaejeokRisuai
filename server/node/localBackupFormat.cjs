'use strict';

const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { Packr, Unpackr } = require('msgpackr');

const RAW_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7]);
const COMPRESSED_HEADER = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 8]);
const packr = new Packr({ useRecords: false });
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false });

function createEntryHeader(name, size) {
    const normalizedName = path.basename(name);
    const encodedName = Buffer.from(normalizedName, 'utf8');
    if (encodedName.length === 0 || encodedName.length > 1024 * 1024) {
        throw new Error(`Invalid local backup entry name: ${name}`);
    }
    if (!Number.isSafeInteger(size) || size < 0 || size > 0xffffffff) {
        throw new Error(`Local backup entry is too large: ${name}`);
    }
    const header = Buffer.alloc(8 + encodedName.length);
    header.writeUInt32LE(encodedName.length, 0);
    encodedName.copy(header, 4);
    header.writeUInt32LE(size, 4 + encodedName.length);
    return header;
}

async function encodeDatabase(database) {
    const packed = packr.encode(database);
    const compressed = await promisify(zlib.deflate)(packed);
    return Buffer.concat([COMPRESSED_HEADER, compressed]);
}

function decodeDatabase(data) {
    if (data.subarray(0, COMPRESSED_HEADER.length).equals(COMPRESSED_HEADER)) {
        return unpackr.decode(zlib.inflateSync(data.subarray(COMPRESSED_HEADER.length)));
    }
    if (data.subarray(0, RAW_HEADER.length).equals(RAW_HEADER)) {
        return unpackr.decode(data.subarray(RAW_HEADER.length));
    }
    return unpackr.decode(data);
}

module.exports = { createEntryHeader, encodeDatabase, decodeDatabase };
