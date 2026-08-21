const POSTGRES_TEXT_TAG = '__risu_pg_text_utf16le_v1_8e81b0b9__';
const POSTGRES_OBJECT_ENTRIES_TAG = '__risu_pg_object_entries_v1_8e81b0b9__';

function defineJsonProperty(target, key, value) {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
    });
}

function mapJsonArrayCopyOnWrite(values, mapper) {
    let mapped = null;
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

function encodePostgresJsonValue(value) {
    if (typeof value === 'string') {
        if (!value.includes('\0')) {
            return value;
        }
        return {
            [POSTGRES_TEXT_TAG]: Buffer.from(value, 'utf16le').toString('base64'),
        };
    }
    if (Array.isArray(value)) {
        return mapJsonArrayCopyOnWrite(value, encodePostgresJsonValue);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const entries = Object.entries(value);
    const requiresEntriesWrapper = entries.some(([key]) =>
        key.includes('\0') || key === POSTGRES_TEXT_TAG || key === POSTGRES_OBJECT_ENTRIES_TAG
    );
    if (requiresEntriesWrapper) {
        return {
            [POSTGRES_OBJECT_ENTRIES_TAG]: entries.map(([key, item]) => [
                encodePostgresJsonValue(key),
                encodePostgresJsonValue(item),
            ]),
        };
    }

    let encoded = null;
    for (let index = 0; index < entries.length; index++) {
        const [key, item] = entries[index];
        const next = encodePostgresJsonValue(item);
        if (next !== item && encoded === null) {
            encoded = {};
            for (let previous = 0; previous < index; previous++) {
                defineJsonProperty(encoded, entries[previous][0], entries[previous][1]);
            }
        }
        if (encoded !== null) {
            defineJsonProperty(encoded, key, next);
        }
    }
    return encoded || value;
}

function decodePostgresTextWrapper(value) {
    if (Object.keys(value).length !== 1 ||
        !Object.prototype.hasOwnProperty.call(value, POSTGRES_TEXT_TAG) ||
        typeof value[POSTGRES_TEXT_TAG] !== 'string') {
        return null;
    }
    const encoded = value[POSTGRES_TEXT_TAG];
    const buffer = Buffer.from(encoded, 'base64');
    if (buffer.length % 2 !== 0 || buffer.toString('base64') !== encoded) {
        return null;
    }
    const decoded = buffer.toString('utf16le');
    return decoded.includes('\0') ? decoded : null;
}

function decodePostgresJsonValue(value) {
    if (Array.isArray(value)) {
        return mapJsonArrayCopyOnWrite(value, decodePostgresJsonValue);
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const decodedText = decodePostgresTextWrapper(value);
    if (decodedText !== null) {
        return decodedText;
    }

    if (Object.keys(value).length === 1 &&
        Object.prototype.hasOwnProperty.call(value, POSTGRES_OBJECT_ENTRIES_TAG) &&
        Array.isArray(value[POSTGRES_OBJECT_ENTRIES_TAG])) {
        const decodedObject = {};
        for (const entry of value[POSTGRES_OBJECT_ENTRIES_TAG]) {
            if (!Array.isArray(entry) || entry.length !== 2) {
                return decodePostgresJsonObject(value);
            }
            const key = decodePostgresJsonValue(entry[0]);
            if (typeof key !== 'string') {
                return decodePostgresJsonObject(value);
            }
            defineJsonProperty(decodedObject, key, decodePostgresJsonValue(entry[1]));
        }
        return decodedObject;
    }
    return decodePostgresJsonObject(value);
}

function decodePostgresJsonObject(value) {
    const entries = Object.entries(value);
    let decoded = null;
    for (let index = 0; index < entries.length; index++) {
        const [key, item] = entries[index];
        const next = decodePostgresJsonValue(item);
        if (next !== item && decoded === null) {
            decoded = {};
            for (let previous = 0; previous < index; previous++) {
                defineJsonProperty(decoded, entries[previous][0], entries[previous][1]);
            }
        }
        if (decoded !== null) {
            defineJsonProperty(decoded, key, next);
        }
    }
    return decoded || value;
}

function canUsePostgresText(value) {
    return typeof value === 'string' && !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value;
}

module.exports = {
    canUsePostgresText,
    decodePostgresJsonValue,
    encodePostgresJsonValue,
};
