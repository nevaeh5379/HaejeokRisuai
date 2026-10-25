# SQL 레이어 설계 (Azure / Oracle / PostgreSQL 스토리지 방언 통합)

- 날짜: 2026-10-24
- 상태: 승인 대기
- 관련 커밋: `aaba86907` (sync 공용 헬퍼), `d07c40d2a` (read model)

## 1. 왜

`server/node/storage/`에 같은 스키마를 다루는 드라이버가 세 벌 있다.

| 파일 | 줄 수 |
|---|---|
| `azure/azureStorage.ts` | 6,416 |
| `oracle/oracleStorage.ts` | 6,685 |
| `postgres/postgresStorage.ts` | 6,955 |

앞선 두 커밋에서 방언과 무관한 로직(옵션 파싱, 캐시 무효화, 결과 조립, read model 가공)은
공용으로 옮겼다. 남은 중복 5,393줄 중 **3,090줄이 SQL 문장 자체**다.

- `sync()` 2,324줄 (세 본문 1,620 / 1,513 / 1,162줄)
- `exportDatabaseSnapshot()` 428줄
- `migrateLegacyBranchState()` 338줄

측정으로 확인한 사실:

1. `sync()` 안에서 SQL 키워드가 등장하는 줄은 52~70줄뿐이다. 나머지 대부분은
   **컬럼명·타입 문자열 배열**이다(azure 455 / postgres 375 / oracle 215줄 = 본문의 18~28%).
   즉 지금 중복은 "SQL 로직"이 아니라 보일러플레이트다.
2. 세 드라이버에 이미 사실상 같은 저수준 헬퍼가 있다.
   - `bulkInsert(client, table, columns, columnTypes, rows, suffix|mergeKeys|conflictAction)`
   - `prunePositionalChildren` / `deleteMessageChildren`
   - `buildUpsertClause`(pg) ↔ `MERGE`(azure/oracle)
   시그니처만 다르고 의미는 같다.
3. `exportDatabaseSnapshot()`은 세 벤더 모두 **같은 28개 테이블을 같은 순서로**
   `SELECT * ... ORDER BY <key>` 한다. 방언 차이는 인용부호와 스키마 접두어뿐이다.
4. `oracleStorage.ts:852`의 `convertSql()`(정규식으로 `$1`→`:1`, `::type` 제거,
   `LIMIT`→`FETCH FIRST`)은 **호출 지점이 0곳**이다. 중립 SQL을 정규식으로 번역하는
   방식은 이미 시도됐다 버려졌다.

목표는 "SQL 방언 때문에 세 번 쓰는 코드"를 없애는 것이다. 그 결과 `sync()`의 도메인
블록, 스냅샷, 레거시 브랜치 마이그레이션이 **각각 한 번만** 존재하게 된다.

## 2. 목표 / 비목표 / 반목표

**목표**

- 테이블·컬럼·타입·키·정렬을 한 곳에서 정의하고, 세 방언이 그 정의로 SQL을 생성한다.
- `sync()`, `exportDatabaseSnapshot()`, `migrateLegacyBranchState()`의 도메인 로직을
  각각 하나의 구현으로 만든다.
- 드라이버 파일에는 트랜잭션 경계·잠금·방언 어휘 선택만 남긴다.
- 방언 차이(예약어 리네임, 평면 테이블명, CLOB/BLOB 바인딩, `MERGE`/`ON CONFLICT`/
  `OPENJSON`)를 **한 계층에 격리**해서, 새 컬럼 추가가 한 곳에서 끝나게 한다.

**비목표**

- `*.sql` 스키마 파일 3벌(`azure-schema.sql`, `oracle-schema.sql`,
  `postgres-schema.sql`)의 DDL 통합. 별개 프로젝트다.
- 자산 저장소(`assetStorage.ts`, S3/Azure Blob) 경로. SQL과 무관하다.
- 클라이언트 프로토콜·응답 형태 변경.
- 새 런타임 의존성. `pg`/`mssql`/`oracledb` 외에 아무것도 추가하지 않는다.
- `cold.*` 테이블의 저장 표현 변경(현재 azure만 `lore_cache_items` 별도 테이블을 읽는다).

**반목표**

- 스텁 테스트는 통과하는데 실제 Oracle/Azure에서 깨지는 것. (아래 6절의 검증 전략으로
  완화하되, 사용자는 실제 DB 검증 게이트를 만들지 않기로 결정했다 — "위험하게 가자".)
- 저장 표현의 조용한 변경. 예: Oracle `key_value`/`comment_text` 매핑은 그대로 유지한다.
- 테스트를 통과시키기 위해 기존 SQL 텍스트 단언을 느슨하게 만드는 것.

## 3. 제약

- `pnpm check:server`(server/mutation tsc, `check-node-server-types`,
  `check-server-storage-mutations`)와 `vitest run`이 통과해야 한다.
- `server.ts`에서 `postgresStorage`를 직접 쓰는 것은 mutation policy가 막는다. 새
  모듈은 스토리지 계층 내부에만 두고, 공개 표면은 바꾸지 않는다.
- AGENTS.md: TypeScript로 작성, Prettier 포맷, 4GB RAM 환경 고려(대용량 백업 시
  배치 크기 유지 — `BULK_INSERT_BATCH_ROWS`).
- 실제 Azure SQL / Oracle 인스턴스가 없다. 검증은 스텁 클라이언트 + 생성 SQL 단언 +
  실제 DB에서 돌릴 체크리스트로 한다.

## 4. 검토한 방식

**A. 테이블 명세 + 방언 어휘 (채택)**

`sqlTables.ts`에 테이블/컬럼/중립 타입/키/정렬을 정의하고, 방언별 어휘 구현이 그
명세로 SQL을 만든다. 타입 배열과 문장 텍스트가 사라진다. 비용은 방언 어휘 3벌(각
~350줄)이지만, 그 뒤로는 도메인 로직이 한 벌이다.

**B. 방언 어휘만, 명세 없이**

`bulkInsert`류를 공용 인터페이스로 정규화하되 컬럼·타입 배열은 호출부에 남긴다.
이득 절반(문장 중복만 제거), 위험 절반. 타입 배열(측정상 전체의 18~28%)이 그대로
남아 목표를 절반만 달성한다. 탈락.

**C. SQL 텍스트를 벤더별 카탈로그 파일로 이동**

중복이 파일 간에서 파일 내로 옮겨갈 뿐 줄 수가 줄지 않는다. 탈락.

**정규식 SQL 번역 (탈락)**

`convertSql()`의 선례. `MERGE`/`OPENJSON`/`executeMany`/`ON CONFLICT`는 구조가 달라
치환으로 만들 수 없다. 탈락.

## 5. 설계

### 5.1 명세 — `server/node/storage/sqlTables.ts`

중립 타입은 실제 사용된 타입을 전부 덮는 9개로 닫는다(측정: pg 8종, azure 11종).

```ts
export type SqlColumnType =
  | "text"      // pg text,      mssql NVARCHAR(MAX), oracle CLOB
  | "key"       // 짧은 텍스트 id: pg text, mssql NVARCHAR(450), oracle VARCHAR2(4000)
  | "int"       // pg integer,   mssql INT,           oracle NUMBER
  | "bigint"
  | "float"
  | "bool"      // pg boolean,   mssql BIT,           oracle NUMBER(1)
  | "json"      // pg jsonb,     mssql NVARCHAR(MAX), oracle CLOB(+is json)
  | "binary"    // pg bytea,     mssql VARBINARY(MAX),oracle BLOB
  | "timestamp";

export type SqlTableSpec = {
  /** 논리 이름. 예: "chat.messages" */
  name: string;
  /** 쓰기 경로의 컬럼 순서. 이 순서가 바인딩 순서다. */
  columns: readonly (readonly [column: string, type: SqlColumnType])[];
  /** 스냅샷/조회 정렬. exportDatabaseSnapshot이 그대로 쓴다. */
  orderBy: readonly string[];
  /** upsert/merge 키. 없으면 순수 insert. */
  key?: readonly string[];
  /** updated_at을 자동으로 올릴지. */
  touch?: boolean;
};
```

`orderBy`는 3절의 실측(28개 테이블, 세 벤더 동일 순서)에서 그대로 옮긴다.

명세에 담지 않는 것: 제약/FK/인덱스(DDL 소관), LOB 여부(oracle은 중립 타입
`text`/`json`/`binary`에서 유도), 예약어 리네임(oracle 방언 내부 표).

**행 객체 규칙**: `rows`의 키는 **물리 컬럼명**이다. 별칭이 필요한 곳은 호출부가
맞춘다(현재 코드에도 `{ ...row, plugin_id: row.setting_key }`,
oracle의 `module_id AS setting_key` 같은 사례가 있다). `json` 타입 값은 방언이
직렬화한다(pg `jsonb`는 객체 그대로, mssql/oracle은 `JSON.stringify` + CLOB 바인딩).

**조회 규칙**: `selectOrdered`는 현행과 같은 `SELECT * ... ORDER BY <orderBy>`다.
컬럼 목록을 명시하는 최적화는 이 프로젝트 범위 밖(현행 동작 보존).

### 5.2 어휘 — `server/node/storage/sqlDialect.ts`

방언과 무관한 인터페이스. 모든 메서드는 이미 열린 커넥션/트랜잭션에 바인딩된
인스턴스를 통해 호출되므로, **트랜잭션 소유권은 드라이버에 그대로 남는다.**

```ts
export interface SqlDialect {
  /** table 명세로 INSERT. rows는 명세 컬럼명을 키로 갖는다. */
  insertRows(table: string, rows: readonly SqlRow[]): Promise<void>;
  /** 명세의 key 기준 upsert. key가 없으면 insert와 같다. */
  upsertRows(table: string, rows: readonly SqlRow[]): Promise<void>;
  /** (col = value) 튜플 목록으로 삭제. 메시지 자식 테이블 정리에 쓴다. */
  deleteByKeys(
    table: string,
    keyColumns: readonly string[],
    rows: readonly (readonly unknown[])[],
  ): Promise<void>;
  /** position >= length 인 행 삭제(자식 테이블 축약). */
  prunePositions(
    table: string,
    ownerColumn: string,
    specs: readonly { ownerId: string; length: number; subKind?: string }[],
    subKindColumn?: string | null,
  ): Promise<void>;
  /** position = position + amount. 순서 재배치 전에 쓴다. */
  bumpPositions(table: string, amount: number): Promise<void>;
  /** id 목록 순서대로 position을 0..n-1로 설정. */
  setPositions(
    table: string,
    idColumn: string,
    ids: readonly string[],
  ): Promise<void>;
  /** ORDER BY 순서로 전체 조회(스냅샷). */
  selectOrdered(table: string): Promise<SqlRow[]>;
  /** 테이블 행 수(요약 통계). */
  countRows(table: string): Promise<number>;
}
```

방언별 구현이 흡수하는 것:

| 관심사 | postgres | azure (mssql) | oracle |
|---|---|---|---|
| insert | `UNNEST($1::text[], …)` + 배치 | `OPENJSON(@bulkPayload) WITH (…)` | `executeMany` + 컬럼별 bind type |
| upsert | `ON CONFLICT … DO UPDATE … WHERE IS DISTINCT FROM` | `MERGE … USING (OPENJSON)` | `MERGE INTO … USING (SELECT :1 … FROM dual)` |
| 식별자 | `"col"` | `[col]` | `COL`(예약어는 `ORACLE_COLUMN_NAME_MAP`) |
| 테이블명 | `chat.messages` | `[chat].[messages]` | `chat_messages`(`SCHEMA_PREFIX_MAP`) |
| 타입 | pg 타입 문자열 | `sql.NVarChar(450)`/`Int`/`Bit`/`VarBinary(MAX)` | `DB_TYPE_VARCHAR/CLOB/BLOB/NUMBER` + `maxSize` |
| updated_at | `NOW()` | `SYSDATETIMEOFFSET()` | `SYSTIMESTAMP` |
| 중립 타입 → | 5.1 표 | 5.1 표 | 5.1 표 |
| 특수 | — | `sp_set_session_context` (기존 유지) | 빈 문자열 sentinel, `_formatBindValue`, LOB hydrate |

기존 헬퍼(`bulkInsert` 3벌, `prunePositionalChildren`, `deleteMessageChildren`,
`buildUpsertClause`, `_getColumnBindType`, `_bulkInsertRows`)는 방언 구현 **안으로
이동**한다. 새로 쓰지 않고 옮기는 것이 원칙이다(동작 보존).

### 5.3 배선

드라이버는 방언 인스턴스를 만들어 공용 함수에 넘긴다.

```ts
// postgresStorage.ts
const dialect = new PostgresDialect(client);
await this.exportSnapshotWith(dialect);             // 공용
await applySyncPayload(dialect, payload, ctx);      // 공용 (2단계)
```

공용 모듈:

- `sqlSnapshot.ts` — `exportDatabaseSnapshot()` (28테이블 select → `rebuildDatabaseGraph`)
- `sqlBranchMigration.ts` — `migrateLegacyBranchState()`
  (`buildLegacyBranchMigrationPlan`은 이미 공용 `packages/protocol`)
- `sqlSyncDomain.ts` — `sync()`의 도메인 블록: modules / plugins / presets /
  settings·root / characters / chats / messages / deletes + `last_message_time`

### 5.4 단계 (각 단계는 독립 커밋)

- **1단계 — 토대**: `sqlTables.ts`, `sqlDialect.ts`, 방언 구현 3벌,
  방언별 SQL 생성 단언 테스트. 드라이버 동작 변화 없음(아직 아무도 안 씀).
- **2단계 — 스냅샷 + 브랜치 마이그레이션**(A-1): `exportDatabaseSnapshot`과
  `migrateLegacyBranchState`를 공용 구현으로 교체(중복 766줄 제거). 스텁 테스트로
  검증 가능한 범위이고, `sync()`보다 위험이 낮아 토대를 먼저 검증한다.
- **3단계 — sync 도메인 블록**: modules → plugins → presets → settings → characters
  → chats → messages → deletes 순으로 한 블록씩. 블록마다 기존 azure/oracle 스텁
  테스트에 SQL 단언을 추가한 뒤 이전한다.
- **4단계 — 청소**: 드라이버에서 쓰이지 않게 된 지역 헬퍼 삭제, `convertSql()`
  삭제, 남은 타입 배열 제거.

2단계 완료 시점에 3단계를 계속할지 다시 판단한다(diff가 크면 여기서 끊는 것이
안전하다).

## 6. 검증 전략

실제 Azure/Oracle 인스턴스가 없으므로 3중으로 보완한다.

1. **방언 단위 테스트** (`sqlDialect.{postgres,azure,oracle}.test.ts`): 각 방언에
   가짜 커넥션을 물려 `insertRows`/`upsertRows`/`prunePositions` 등이 만드는 SQL과
   바인딩을 단언한다. `azureStorage.test.ts`의 `makeRecordingMssqlMock` 패턴을
   그대로 쓴다. DB 없이 방언 정확성을 고정한다.
2. **명세 정합성 테스트**: `sqlTables.ts`의 각 테이블에 대해 세 방언이 만든 SQL에
   같은 컬럼 집합이 등장하는지 확인한다. 명세 드리프트를 잡는다.
3. **실제 DB 체크리스트**: `docs/superpowers/specs/` 옆에 수동 절차를 남긴다 —
   docker `mcr.microsoft.com/mssql/server`와 `gvenzl/oracle-free`로
   `pnpm dev:node` 기동 → 백업 export/import → `sync` 왕복. 사용자가 나중에 돌린다.

기존 스텁 테스트의 SQL 텍스트 단언은 **강하게 유지**한다(느슨하게 만들지 않는다).
문장이 바뀌면 단언도 바뀌어야 하고, 그게 회귀 신호다.

## 7. 위험

| 위험 | 완화 |
|---|---|
| Oracle 예약어/평면 테이블명 매핑 누락 → 런타임 SQL 오류 | 명세는 논리 이름만 갖고, 매핑은 방언 내부 표 하나로 유지. 실제 스키마와 대조하는 단언 테스트 |
| `executeMany` bind type 오판(CLOB/BLOB/NUMBER) | 중립 타입 → oracle 타입 유도 규칙을 방언에 명시 + 단위 테스트 |
| 대용량 백업 메모리(4GB 기기) | 기존 `BULK_INSERT_BATCH_ROWS`/`MAX_SYNC_ROWS` 배치 유지, 스냅샷은 여전히 스트리밍 없음(현행과 동일) |
| 스냅샷 SELECT \* 가 벤더별로 다른 컬럼을 반환(예: azure `*_lore_cache_items`) | 명세는 28개 공통 테이블만. cold/cache 확장은 범위 밖 |
| 실제 DB 미검증 | 6절 3중 전략 + 단계별 커밋으로 되돌리기 쉽게 |

## 8. 빌더에게 남기는 것

- `sqlTables.ts`의 컬럼 순서·타입을 각 드라이버의 현재 배열에서 그대로 옮길 때,
  세 벤더 배열이 서로 어긋나는 지점(있다면)을 먼저 목록화하고 임의로 통일하지 말 것.
  어긋남은 버그 신호이므로 사용자에게 보고한다.
- `setPositions`의 배치 구현(행 수가 많을 때 `executeMany` vs 개별 UPDATE)은
  방언 재량. 동작(최종 position 값)만 같으면 된다.
- 3단계에서 블록 단위로 커밋하고, 각 커밋은 "동작 변화 없음"을 전제로 한다.
  동작이 바뀌는 지점을 발견하면 커밋 메시지에 명시한다.
- `sync()`의 트랜잭션 시작·잠금(`FOR UPDATE` / `WITH (UPDLOCK, HOLDLOCK)` /
  `SET CONSTRAINTS ALL DEFERRED`)과 진행률 콜백은 방언/드라이버에 남긴다. 공용
  함수는 이미 열린 트랜잭션 안에서만 동작한다고 가정한다.

## 9. 빌더 재량으로 남긴 결정

- `SqlRow` 타입의 위치(`relationalRows.ts`의 `SqlStorageRow` 재사용 vs 새 별칭).
- 방언 파일의 배치: `storage/dialect/{postgres,azure,oracle}Dialect.ts` vs
  기존 `storage/<vendor>/` 안. 기존 디렉터리 규칙(벤더별 폴더)을 따른다.
- `selectOrdered`가 `SELECT *`로 받은 행을 그대로 돌려줄지, 명세 컬럼만 추릴지.
  (후자는 스냅샷 응답이 달라질 수 있어 1단계에서는 전자)
- 배치 크기 상수의 위치: 현재는 드라이버별 지역 상수(`BULK_INSERT_BATCH_ROWS`).
  방언으로 옮기되 값은 유지한다.
