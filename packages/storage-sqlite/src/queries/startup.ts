import * as nodeCodec from "../schema/codec";
import type {
  SqliteSelectRowSets,
  SqliteSelectRows,
  SqliteStatement,
} from "../types";

export const SETTING_TEXT_LIMIT = 256 * 1024;

export interface Character {
  id: string;
  kind: "character" | "group";
  name: string;
  image: string;
  trashTime?: number;
  creationDate?: number;
  modificationDate?: number;
  lastInteraction?: number;
}

export interface Projection {
  status: "ready" | "empty";
  revision: number;
  settings: Map<string, unknown>;
  characters: Character[];
  deferredSettingKeys: string[];
}

/**
 * Builds a parameterized query joining setting roots to their relational nodes.
 *
 * 설정 루트와 해당 설정의 관계형 노드를 함께 조회하는 매개변수화 SQL을 생성한다.
 *
 * @remarks
 * This function only builds SQL; the storage adapter executes it. A `LEFT JOIN`
 * preserves roots without nodes so {@link rebuildSettingRows} can restore
 * their scalar values. Excluded keys are filtered with `WHERE`, rather than a
 * join condition, to prevent their root payloads from being returned as well.
 *
 * SQL만 구성하며 실행은 저장소 어댑터가 담당한다. `LEFT JOIN`으로 노드가 없는
 * 설정 루트도 유지하여 {@link rebuildSettingRows}에서 단일 값을 복원한다.
 * 제외할 키는 조인 조건이 아닌 `WHERE`에서 걸러야 설정 루트의 원본 값도
 * 조회 결과에서 빠진다.
 *
 * In shallow mode, oversized node text and object-key columns become `NULL`,
 * and `startup_oversized` marks the setting for deferred loading. The threshold
 * uses SQLite `length()` on stored text, not its byte size. Root text columns
 * from `system_settings` are not bounded by this projection. With shallow mode
 * disabled, node values are returned in full for snapshot exports.
 *
 * 얕은 조회에서는 제한을 초과한 노드 텍스트와 객체 키를 `NULL`로 반환하고,
 * `startup_oversized`로 해당 설정의 지연 로딩 필요 여부를 표시한다.
 * 제한은 바이트 크기가 아니라 저장된 텍스트에 대한 SQLite `length()` 기준이다.
 * `system_settings`의 루트 텍스트 열에는 이 크기 제한이 적용되지 않는다.
 * 얕은 조회를 끄면 스냅샷 내보내기에 필요한 노드 값을 온전히 반환한다.
 *
 * @param deferredKeyList - Setting keys to omit entirely; defaults to none.
 * 이번 조회에서 행 전체를 제외할 설정 키 목록. 기본값은 빈 목록이다.
 * @param shallow - Whether to bound node text using
 * {@link SETTING_TEXT_LIMIT}; defaults to `false`.
 * 노드 텍스트에 {@link SETTING_TEXT_LIMIT} 제한을 적용할지 여부.
 * 기본값은 `false`이다.
 * @returns SQL ordered by setting key and node ID, with excluded keys supplied
 * as positional bind values.
 * 설정 키와 노드 ID 순으로 정렬하는 SQL 및 제외할 키를 담은 위치 기반 바인딩 값.
 */
export function buildSettingRowsQuery(
  deferredKeyList: readonly string[] = [],
  shallow = false,
): SqliteStatement {
  const limit = SETTING_TEXT_LIMIT;
  const project = (column: string) =>
    shallow
      ? `CASE WHEN length(n.${column}) > ${limit} THEN NULL ELSE n.${column} END`
      : `n.${column}`;
  const oversizedMarker = shallow
    ? `CASE WHEN length(n.text_value) > ${limit}
              OR length(n.encoded_text_value) > ${limit}
              OR length(n.object_key) > ${limit}
              OR length(n.object_key_encoded) > ${limit}
         THEN 1 ELSE 0 END AS startup_oversized,`
    : "";
  return {
    sql: `SELECT s.key AS setting_key, s.domain AS setting_domain, s.value_type AS setting_value_type,
            s.text_value AS setting_text_value, s.encoded_text_value AS setting_encoded_text_value,
            s.number_value AS setting_number_value, s.boolean_value AS setting_boolean_value,
            n.node_id, n.parent_node_id, n.node_order,
            ${project("object_key")} AS object_key,
            ${project("object_key_encoded")} AS object_key_encoded,
            n.value_type, ${project("text_value")} AS text_value,
            ${project("encoded_text_value")} AS encoded_text_value,
            n.number_value, n.boolean_value,
            ${oversizedMarker}
            0 AS startup_projection
       FROM system_settings s
       LEFT JOIN setting_extension_nodes n ON n.setting_key = s.key${
         deferredKeyList.length
           ? ` WHERE s.key NOT IN (${deferredKeyList.map(() => "?").join(",")})`
           : ""
       }
       ORDER BY s.key, n.node_id`,
    bind: [...deferredKeyList],
  };
}

/**
 * Reconstructs setting values from joined root and relational-node rows.
 *
 * 설정 루트와 관계형 노드를 조인한 조회 결과에서 원래 설정 값을 복원한다.
 *
 * @remarks
 * Rows are grouped by `setting_key`; rows without a nonempty key are ignored.
 * A setting with nodes is rebuilt through the relational codec. A root without
 * nodes falls back to its scalar columns, including encoded string decoding;
 * unsupported or undefined root types produce `undefined`.
 *
 * 행을 `setting_key`별로 묶으며, 키가 없거나 비어 있는 행은 무시한다.
 * 노드가 있으면 관계형 코덱으로 값을 복원한다. 노드가 없으면 루트의 단일 값
 * 열을 사용하며, 인코딩된 문자열도 디코딩한다. 지원하지 않는 루트 타입이나
 * undefined 타입의 값은 `undefined`로 복원한다.
 *
 * If any row has `startup_oversized = 1`, the entire setting is deferred rather
 * than returning a partially reconstructed value. Explicitly deferred keys
 * remain in `deferredKeys` even when their rows were excluded from the query.
 *
 * 하나라도 `startup_oversized = 1`인 행이 있으면 불완전한 값을 반환하는 대신
 * 해당 설정 전체의 로딩을 미룬다. 명시적으로 지연한 키는 SQL에서 행이 제외되어도
 * `deferredKeys`에 유지된다.
 *
 * @param rows - Rows shaped by {@link buildSettingRowsQuery}.
 * {@link buildSettingRowsQuery}가 생성한 SQL의 조회 결과 행.
 * @param deferredKeyList - Keys to skip during reconstruction and retain for
 * later loading; defaults to none.
 * 복원을 건너뛰고 나중에 로딩하도록 기록할 키 목록. 기본값은 빈 목록이다.
 * @returns Reconstructed `values`, all explicit or detected `deferredKeys`,
 * and `keyCount`, the number of distinct nonempty keys present in the input,
 * including keys whose values were deferred.
 * 복원된 값의 맵 `values`, 명시적으로 지연했거나 크기 초과로 발견한 키의 집합
 * `deferredKeys`, 입력에 존재하는 비어 있지 않은 고유 키의 수 `keyCount`.
 * `keyCount`에는 값 복원을 미룬 키도 포함된다.
 */
export function rebuildSettingRows(
  rows: readonly Record<string, unknown>[],
  deferredKeyList: readonly string[] = [],
): {
  values: Map<string, unknown>;
  keyCount: number;
  deferredKeys: Set<string>;
} {
  const deferredKeys = new Set(deferredKeyList);
  const grouped = new Map<string, Record<string, unknown>[]>();
  const rootRows = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const key = String(row.setting_key ?? "");
    if (!key) continue;
    if (!rootRows.has(key)) rootRows.set(key, row);
    if (Number(row.startup_oversized) === 1) deferredKeys.add(key);
    const nodes = grouped.get(key) ?? [];
    if (row.node_id !== null && row.node_id !== undefined) nodes.push(row);
    grouped.set(key, nodes);
  }
  const values = new Map<string, unknown>();
  for (const [key, nodes] of grouped) {
    if (deferredKeys.has(key)) continue;
    if (nodes.length > 0) {
      values.set(key, nodeCodec.rebuild(nodes));
      continue;
    }
    const root = rootRows.get(key);
    const valueType = root?.setting_value_type ?? root?.value_type;
    switch (valueType) {
      case "string":
        values.set(
          key,
          nodeCodec.decodeText(
            root?.setting_text_value ?? root?.text_value,
            root?.setting_encoded_text_value ?? root?.encoded_text_value,
          ),
        );
        break;
      case "number":
        values.set(
          key,
          Number(root?.setting_number_value ?? root?.number_value),
        );
        break;
      case "boolean":
        values.set(
          key,
          Boolean(root?.setting_boolean_value ?? root?.boolean_value),
        );
        break;
      case "null":
        values.set(key, null);
        break;
      default:
        values.set(key, undefined);
        break;
    }
  }
  return { values, keyCount: grouped.size, deferredKeys };
}

/**
 * Loads shallow settings, character summaries, and initialization metadata.
 *
 * 시작에 필요한 얕은 설정 조회 결과, 캐릭터 요약, 초기화 메타데이터를 불러온다.
 *
 * @remarks
 * The settings query omits both deferred and excluded keys. Oversized node
 * values discovered during reconstruction are added to the deferred list.
 * Excluded keys, such as values owned by other domain stores, appear in neither
 * the returned settings nor the returned deferred list.
 *
 * 설정 조회에서 지연할 키와 제외할 키를 모두 뺀다. 복원 과정에서 크기 초과로
 * 발견한 노드 값의 키는 지연 목록에 추가한다. 다른 도메인 스토어가 소유하는
 * 값처럼 제외 대상으로 지정한 키는 반환할 설정과 지연 목록 어디에도 넣지 않는다.
 *
 * Character rows contain summary fields only; character details, chats, and
 * messages are left for later loading. Status is `ready` when the stored
 * initialization flag is set, any character exists, or any setting key was
 * returned by the query; otherwise it is `empty`.
 *
 * 캐릭터는 요약 필드만 반환하며 상세 정보, 채팅, 메시지는 나중에 로딩한다.
 * 저장된 초기화 플래그가 설정되어 있거나, 캐릭터가 있거나, 설정 조회에서 키를
 * 하나라도 읽었다면 상태는 `ready`이다. 모두 해당하지 않으면 `empty`이다.
 *
 * @param selectRowSets - Adapter that executes the three supplied queries and
 * returns row sets in the same order: settings, characters, then metadata.
 * 세 쿼리를 실행하고 설정, 캐릭터, 메타데이터 순으로 결과 행 집합을 반환하는 어댑터.
 * @param revision - Storage revision supplied by the caller and returned as-is.
 * 호출자가 전달한 저장소 리비전. 조회하지 않고 전달받은 값을 그대로 반환한다.
 * @param deferredSettingKeys - Settings omitted now but eligible for later
 * hydration by the deferred settings loader.
 * 이번에는 조회하지 않고 지연 설정 로더가 나중에 불러올 설정 키 목록.
 * @param excludedSettingKeys - Keys outside startup settings ownership, omitted
 * from both settings and deferred loading.
 * 시작 설정의 소유 범위 밖에 있어 설정과 지연 목록 양쪽에서 제외할 키 목록.
 * @returns Startup status, revision, reconstructed settings, character summaries
 * ordered by position, and keys requiring deferred loading.
 * 시작 상태, 리비전, 복원된 설정, 위치 순으로 정렬된 캐릭터 요약,
 * 지연 로딩이 필요한 설정 키 목록.
 */
export async function loadProjection(
  selectRowSets: SqliteSelectRowSets,
  revision: number,
  deferredSettingKeys: readonly string[],
  excludedSettingKeys: readonly string[],
): Promise<Projection> {
  const excludedKeys = [
    ...new Set([...deferredSettingKeys, ...excludedSettingKeys]),
  ];
  const queries: SqliteStatement[] = [
    buildSettingRowsQuery(excludedKeys, true),
    {
      sql: "SELECT id, position, kind, name, image, trash_time, creation_time, modification_time, last_interaction_time, details_loaded FROM characters ORDER BY position",
      bind: [],
    },
    {
      sql: "SELECT initialized FROM system_storage_meta WHERE singleton = 1",
      bind: [],
    },
  ];
  const [settingRows, characterRows, metaRows] = await selectRowSets(queries);
  const rebuilt = rebuildSettingRows(settingRows, excludedKeys);
  const excluded = new Set(excludedSettingKeys);
  const settings = new Map(
    [...rebuilt.values].filter(([key]) => !excluded.has(key)),
  );
  const characters = characterRows.map((row) => ({
    id: String(row.id ?? ""),
    kind: row.kind === "group" ? ("group" as const) : ("character" as const),
    name: String(row.name ?? ""),
    image: String(row.image ?? ""),
    trashTime: row.trash_time == null ? undefined : Number(row.trash_time),
    creationDate:
      row.creation_time == null ? undefined : Number(row.creation_time),
    modificationDate:
      row.modification_time == null ? undefined : Number(row.modification_time),
    lastInteraction:
      row.last_interaction_time == null
        ? undefined
        : Number(row.last_interaction_time),
  }));
  const initialized =
    Number(metaRows[0]?.initialized) === 1 ||
    characters.length > 0 ||
    rebuilt.keyCount > 0;
  return {
    status: initialized ? "ready" : "empty",
    revision,
    settings,
    characters,
    deferredSettingKeys: [...rebuilt.deferredKeys].filter(
      (key) => !excluded.has(key),
    ),
  };
}

/**
 * Reads storage synchronization metadata and record counts without loading
 * setting values or exporting the aggregate database.
 *
 * 설정 값이나 전체 데이터베이스를 불러오지 않고 저장소 동기화 메타데이터와
 * 레코드 수를 조회한다.
 *
 * @remarks
 * A single query reads the singleton metadata row and counts settings,
 * characters, chats, and messages. `records.total` sums only those four
 * categories; relational nodes and other storage tables are not included.
 * If the metadata row is absent, the result uses the fallback revision,
 * reports an uninitialized database, and returns zero counts.
 *
 * 하나의 쿼리로 단일 메타데이터 행과 설정, 캐릭터, 채팅, 메시지의 행 수를 읽는다.
 * `records.total`은 이 네 종류의 합계이며, 관계형 노드나 다른 저장소 테이블의
 * 행 수는 포함하지 않는다. 메타데이터 행이 없으면 대체 리비전을 사용하고,
 * 초기화되지 않은 상태 및 각 레코드 수 0을 반환한다.
 *
 * @param selectRows - Adapter that executes the metadata and count query.
 * 메타데이터와 레코드 수 조회 쿼리를 실행하는 어댑터.
 * @param fallbackRevision - Revision used when the stored revision cannot be
 * converted to a safe integer, including when the metadata row is absent.
 * 저장된 리비전을 안전한 정수로 변환할 수 없을 때 사용할 대체 리비전.
 * 메타데이터 행이 없는 경우에도 사용한다.
 * @returns Normalized revision and initialization state, the four record
 * counts, and their total.
 * 정규화한 리비전과 초기화 상태, 네 종류의 레코드 수 및 그 합계.
 */
export async function getSyncSummary(
  selectRows: SqliteSelectRows,
  fallbackRevision: number,
) {
  const rows = await selectRows<{
    revision: number;
    initialized: number | boolean;
    settings_count: number;
    characters_count: number;
    chats_count: number;
    messages_count: number;
  }>(`SELECT revision, initialized,
            (SELECT COUNT(*) FROM system_settings) AS settings_count,
            (SELECT COUNT(*) FROM characters) AS characters_count,
            (SELECT COUNT(*) FROM chats) AS chats_count,
            (SELECT COUNT(*) FROM messages) AS messages_count
       FROM system_storage_meta WHERE singleton = 1`);
  const row = rows[0];
  const records = {
    settings: Number(row?.settings_count) || 0,
    characters: Number(row?.characters_count) || 0,
    chats: Number(row?.chats_count) || 0,
    messages: Number(row?.messages_count) || 0,
  };
  return {
    revision: Number.isSafeInteger(Number(row?.revision))
      ? Number(row?.revision)
      : fallbackRevision,
    initialized: row?.initialized === true || Number(row?.initialized) === 1,
    records: {
      ...records,
      total: Object.values(records).reduce((sum, value) => sum + value, 0),
    },
  };
}
