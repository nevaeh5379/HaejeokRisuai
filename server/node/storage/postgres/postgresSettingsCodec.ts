// Flattens one setting value into `system.settings` plus `system.setting_values`
// rows, and rebuilds the value from those rows. The row shapes are the shared
// ones in `../relationalRows.ts`, so every vendor driver reads and writes the
// same columns through this codec.

import type {
  SettingScalarRow,
  SettingValueKeyColumns,
  SettingValueRow,
  SettingValueType,
} from "../relationalRows.ts";
import { canUsePostgresText } from "./postgresJsonCodec.ts";

/** Member columns of one `system.setting_values` row. */
type SettingMemberColumns = Pick<
  SettingValueKeyColumns,
  "member_key" | "encoded_member_key" | "position"
>;

/**
 * Value that each stored kind decodes to. `array` and `object` decode to the
 * empty seed that the child rows of the same setting then fill in.
 * `array`/`object`는 같은 설정의 자식 행이 채워 넣을 빈 시작값으로 디코딩합니다.
 */
type SettingDecodedValues = {
  null: null;
  text: string;
  "encoded-text": string;
  number: number;
  boolean: boolean;
  array: unknown[];
  object: Record<string, unknown>;
};

/** Value of any stored kind, used where the row is not narrowed. */
type SettingDecodedValue = SettingDecodedValues[SettingValueType];

/** Key-only `system.settings` row; the value itself lives in the value rows. */
type SettingKeyRow = Pick<SettingScalarRow, "key">;

/** Rows produced by `splitSetting`: the root row and every value node. */
type SettingSplit = { setting: SettingKeyRow; values: SettingValueRow[] };

/** Row and depth limits of the `splitSetting` walk. */
type SplitSettingOptions = { maxRows?: number; maxDepth?: number };

/** Place of a value inside its parent: an object key or an array index. */
type SettingMember = string | number;

function encodeUtf16(value: string): string {
  return Buffer.from(value, "utf16le").toString("base64");
}

function decodeUtf16(value: string): string {
  return Buffer.from(value, "base64").toString("utf16le");
}

function encodeMember(
  key: string | null,
  position: number | null,
): SettingMemberColumns {
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

function decodeMember(row: SettingValueRow): SettingMember {
  if (row.position !== null && row.position !== undefined)
    return Number(row.position);
  if (row.member_key !== null && row.member_key !== undefined)
    return row.member_key;
  return decodeUtf16(row.encoded_member_key);
}

/** Columns that carry no payload, spread into every value row. */
const UNSET_VALUE_COLUMNS = {
  text_value: null,
  encoded_text_value: null,
  number_value: null,
  boolean_value: null,
} as const;

/**
 * One value row for the given locating columns. The value's runtime type
 * selects the row kind, and only that kind's own column is populated.
 */
function encodeValueRow(
  columns: SettingValueKeyColumns,
  value: unknown,
): SettingValueRow {
  if (value === null || value === undefined) {
    return { ...columns, value_type: "null", ...UNSET_VALUE_COLUMNS };
  }
  if (Array.isArray(value)) {
    return { ...columns, value_type: "array", ...UNSET_VALUE_COLUMNS };
  }
  if (typeof value === "object") {
    return { ...columns, value_type: "object", ...UNSET_VALUE_COLUMNS };
  }
  if (typeof value === "string") {
    if (canUsePostgresText(value)) {
      return {
        ...columns,
        value_type: "text",
        ...UNSET_VALUE_COLUMNS,
        text_value: value,
      };
    }
    return {
      ...columns,
      value_type: "encoded-text",
      ...UNSET_VALUE_COLUMNS,
      encoded_text_value: encodeUtf16(value),
    };
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return {
      ...columns,
      value_type: "number",
      ...UNSET_VALUE_COLUMNS,
      number_value: value,
    };
  }
  if (typeof value === "boolean") {
    return {
      ...columns,
      value_type: "boolean",
      ...UNSET_VALUE_COLUMNS,
      boolean_value: value,
    };
  }
  throw new TypeError(`Unsupported PostgreSQL setting value: ${typeof value}`);
}

function splitSetting(
  key: string,
  value: unknown,
  options: SplitSettingOptions = {},
): SettingSplit {
  const maxRows = options.maxRows ?? 250000;
  const maxDepth = options.maxDepth ?? 128;
  const rows: SettingValueRow[] = [];
  let nextNodeId = 0;
  const visit = (
    current: unknown,
    parentNodeId: number | null,
    memberKey: string | null,
    position: number | null,
    depth: number,
  ): void => {
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
    const nodeId = nextNodeId++;
    rows.push(
      encodeValueRow(
        {
          setting_key: key,
          node_id: nodeId,
          parent_node_id: parentNodeId,
          ...encodeMember(memberKey, position),
        },
        current,
      ),
    );
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        visit(current[index], nodeId, null, index, depth + 1);
      }
      return;
    }
    if (current && typeof current === "object") {
      const record = current as Record<string, unknown>;
      const currentKeys = Object.keys(record);
      for (let i = 0; i < currentKeys.length; i++) {
        const childKey = currentKeys[i];
        visit(record[childKey], nodeId, childKey, null, depth + 1);
      }
    }
  };
  visit(value, null, null, null, 0);
  return {
    setting: { key },
    values: rows,
  };
}

/**
 * Decodes one value row. The row kind decides the result type, so a caller
 * that has narrowed `value_type` gets that kind's value without a cast.
 * 행의 kind가 결과 타입을 정하므로, 호출부가 `value_type`를 좁혔으면
 * 캐스트 없이 해당 kind의 값을 받습니다.
 */
function decodeValue<TRow extends SettingValueRow>(
  row: TRow,
): SettingDecodedValues[TRow["value_type"]] {
  return decodeValueByKind(row) as SettingDecodedValues[TRow["value_type"]];
}

function decodeValueByKind(row: SettingValueRow): SettingDecodedValue {
  // Read through the alias: a legacy row can carry a kind this codec never wrote.
  const kind = row.value_type;
  switch (kind) {
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
      throw new Error(`Unknown PostgreSQL setting value type: ${kind}`);
  }
}

/** Attaches one child value to the parent value its row points at. */
function attachToParent(
  parent: unknown,
  member: SettingMember,
  value: SettingDecodedValue,
): void {
  if (Array.isArray(parent)) {
    (parent as unknown as Record<SettingMember, unknown>)[member] = value;
  } else {
    Object.defineProperty(parent, member, {
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
  }
}

function rebuildSettings(
  settingRows: readonly SettingKeyRow[],
  valueRows: readonly SettingValueRow[],
): Record<string, unknown> {
  const rowsBySetting: Map<string, SettingValueRow[]> = new Map();
  for (const row of valueRows) {
    let rows = rowsBySetting.get(row.setting_key);
    if (!rows) {
      rows = [];
      rowsBySetting.set(row.setting_key, rows);
    }
    rows.push(row);
  }

  const database: Record<string, unknown> = {};
  for (const setting of settingRows) {
    const rows = rowsBySetting.get(setting.key) || [];
    rows.sort((left, right) => Number(left.node_id) - Number(right.node_id));
    const valuesById: Map<number, SettingDecodedValue> = new Map();
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
      if (!parent || typeof parent !== "object") {
        throw new Error(
          `Missing PostgreSQL setting parent: ${setting.key}/${parentNodeId}`,
        );
      }
      attachToParent(parent, decodeMember(row), value);
    }
    if (!valuesById.has(0)) {
      throw new Error(`Missing PostgreSQL setting root value: ${setting.key}`);
    }
  }
  return database;
}

function rebuildSettingSubtree(
  rootNodeId: number,
  rows: readonly SettingValueRow[],
): SettingDecodedValue | undefined {
  const sorted = [...rows].sort(
    (a, b) => Number(a.node_id) - Number(b.node_id),
  );
  const valuesById: Map<number, SettingDecodedValue> = new Map();
  for (const row of sorted) {
    const value = decodeValue(row);
    const nodeId = Number(row.node_id);
    valuesById.set(nodeId, value);
    if (nodeId === rootNodeId) {
      continue;
    }
    const parentNodeId = Number(row.parent_node_id);
    const parent = valuesById.get(parentNodeId);
    if (!parent || typeof parent !== "object") {
      continue;
    }
    attachToParent(parent, decodeMember(row), value);
  }
  return valuesById.get(rootNodeId);
}

export {
  encodeMember,
  decodeMember,
  rebuildSettings,
  rebuildSettingSubtree,
  splitSetting,
};
