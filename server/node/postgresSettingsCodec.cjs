function canUsePostgresText(value) {
    return !value.includes('\0') && Buffer.from(value, 'utf8').toString('utf8') === value;
}

function encodeUtf16(value) {
    return Buffer.from(value, 'utf16le').toString('base64');
}

function decodeUtf16(value) {
    return Buffer.from(value, 'base64').toString('utf16le');
}

function encodeMember(key, position) {
    if (key === null && position === null) {
        return { member_key: null, encoded_member_key: null, position: null };
    }
    if (position !== null) {
        return { member_key: null, encoded_member_key: null, position };
    }
    if (canUsePostgresText(key)) {
        return { member_key: key, encoded_member_key: null, position: null };
    }
    return { member_key: null, encoded_member_key: encodeUtf16(key), position: null };
}

function decodeMember(row) {
    if (row.position !== null && row.position !== undefined) return Number(row.position);
    if (row.member_key !== null && row.member_key !== undefined) return row.member_key;
    return decodeUtf16(row.encoded_member_key);
}

function encodeValueColumns(value) {
    const columns = {
        value_type: 'null',
        text_value: null,
        encoded_text_value: null,
        number_value: null,
        boolean_value: null,
    };
    if (value === null || value === undefined) return columns;
    if (Array.isArray(value)) {
        columns.value_type = 'array';
        return columns;
    }
    if (typeof value === 'object') {
        columns.value_type = 'object';
        return columns;
    }
    if (typeof value === 'string') {
        if (canUsePostgresText(value)) {
            columns.value_type = 'text';
            columns.text_value = value;
        } else {
            columns.value_type = 'encoded-text';
            columns.encoded_text_value = encodeUtf16(value);
        }
        return columns;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        columns.value_type = 'number';
        columns.number_value = value;
        return columns;
    }
    if (typeof value === 'boolean') {
        columns.value_type = 'boolean';
        columns.boolean_value = value;
        return columns;
    }
    throw new TypeError(`Unsupported PostgreSQL setting value: ${typeof value}`);
}

function splitSetting(key, value, options = {}) {
    const maxRows = options.maxRows ?? 250000;
    const maxDepth = options.maxDepth ?? 128;
    const rows = [];
    let nextNodeId = 0;
    const visit = (current, parentNodeId, memberKey, position, depth) => {
        if (depth > maxDepth) {
            throw new RangeError(`PostgreSQL setting ${key} exceeds the ${maxDepth} level limit`);
        }
        if (nextNodeId >= maxRows) {
            throw new RangeError(`PostgreSQL setting ${key} exceeds the ${maxRows} row limit`);
        }
        const nodeId = nextNodeId++;
        rows.push({
            setting_key: key,
            node_id: nodeId,
            parent_node_id: parentNodeId,
            ...encodeMember(memberKey, position),
            ...encodeValueColumns(current),
        });
        if (Array.isArray(current)) {
            for (let index = 0; index < current.length; index++) {
                visit(current[index], nodeId, null, index, depth + 1);
            }
            return;
        }
        if (current && typeof current === 'object') {
            for (const [childKey, childValue] of Object.entries(current)) {
                visit(childValue, nodeId, childKey, null, depth + 1);
            }
        }
    };
    visit(value, null, null, null, 0);
    return {
        setting: { key },
        values: rows,
    };
}

function decodeValue(row) {
    switch (row.value_type) {
        case 'null': return null;
        case 'text': return row.text_value;
        case 'encoded-text': return decodeUtf16(row.encoded_text_value);
        case 'number': return Number(row.number_value);
        case 'boolean': return row.boolean_value;
        case 'object': return {};
        case 'array': return [];
        default: throw new Error(`Unknown PostgreSQL setting value type: ${row.value_type}`);
    }
}

function rebuildSettings(settingRows, valueRows) {
    const rowsBySetting = new Map();
    for (const row of valueRows) {
        const rows = rowsBySetting.get(row.setting_key) || [];
        rows.push(row);
        rowsBySetting.set(row.setting_key, rows);
    }

    const database = {};
    for (const setting of settingRows) {
        const rows = rowsBySetting.get(setting.key) || [];
        rows.sort((left, right) => Number(left.node_id) - Number(right.node_id));
        const valuesById = new Map();
        for (const row of rows) {
            const value = decodeValue(row);
            const nodeId = Number(row.node_id);
            valuesById.set(nodeId, value);
            if (row.parent_node_id === null || row.parent_node_id === undefined) {
                database[setting.key] = value;
                continue;
            }
            const parentNodeId = Number(row.parent_node_id);
            const parent = valuesById.get(parentNodeId);
            if (!parent || typeof parent !== 'object') {
                throw new Error(`Missing PostgreSQL setting parent: ${setting.key}/${parentNodeId}`);
            }
            const member = decodeMember(row);
            if (Array.isArray(parent)) {
                parent[member] = value;
            } else {
                Object.defineProperty(parent, member, {
                    value,
                    configurable: true,
                    enumerable: true,
                    writable: true,
                });
            }
        }
        if (!valuesById.has(0)) {
            throw new Error(`Missing PostgreSQL setting root value: ${setting.key}`);
        }
    }
    return database;
}

function rebuildSettingSubtree(rootNodeId, rows) {
    const sorted = [...rows].sort((a, b) => Number(a.node_id) - Number(b.node_id));
    const valuesById = new Map();
    for (const row of sorted) {
        const value = decodeValue(row);
        const nodeId = Number(row.node_id);
        valuesById.set(nodeId, value);
        if (nodeId === rootNodeId) {
            continue;
        }
        const parentNodeId = Number(row.parent_node_id);
        const parent = valuesById.get(parentNodeId);
        if (!parent || typeof parent !== 'object') {
            continue;
        }
        const member = decodeMember(row);
        if (Array.isArray(parent)) {
            parent[member] = value;
        } else {
            Object.defineProperty(parent, member, {
                value,
                configurable: true,
                enumerable: true,
                writable: true,
            });
        }
    }
    return valuesById.get(rootNodeId);
}

module.exports = {
    canUsePostgresText,
    encodeMember,
    decodeMember,
    rebuildSettings,
    rebuildSettingSubtree,
    splitSetting,
};
