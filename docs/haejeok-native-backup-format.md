# Haejeok RisuAI Native Backup Format Specification

## 1. 문서 상태

이 문서는 Haejeok RisuAI가 생성하는 네이티브 로컬 백업 파일의 형식을 정의한다.

- 사용자 파일 확장자: `.bin` 또는 `.risubackup`(확장자는 형식 식별자가 아님)
- 현재 스트리밍 데이터베이스 형식 버전: `1`
- 대상 구현: Web, Tauri, Android/Capacitor, Node 서버
- 기준 구현:
  - 컨테이너 쓰기: `src/ts/globalApi.svelte.ts`, `server/node/localBackupFormat.cjs`
  - 백업 생성·복원: `src/ts/drive/backuplocal.ts`
  - 데이터베이스 스트림: `src/ts/storage/backup/portableDatabaseStream.ts`
  - 스트리밍 DB 암호화: `src/ts/drive/streamingBackupEncryption.ts`
  - 엔트리 분류: `packages/backup-core/entryPolicy.cjs`

이 문서에서 **MUST**, **MUST NOT**, **SHOULD**, **MAY**는 각각 필수, 금지, 권장, 선택 사항을 뜻한다.

## 2. 목표와 비목표

네이티브 형식의 주 목표는 전체 데이터베이스 스냅샷을 메모리에 구성하지 않고도 대규모 백업을 순차적으로 생성하는 것이다. 데이터베이스 레코드, 에셋, 냉동 데이터, 인레이는 가능한 한 작은 작업 단위로 읽고 즉시 출력 컨테이너에 기록한다.

다음은 이 형식의 비목표다.

- ZIP, TAR 또는 다른 범용 아카이브 프로그램과의 호환성
- 파일 전체에 대한 암호학적 서명 또는 체크섬
- 구버전 RisuAI가 네이티브 스트리밍 형식을 직접 읽도록 하는 것
- 복원 과정 전체의 메모리 사용량을 이 문서만으로 규정하는 것

## 3. 용어

- **컨테이너**: 하나의 `.bin` 또는 `.risubackup` 백업 파일 전체
- **엔트리**: 컨테이너 안의 이름과 바이트 페이로드 한 쌍
- **DB 조각(fragment)**: 최대 32개의 데이터베이스 레코드를 담는 `database.stream/*.risudat` 엔트리
- **매니페스트(manifest)**: 모든 DB 조각의 개수와 레코드 개수를 확정하는 마지막 엔트리
- **네이티브 백업**: Haejeok RisuAI 기능과 브랜치 그래프를 보존하는 기본 백업
- **호환 백업**: 구버전 읽기 호환성을 위해 단일 `database.risudat`을 사용하는 백업

## 4. 컨테이너 프레이밍

컨테이너에는 별도의 파일 전체 매직 헤더가 없다. 파일은 다음 엔트리 프레임이 EOF까지 반복되는 구조다.

```text
+----------------------+----------------------------------+
| 필드                 | 인코딩                           |
+----------------------+----------------------------------+
| name_length          | uint32 little-endian             |
| name                 | name_length 바이트의 UTF-8       |
| data_length          | uint32 little-endian             |
| data                 | data_length 바이트의 불투명 값   |
+----------------------+----------------------------------+
```

수식으로 표현하면 다음과 같다.

```text
container = entry * EOF
entry     = u32le(name.length) || utf8(name) || u32le(data.length) || data
```

작성자는 다음 조건을 지켜야 한다.

- `name_length`는 `1..1048576` 범위여야 한다.
- `data_length`는 `0..4294967295` 범위여야 한다.
- 엔트리는 선언한 `data_length`만큼 정확히 기록되어야 한다.
- 파일은 엔트리 경계에서 끝나야 한다.

읽는 쪽은 길이가 남은 파일 크기를 초과하거나 엔트리 중간에서 EOF에 도달하면 컨테이너를 손상된 것으로 거절해야 한다.

## 5. 엔트리 이름

엔트리 이름은 논리적인 경로이며 실제 ZIP 디렉터리가 아니다. 작성 시 역슬래시(`\`)는 슬래시(`/`)로 정규화한다.

이름을 `/`로 나눈 모든 세그먼트는 다음 조건을 만족해야 한다.

- 비어 있지 않아야 한다.
- `.` 또는 `..`이면 안 된다.

새 작성자는 에셋을 반드시 `assets/` 아래에 기록해야 한다. 읽는 쪽은 과거 백업 호환을 위해 슬래시가 없는 알 수 없는 최상위 이름을 레거시 에셋으로 취급할 수 있다.

알 수 없는 중첩 이름은 확장 엔트리로 간주한다. 현재 읽는 쪽은 안전하게 건너뛰므로, 이후 형식은 기존 엔트리와 충돌하지 않는 별도 네임스페이스를 추가할 수 있다.

## 6. 표준 엔트리

| 이름                                   | 페이로드                     | 필수 여부                      |
| -------------------------------------- | ---------------------------- | ------------------------------ |
| `database.stream/NNNNNNNNNNNN.risudat` | 압축된 DB 조각               | 네이티브 v1에서 1개 이상       |
| `database.stream/manifest.risudat`     | 압축된 DB 매니페스트         | 네이티브 v1에서 필수           |
| `database.risudat`                     | 집계형 DB 객체               | 레거시 또는 호환 백업에서 필수 |
| `encryption.risudat`                   | UTF-8 JSON 암호화 메타데이터 | 계정 암호화 백업에서만         |
| `assets/<path>`                        | 원본 에셋 바이트             | 선택                           |
| `coldstorage_<uuid>.json`              | UTF-8 JSON                   | 선택                           |
| `coldstorage/<uuid>.json`              | UTF-8 JSON, 레거시 이름      | 읽기 호환용                    |
| `inlay_<uuid>.risuinlay`               | 인레이 바이너리              | 전체 네이티브 백업에서 선택    |

`NNNNNNNNNNNN`은 1부터 시작하는 12자리 10진수 조각 번호다. 예를 들어 첫 조각은 `database.stream/000000000001.risudat`이다.

작성자는 `database.risudat`과 `database.stream/*`을 같은 백업에 섞어서는 안 된다. 읽는 쪽도 두 형식이 함께 있으면 거절해야 한다.

전체 네이티브 백업의 논리적인 예시는 다음과 같다. 이 목록은 디렉터리 트리가 아니라 순차 엔트리 이름을 보기 좋게 표현한 것이다.

```text
database.stream/000000000001.risudat
database.stream/000000000002.risudat
coldstorage_550e8400-e29b-41d4-a716-446655440000.json
assets/characters/example.webp
inlay_550e8400-e29b-41d4-a716-446655440001.risuinlay
database.stream/manifest.risudat
```

계정 암호화를 사용하는 경우 `encryption.risudat`이 첫 암호화 DB 엔트리보다 앞에 추가된다.

## 7. RisuSave 압축 페이로드

DB 조각과 매니페스트는 다음 바이트 형식을 사용한다.

```text
00 52 49 53 55 53 41 56 45 00 08 || zlib(messagepack(value))
```

앞의 11바이트는 `NUL + "RISUSAVE" + NUL + 0x08`이다. MessagePack 인코더는 레코드 확장에 의존하지 않는 일반 객체 형식을 사용해야 한다.

## 8. DB 조각 스키마

각 조각을 디코딩한 값은 다음 객체여야 한다.

```ts
interface PortableDatabaseStreamFragmentV1 {
  format: "risu-portable-database-fragment";
  version: 1;
  index: number;
  records: PortableDatabaseRecordV1[];
}
```

제약 조건은 다음과 같다.

- `index`는 1 이상의 안전한 정수여야 한다.
- 인덱스는 중복 없이 `1..manifest.totalFragments`를 모두 채워야 한다.
- `records`는 1개 이상 32개 이하여야 한다.
- 조각 번호와 레코드는 생성 순서를 유지해야 한다.

### 8.1 레코드 종류

`data`와 `value`는 해당 데이터베이스 도메인의 MessagePack 값이며, 아래에 명시되지 않은 내부 필드는 불투명 값으로 취급한다.

```ts
type PortableDatabaseRecordV1 =
  | { type: "meta"; formatVersion: 1; revision: number }
  | { type: "setting"; key: string; value: unknown }
  | { type: "plugin-storage"; key: string; value: unknown }
  | { type: "module"; position: number; id: string; data: unknown }
  | { type: "preset"; position: number; id: string; data: unknown }
  | { type: "character"; position: number; id: string; data: unknown }
  | {
      type: "chat";
      characterId: string;
      position: number;
      id: string;
      data: unknown;
    }
  | { type: "branch"; chatId: string; data: unknown }
  | { type: "active-branch"; chatId: string; branchId: string }
  | {
      type: "message";
      chatId: string;
      id: string;
      position: number;
      parentMessageId?: string;
      originBranchId: string;
      data: unknown;
    };
```

논리 스트림의 첫 레코드는 정확히 하나의 `meta` 레코드여야 한다. `meta.revision`은 매니페스트의 `revision`과 같아야 한다.

위치 값은 0 이상의 안전한 정수여야 한다. 캐릭터는 소유한 채팅보다 먼저, 채팅은 해당 브랜치·활성 브랜치·메시지 레코드보다 먼저 나타나야 한다. 각 채팅에는 하나 이상의 브랜치가 있어야 한다.

냉동 데이터는 DB 조각 레코드로 넣지 않고 별도 `coldstorage_<uuid>.json` 엔트리로 기록한다.

## 9. DB 매니페스트

매니페스트를 디코딩한 값은 다음 객체여야 한다.

```ts
interface PortableDatabaseStreamManifestV1 {
  format: "risu-portable-database-stream";
  version: 1;
  revision: number;
  totalFragments: number;
  totalRecords: number;
  counts: Partial<Record<PortableDatabaseRecordV1["type"], number>>;
  complete: true;
}
```

제약 조건은 다음과 같다.

- `revision`은 0 이상의 안전한 정수여야 한다.
- `totalFragments`와 `totalRecords`는 1 이상의 안전한 정수여야 한다.
- 생략된 `counts` 항목은 0으로 취급한다.
- `totalRecords`는 모든 조각의 `records.length` 합과 같아야 한다.
- 각 종류의 `counts`는 실제 레코드 수와 같아야 한다.
- `complete`는 반드시 `true`여야 한다.

매니페스트 엔트리는 컨테이너의 마지막 엔트리여야 한다. 작성자는 모든 DB 조각, 냉동 데이터, 에셋 및 인레이 기록이 성공한 뒤에만 매니페스트를 기록해야 한다. 따라서 매니페스트는 백업 생성 완료 표식이지만 암호학적 서명은 아니다.

읽는 쪽은 매니페스트가 없거나, 조각이 누락·중복되거나, 개수 또는 리비전이 맞지 않으면 DB를 적용해서는 안 된다.

## 10. 일관성 규칙

작성자는 백업 시작 시 소스 데이터베이스 리비전을 기록하고, 데이터베이스와 냉동 데이터 순회가 끝난 뒤 권위 있는 리비전을 다시 읽어야 한다.

- 시작과 종료 리비전이 다르면 백업을 실패시켜야 한다.
- 실패한 스트림에는 유효한 최종 매니페스트를 기록해서는 안 된다.
- 매니페스트와 `meta` 레코드에는 검증된 시작 리비전을 기록한다.

이 규칙은 백업 중 동시 쓰기로 서로 다른 시점의 DB 레코드가 섞이는 것을 감지한다. 에셋 파일 자체는 DB 리비전에 포함되지 않으므로 파일 전체에 대한 트랜잭션 스냅샷을 제공하지는 않는다.

## 11. 에셋, 냉동 데이터 및 인레이

### 11.1 에셋

`assets/` 엔트리의 페이로드는 저장된 파일의 원본 바이트다. 전체 네이티브 백업은 발견된 모든 에셋을 포함할 수 있다. 부분 백업은 캐릭터 프로필, 페르소나 아이콘, 사용자 아이콘, 배경, 모듈 아이콘, 폴더 이미지, 프리셋 이미지처럼 필수로 분류된 에셋만 포함한다.

### 11.2 냉동 데이터

냉동 데이터 이름의 UUID는 대소문자를 구분하지 않는 표준 하이픈 UUID 형식이어야 한다. 페이로드는 압축하지 않은 UTF-8 JSON이며 배열이거나 `character` 또는 `message` 필드를 가진 객체여야 한다.

### 11.3 인레이

인레이 페이로드 형식은 다음과 같다.

```text
u32le(metadata_json_length) || utf8(metadata_json) || payload
```

메타데이터 JSON에는 다음 필드가 들어간다.

```ts
interface InlayBackupMetadata {
  name: string;
  ext: string;
  type: "image" | "video" | "audio" | "signature";
  dataType: "blob" | "text";
  mime?: string;
  width?: number;
  height?: number;
}
```

`metadata_json_length`는 `1..1048576` 범위여야 하며 남은 페이로드 크기를 넘을 수 없다. 부분 백업에는 인레이를 넣지 않는다.

## 12. 선택적 계정 암호화

계정 백업에서는 `encryption.risudat`이 암호화된 DB 조각보다 먼저 나타난다.

```json
{
  "type": "account",
  "time": 1720000000000,
  "databaseEncryption": "aes-gcm-random-iv-v1"
}
```

`time`은 실제 생성 시점의 양수 타임스탬프다. 키 획득 방식은 계정 서비스 계약에 속하며 이 컨테이너 형식만으로는 백업을 복호화할 수 없다.

현재 스트리밍 구현은 각 DB 조각과 매니페스트의 RisuSave 바이트를 다음 봉투로 개별 암호화한다.

```text
"RISUDBE1" || iv[12] || aes_gcm_ciphertext_and_tag
```

AES 키는 계정 서비스가 반환한 문자열의 UTF-8 바이트를 SHA-256으로 해시해 만든다. 각 엔트리는 새 12바이트 무작위 IV를 사용하며, 정규화된 엔트리 이름의 UTF-8 바이트를 AES-GCM additional authenticated data로 사용한다. 따라서 암호문을 다른 조각 이름으로 이동하거나 매니페스트와 바꾸면 인증에 실패해야 한다. 에셋, 냉동 데이터 및 인레이는 이 계정 DB 암호화의 대상이 아니다.

초기 개발 버전이 생성한 매직 없는 스트리밍 암호문은 레거시 고정-IV 복호화 경로로 읽을 수 있다. 새 작성자는 반드시 `RISUDBE1` 봉투를 사용해야 한다.

이 방식은 기존 계정 백업과의 호환을 위한 애플리케이션 규약이다. 독립적인 범용 암호화 컨테이너 또는 파일 전체 인증 수단으로 간주해서는 안 된다.

## 13. 백업 변형과 호환성

| 변형            | DB 엔트리           | 에셋             | 인레이           | 구버전 읽기           |
| --------------- | ------------------- | ---------------- | ---------------- | --------------------- |
| 네이티브 전체   | `database.stream/*` | 전체             | 포함             | 보장하지 않음         |
| 네이티브 부분   | `database.stream/*` | 필수 에셋만      | 제외             | 보장하지 않음         |
| 호환            | `database.risudat`  | 전체             | 제외             | 의도된 경로           |
| 레거시 네이티브 | `database.risudat`  | 구현에 따라 다름 | 구현에 따라 다름 | 현재 버전이 읽기 지원 |

현재 버전의 읽는 쪽은 집계형 `database.risudat`과 스트리밍 `database.stream/*`을 모두 지원한다. 과거 버전은 스트리밍 네임스페이스를 알지 못할 수 있으므로, 과거 버전으로 복원해야 할 때는 호환 백업을 사용해야 한다.

호환 백업은 단일 DB 객체를 생성해야 하므로 스트리밍 네이티브 백업과 같은 메모리 상한을 제공하지 않는다. 브랜치 그래프처럼 구버전이 이해하지 못하는 데이터는 호환 변환 과정에서 독립 채팅 등 레거시 표현으로 물질화될 수 있다.

## 14. 읽기 검증 순서

권장 읽기 순서는 다음과 같다.

1. 각 컨테이너 프레임의 길이와 경계를 검증한다.
2. 엔트리 이름을 정규화하고 경로 세그먼트를 검증한다.
3. 지원하지 않는 확장 네임스페이스는 페이로드를 보관하지 않고 건너뛴다.
4. 암호화 메타데이터가 있다면 DB 조각보다 먼저 해석한다.
5. 각 DB 조각을 복호화·압축 해제하고 구조와 인덱스를 검증한다.
6. 마지막 매니페스트를 검증한다.
7. 조각 집합, 레코드 개수, 종류별 개수와 리비전을 대조한다.
8. 모든 검증이 끝난 뒤에만 데이터베이스 교체를 적용한다.

손상된 컨테이너를 대용량 단일 DB로 추정해 무조건 메모리에 다시 읽는 동작은 피해야 한다. 레거시 원시 DB 폴백을 제공한다면 명확한 크기 제한과 별도의 형식 검증이 필요하다.

## 15. 버전 확장 규칙

- 호환되지 않는 조각 또는 레코드 스키마 변경은 `version`을 올려야 한다.
- 새로운 레코드 `type`을 추가하면 기존 v1 읽는 쪽이 거절하므로 새 버전으로 취급해야 한다.
- 선택적인 독립 데이터는 새 최상위 네임스페이스 엔트리로 추가할 수 있다.
- 새 네임스페이스는 기존 표준 이름, `assets/`, 냉동 데이터 및 인레이 패턴과 충돌해서는 안 된다.
- 작성자는 동일한 표준 엔트리를 중복 기록해서는 안 된다.
