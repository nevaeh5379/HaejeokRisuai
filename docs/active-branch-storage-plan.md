# Active Branch Storage Redesign Plan

## 구현 상태 (2026-09-02)

- 완료: SQLite 공통 스키마(Web/Tauri/Android), 활성 브랜치 재귀 조회, 브랜치 생성·전환 API
- 완료: 리롤·수동 분기·편집 분기에서 전체 메시지 preload/rewrite/flush 제거
- 완료: 브랜치 그래프를 열 때만 비활성 브랜치 메시지를 지연 로드
- 완료: 기존 `branchState` 채팅은 변환 전까지 호환 경로로 보존
- 남음: PostgreSQL/Oracle/Azure SQL 스키마·서버 API
- 남음: 기존 `branchState`의 영속 그래프 마이그레이션과 그래프 보존 백업 포맷

## 목표

- `Chat.message`와 `branchState`를 영속 데이터의 원본으로 사용하지 않는다.
- 일반 채팅 로드는 활성 브랜치의 메시지와 활성 브랜치 실행 상태만 가져온다.
- 비활성 브랜치의 메시지와 상태는 브랜치 목록/그래프를 열 때만 지연 로드한다.
- 리롤은 전체 히스토리를 읽거나 다시 쓰지 않고 새 브랜치와 새 메시지만 추가한다.
- 브랜치 전환은 전체 메시지 교체가 아니라 `chats.active_branch_id` 갱신으로 처리한다.
- Tauri, Web, Node, Android에서 동일한 저장 계약을 제공한다.
- 기존 백업과 현재 `branchState` 데이터를 손실 없이 마이그레이션한다.

## 설계 원칙

1. 메시지는 불변에 가까운 그래프 노드다.
2. 각 메시지는 바로 이전 메시지를 `parent_message_id`로 가리킨다.
3. 각 브랜치는 현재 끝점을 `head_message_id`로 가리킨다.
4. 채팅은 현재 선택된 브랜치를 `active_branch_id`로 가리킨다.
5. 공유 히스토리는 메시지 복사가 아니라 동일한 부모 체인을 공유한다.
6. UI의 메시지 배열은 활성 브랜치를 보여 주는 페이지 캐시일 뿐, 브랜치 저장 모델이 아니다.

## 제안 스키마

### `chats` 변경

- `active_branch_id` 추가
- 기존 채팅 메타데이터는 유지
- `branchState`는 마이그레이션 완료 후 `chat_extension_nodes`에서 제거

### `chat_branches` 추가

- `id`
- `chat_id`
- `parent_branch_id`
- `fork_message_id`
- `head_message_id`
- `reason`: `root | reroll | manual`
- `created_at`
- 활성 브랜치에 필요한 스크립트 상태 참조

인덱스:

- `(chat_id, created_at)`
- `(chat_id, parent_branch_id)`
- `(chat_id, fork_message_id)`

### `branch_extension_nodes` 추가

- `scriptstate`
- `GLGlobalVariables`
- `useLocallySetGlobalVariables`
- 이후 추가되는 브랜치별 실행 상태

기존 relational node codec을 재사용하되, 일반 채팅 로드에서는 이 테이블을 활성 브랜치 한 건에 대해서만 읽는다.

### `messages` 변경

- `parent_message_id` 추가
- `origin_branch_id` 추가
- 기존 `(chat_id, id)` 식별자는 유지
- `position`은 마이그레이션 및 호환 용도로 유지하되, 브랜치의 영속 정체성으로 사용하지 않는다.

인덱스:

- `(chat_id, parent_message_id)`
- `(chat_id, origin_branch_id)`

## 활성 브랜치 조회

저장소가 `chats.active_branch_id -> chat_branches.head_message_id`를 조회한 뒤 부모 메시지 체인을 역추적한다.

- SQLite/Web/Tauri/Android: `WITH RECURSIVE`
- PostgreSQL/Azure SQL: recursive CTE
- Oracle: 해당 어댑터의 계층 쿼리 또는 recursive subquery factoring

반환 순서는 부모 체인을 역순으로 정렬한다. `messageLimit`이 있으면 head에서 최근 N개만 따라가고, 추가 페이지는 가장 오래된 로드 메시지의 `parent_message_id`부터 계속 읽는다.

일반 `loadChat()`은 다음만 반환한다.

- 채팅 메타데이터
- `activeBranchId`
- 활성 브랜치 요약 및 실행 상태
- 활성 브랜치의 요청된 메시지 페이지

다음은 반환하지 않는다.

- 전체 브랜치 목록
- 비활성 브랜치 메시지
- 비활성 브랜치 스크립트 상태

## 저장소 API 변경

`ISqlStorage`에 다음 계약을 추가한다.

- `loadActiveChat(chatId, options)`
- `loadActiveBranchMessages(chatId, options)`
- `loadBranchMessages(chatId, branchId, options)`
- `listChatBranches(chatId)`
- `createChatBranch(input)`
- `activateChatBranch(chatId, branchId)`
- `appendBranchMessage(input)`
- `updateBranchState(branchId, state)`
- `deleteChatBranch(chatId, branchId)`

`SqlCommit` 프로토콜에는 다음 변경 집합을 추가한다.

- `branchUpserts`
- `branchDeletes`
- `activeBranchUpdates`
- 메시지의 `parentMessageId`, `originBranchId`

브랜치 생성, 활성화, 첫 메시지 추가는 가능한 경우 한 트랜잭션으로 묶는다.

## 런타임 변경

### 일반 채팅

- `characterStore.ensureChatMessages()`는 `loadActiveChat()`을 사용한다.
- `chat.message`는 활성 브랜치의 현재 페이지 캐시로만 유지한다.
- 프롬프트 생성은 활성 브랜치 페이지가 아니라 필요한 전체 활성 체인을 generation 모드로 조회한다.
- 비활성 브랜치 데이터는 메모리에 보관하지 않는다.

### 리롤

현재 흐름을 제거한다.

- `ensureFullMessageIndex()`
- 전체 `preLoadChat(..., { full: true })`
- `$state.snapshot(activeChat.message)`
- `messageStore.replaceMessages()`
- 브랜치 생성을 위한 전체 채팅 `flush()`

새 흐름:

1. 대상 응답의 안정적인 `chatId`와 그 앞 사용자 메시지 ID를 사용한다.
2. 저장소에 `parentBranchId`, `forkMessageId`, `headMessageId=forkMessageId`로 새 브랜치를 만든다.
3. `chats.active_branch_id`를 새 브랜치로 변경한다.
4. 생성 상태를 즉시 시작한다.
5. 생성된 응답 한 건을 `parent_message_id=forkMessageId`로 추가한다.
6. 새 브랜치의 `head_message_id`만 갱신한다.

리롤 전 DB 작업량은 채팅 길이와 무관하게 O(1)이 되어야 한다.

### 브랜치 전환

1. `activateChatBranch(chatId, branchId)`로 포인터만 갱신한다.
2. 선택된 브랜치의 최근 메시지 페이지를 조회한다.
3. UI 메시지 캐시를 조회 결과로 갱신한다.

메시지 upsert/delete와 기존 활성 브랜치 저장은 수행하지 않는다.

### 메시지 편집

- 공유 메시지 자체 수정은 해당 노드를 한 번만 업데이트하며 모든 후손 브랜치에 반영된다.
- “브랜치로 편집”은 기존 메시지를 덮어쓰지 않고, 직전 부모에서 새 메시지 노드를 만든다.
- 현재의 `syncChatBranchMessage()` 전체 브랜치 순회는 제거한다.

### 브랜치 그래프 UI

- 그래프를 열 때만 `listChatBranches()`를 호출한다.
- 특정 브랜치 미리보기 또는 복사 시에만 `loadBranchMessages()`를 호출한다.
- 평상시 채팅 화면에는 비활성 브랜치 메시지를 전달하지 않는다.

## 마이그레이션

스키마 버전을 올리고 한 트랜잭션 안에서 실행한다.

1. 브랜치가 없는 채팅:
   - 기존 `position` 순서로 `parent_message_id` 연결
   - root branch 생성
   - 마지막 메시지를 head로 설정
   - root를 active branch로 설정
2. 기존 `branchState` 채팅:
   - 공통 prefix와 각 `branches[].messages`를 각각 타임라인으로 복원
   - 동일한 메시지 ID와 동일한 내용은 동일 노드로 공유
   - 동일 ID인데 내용이 다르면 새 ID를 발급하여 충돌 방지
   - 기존 `activeBranchId`를 새 branch row에 연결
   - 브랜치별 script/global state를 `branch_extension_nodes`로 이동
3. 모든 브랜치의 메시지 경로와 활성 타임라인을 검증
4. 검증 성공 후에만 기존 `branchState` node를 제거

Android에서는 전체 DB 객체를 메모리에 올리지 않고 채팅 단위로 스트리밍 마이그레이션한다.

## 백업 호환성

- 신규 네이티브 백업은 branch/message graph를 그대로 보존한다.
- 기존 `branchState` 백업 import는 마이그레이션 변환기를 거친다.
- 구버전 호환 export는 현재처럼 각 브랜치를 독립 채팅으로 materialize한다.
- 활성 브랜치의 script/global state가 다른 브랜치 상태와 섞이지 않는지 검증한다.

## 구현 순서

1. 프로토콜 타입과 공통 테스트 fixture 추가
2. SQLite 스키마 및 트랜잭션 마이그레이션 추가
3. Web Worker, Tauri, Capacitor 어댑터 구현
4. PostgreSQL, Oracle, Azure SQL 스키마와 조회 구현
5. `ISqlStorage` 활성 브랜치 API 구현
6. `characterStore`와 `messageStore`를 활성 브랜치 API로 전환
7. 리롤/브랜치 전환 경로를 포인터 기반으로 교체
8. 브랜치 그래프 UI를 명시적 지연 로드로 전환
9. 백업 import/export 변환기 적용
10. 기존 `branchState`, `replaceMessages()` 브랜치 경로와 전체 브랜치 순회 제거

각 단계는 이전 저장 형식의 import 테스트와 신규 형식 round-trip 테스트가 통과한 뒤 다음 단계로 진행한다.

## 필수 검증

### 기능

- 리롤, 이전/다음 리롤, 임의 응답 리롤
- 중첩 수동 브랜치와 편집 브랜치
- 브랜치별 Lua/script/global state 복원
- 멀티탭, 멀티유저 동기화, Node 실시간 작업
- 채팅 복사, 캐릭터 복제, 삭제, cold storage
- 신규/기존/구버전 백업 round-trip

### 성능 불변식

- 10,000개 메시지 채팅에서 리롤 시작 전에 전체 메시지 조회가 없어야 한다.
- 리롤 생성 시 기존 메시지 upsert/delete가 0건이어야 한다.
- 브랜치 전환 시 메시지 write가 0건이어야 한다.
- 일반 채팅 로드 시 비활성 브랜치 조회가 0건이어야 한다.
- 새 응답 저장은 메시지 1건과 branch head 갱신만 수행해야 한다.
- 메모리 사용량은 활성 메시지 페이지 크기와 활성 실행 상태에 비례해야 한다.

절대 시간 기반 테스트보다 SQL statement 수, 조회 row 수, 로드된 브랜치 수를 검증하여 플랫폼과 기기 성능에 무관하게 회귀를 차단한다.

## 제거 대상

- `Chat.branchState`에 비활성 메시지 배열 저장
- `activateChatBranch()`의 `chat.message` 전체 복제
- 브랜치 전환 목적의 `messageStore.replaceMessages()`
- 리롤 전 `ensureFullMessageIndex()`
- 리롤 전 전체 히스토리 full-mode 로드
- 브랜치별 전체 script/global state를 `Chat` snapshot에 포함하는 저장 방식
- 브랜치 변경마다 `characterStore.flush()`로 chat 전체를 relational flatten하는 경로

## 완료 기준

- 일반 채팅 경로에서 비활성 브랜치 데이터가 메모리와 SQL 응답에 나타나지 않는다.
- 리롤과 브랜치 전환 비용이 전체 채팅 길이에 비례하지 않는다.
- 모든 플랫폼에서 동일한 활성 브랜치가 같은 메시지 타임라인을 반환한다.
- 기존 데이터와 백업의 모든 브랜치가 손실 없이 변환된다.
- 브랜치 기능 테스트와 저장소 공통 테스트가 모두 통과한다.
