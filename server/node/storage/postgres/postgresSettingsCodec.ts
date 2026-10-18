function canUsePostgresText(value?: any): any {
  return (
    !value.includes("\0") &&
    Buffer.from(value, "utf8").toString("utf8") === value
  );
}

function encodeUtf16(value?: any): any {
  return Buffer.from(value, "utf16le").toString("base64");
}

function decodeUtf16(value?: any): any {
  return Buffer.from(value, "base64").toString("utf16le");
}

function encodeMember(key?: any, position?: any): any {
  if (key === null && position === null) {
    return { member_key: null, encoded_member_key: null, position: null };
  }
  if (position !== null) {
    return { member_key: null, encoded_member_key: null, position };
  }
  if (canUsePostgresText(key)) {
    return { member_key: key, encoded_member_key: null, position: null };
  }
  return {
    member_key: null,
    encoded_member_key: encodeUtf16(key),
    position: null,
  };
}

function decodeMember(row?: any): any {
  if (row.position !== null && row.position !== undefined)
    return Number(row.position);
  if (row.member_key !== null && row.member_key !== undefined)
    return row.member_key;
  return decodeUtf16(row.encoded_member_key);
}

function encodeValueColumns(value?: any): any {
  const columns: any = {
    value_type: "null",
    text_value: null,
    encoded_text_value: null,
    number_value: null,
    boolean_value: null,
  };
  if (value === null || value === undefined) return columns;
  if (Array.isArray(value)) {
    columns.value_type = "array";
    return columns;
  }
  if (typeof value === "object") {
    columns.value_type = "object";
    return columns;
  }
  if (typeof value === "string") {
    if (canUsePostgresText(value)) {
      columns.value_type = "text";
      columns.text_value = value;
    } else {
      columns.value_type = "encoded-text";
      columns.encoded_text_value = encodeUtf16(value);
    }
    return columns;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    columns.value_type = "number";
    columns.number_value = value;
    return columns;
  }
  if (typeof value === "boolean") {
    columns.value_type = "boolean";
    columns.boolean_value = value;
    return columns;
  }
  throw new TypeError(`Unsupported PostgreSQL setting value: ${typeof value}`);
}

function splitSetting(key?: any, value?: any, options: any = {}): any {
  const maxRows: any = options.maxRows ?? 250000;
  const maxDepth: any = options.maxDepth ?? 128;
  const rows: any = [];
  let nextNodeId: any = 0;
  const visit: any = (
    current?: any,
    parentNodeId?: any,
    memberKey?: any,
    position?: any,
    depth?: any,
  ) => {
    if (depth > maxDepth) {
      throw new RangeError(
        `PostgreSQL setting ${key} exceeds the ${maxDepth} level limit`,
      );
    }
    if (nextNodeId >= maxRows) {
      throw new RangeError(
        `PostgreSQL setting ${key} exceeds the ${maxRows} row limit`,
      );
    }
    const nodeId: any = nextNodeId++;
    rows.push({
      setting_key: key,
      node_id: nodeId,
      parent_node_id: parentNodeId,
      ...encodeMember(memberKey, position),
      ...encodeValueColumns(current),
    });
    if (Array.isArray(current)) {
      for (let index: any = 0; index < current.length; index++) {
        visit(current[index], nodeId, null, index, depth + 1);
      }
      return;
    }
    if (current && typeof current === "object") {
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

function decodeValue(row?: any): any {
  switch (row.value_type) {
    case "null":
      return null;
    case "text":
      return row.text_value;
    case "encoded-text":
      return decodeUtf16(row.encoded_text_value);
    case "number":
      return Number(row.number_value);
    case "boolean":
      return row.boolean_value;
    case "object":
      return {};
    case "array":
      return [];
    default:
      throw new Error(
        `Unknown PostgreSQL setting value type: ${row.value_type}`,
      );
  }
}

function rebuildSettings(settingRows?: any, valueRows?: any): any {
  const rowsBySetting: any = new Map();
  for (const row of valueRows) {
    const rows: any = rowsBySetting.get(row.setting_key) || [];
    rows.push(row);
    rowsBySetting.set(row.setting_key, rows);
  }

  const database: any = {};
  for (const setting of settingRows) {
    const rows: any = rowsBySetting.get(setting.key) || [];
    rows.sort(
      (left?: any, right?: any) => Number(left.node_id) - Number(right.node_id),
    );
    const valuesById: any = new Map();
    for (const row of rows) {
      const value: any = decodeValue(row);
      const nodeId: any = Number(row.node_id);
      valuesById.set(nodeId, value);
      if (row.parent_node_id === null || row.parent_node_id === undefined) {
        database[setting.key] = value;
        continue;
      }
      const parentNodeId: any = Number(row.parent_node_id);
      const parent: any = valuesById.get(parentNodeId);
      if (!parent || typeof parent !== "object") {
        throw new Error(
          `Missing PostgreSQL setting parent: ${setting.key}/${parentNodeId}`,
        );
      }
      const member: any = decodeMember(row);
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

function rebuildSettingSubtree(rootNodeId?: any, rows?: any): any {
  const sorted: any = [...rows].sort(
    (a?: any, b?: any) => Number(a.node_id) - Number(b.node_id),
  );
  const valuesById: any = new Map();
  for (const row of sorted) {
    const value: any = decodeValue(row);
    const nodeId: any = Number(row.node_id);
    valuesById.set(nodeId, value);
    if (nodeId === rootNodeId) {
      continue;
    }
    const parentNodeId: any = Number(row.parent_node_id);
    const parent: any = valuesById.get(parentNodeId);
    if (!parent || typeof parent !== "object") {
      continue;
    }
    const member: any = decodeMember(row);
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

export {
  canUsePostgresText,
  encodeMember,
  decodeMember,
  rebuildSettings,
  rebuildSettingSubtree,
  splitSetting,
};
