# RisuAI Native (Linux Qt6 C++ / QML)

리눅스 네이티브 고성능 C++20 + Qt6 (QML) 환경으로 완벽하게 포팅된 **RisuAI Native Desktop**입니다.

## ✨ 주요 기능 및 특징 (Key Features)

### 1. 코어 데이터 및 스토리지 (Core Architecture)
- **SQLite 3.53+ (WAL Mode)**: 빠르고 안전한 네이티브 트랜잭션, 외래키(`ON DELETE CASCADE`), 인덱싱을 지원하는 스토리지.
- **다중 스와이프 및 브랜칭 (Multi-Swipe & Branching)**: AI 답변에 대해 무제한 스와이프 생성, 좌/우 스와이프 탐색, 스와이프별 추론/사고(Thought/Reasoning) 과정 보존.
- **전체 백업 및 복원 (Full JSON Backup & Restore)**: 캐릭터, 채팅, 프리셋, 페르소나, 로어북을 완전하게 내보내기/가져오기 가능.

### 2. 캐릭터 카드 사양 (Character Card V2/V3 & Tavern Spec)
- **PNG tEXt 청크 입출력**: PNG 이미지 파일의 `chara` (CCv2 Base64 JSON) 및 `ccv3` 메타데이터 청크를 직접 파싱하고 삽입하는 CRC32 기반 청크 인코더/디코더.
- **풍부한 캐릭터 에디터**: 기본 정보, 첫 메시지(인사말), 대체 인사말(Alternate Greetings) 관리, 성격/외모/상황 설명, 예시 대화(`<START>`), 시스템 프롬프트 오버라이드, 포스트 히스토리 지시문, 태그, 아바타 변경.

### 3. AI 스트리밍 엔진 & 멀티 프로바이더 (AI Network & SSE Streaming)
- **OpenAI**: SSE 스트리밍, `reasoning_content` (o1/o3/DeepSeek), 토큰 사용량 통계.
- **Anthropic Claude**: `Messages API` SSE 스트리밍 (`content_block_delta`, `thinking_delta`, `message_delta`), 번갈아 나오는 역할 정규화.
- **Google Gemini**: REST `streamGenerateContent` SSE 스트리밍, 생각 과정 및 사용량 파싱.
- **OpenRouter & Custom**: OpenAI 호환 모든 커스텀 엔드포인트 지원.
- **Ollama**: 로컬 LLM (`/api/chat`) 실시간 스트리밍.

### 4. 프롬프트 & 로어북 & 매크로 엔진 (Engine)
- **매크로 처리**: `{{char}}`, `{{user}}`, `{{description}}`, `{{personality}}`, `{{scenario}}`, `{{time}}`, `{{date}}`, `{{random:...}}` 자동 치환.
- **로어북 (World Info)**: 키워드 감지, 보조 키(Selective Matching), 정규식(Regex) 모드, 검색 깊이(Scan Depth), 삽입 순서(Insert Order).
- **다국어 고속 토크나이저**: 영어, 한글(Hangul), CJK, 코드, 특수문자 토큰 추정 및 컨텍스트 윈도우 버짓 관리.
- **정규식 스크립트**: 채팅 표시 필터, 생성 전 프롬프트 변환, 생성 후 응답 필터.

### 5. UI/UX (Qt Quick QML)
- **반응형 다크/라이트 테마**: Dark (기본), Light, Dracula, Cherry 팔레트.
- **실시간 스트리밍 애니메이션 & Markdown 렌더링**: 볼드, 이탤릭, 인라인 코드, 블록 코드, 스와이프 카운터, 생각/추론 드로어.
- **단축키**: `Ctrl + Enter` (메시지 전송), `Ctrl + Shift + Enter` (줄바꿈), `Ctrl + R` (응답 다시 생성).

---

## 🛠️ 빌드 및 실행 방법 (Build & Run)

### 필수 요구사항 (Prerequisites)
- CMake 3.20 이상
- C++20 지원 컴파일러 (GCC 12+ / Clang 15+)
- Qt 6.5+ (`qt6-base`, `qt6-declarative`, `qt6-svg`, `qt6-quickcontrols2`)
- Ninja 또는 Make

### 빌드 (Build)
```bash
cd qt
cmake -B build -S . -G Ninja
cmake --build build
```

### 테스트 실행 (Run Tests)
```bash
./build/risuai_tests
# 또는
ctest --test-dir build --output-on-failure
```

### 애플리케이션 실행 (Launch App)
```bash
./build/risuai
```

---

## 📂 폴더 구조 (Project Structure)

```
qt/
├── CMakeLists.txt              # CMake 빌드 설정 (risuai, risuai_tests)
├── resources.qrc               # QML 및 리소스 번들
├── src/
│   ├── main.cpp                # 앱 진입점 및 QML 엔진 바인딩
│   ├── core/                   # 데이터 모델, SQLite DB 매니저, 앱 설정
│   │   ├── Types.hpp
│   │   ├── AppConfig.hpp/.cpp
│   │   └── DatabaseManager.hpp/.cpp
│   ├── engine/                 # 토크나이저, 매크로/프롬프트 엔진, 정규식 엔진
│   │   ├── Tokenizer.hpp/.cpp
│   │   ├── RegexEngine.hpp/.cpp
│   │   └── PromptEngine.hpp/.cpp
│   ├── storage/                # PNG tEXt 청크 입출력, JSON 백업/복원
│   │   ├── CharacterCardIO.hpp/.cpp
│   │   └── ExportImport.hpp/.cpp
│   ├── network/                # AI 프로바이더 (OpenAI, Claude, Gemini, Ollama)
│   │   ├── AIProvider.hpp/.cpp
│   │   ├── OpenAIProvider.hpp/.cpp
│   │   ├── ClaudeProvider.hpp/.cpp
│   │   ├── GeminiProvider.hpp/.cpp
│   │   └── OllamaProvider.hpp/.cpp
│   ├── models/                 # QML ListModel (Character, Message, Preset, Lorebook)
│   │   ├── CharacterListModel.hpp/.cpp
│   │   ├── ChatMessageModel.hpp/.cpp
│   │   ├── PresetListModel.hpp/.cpp
│   │   └── LorebookListModel.hpp/.cpp
│   └── controllers/            # C++ <-> QML 비즈니스 로직 컨트롤러
│       ├── AppController.hpp/.cpp
│       ├── ChatController.hpp/.cpp
│       ├── CharacterController.hpp/.cpp
│       ├── PresetController.hpp/.cpp
│       ├── LorebookController.hpp/.cpp
│       └── PersonaController.hpp/.cpp
├── qml/                        # Qt Quick QML UI
│   ├── Main.qml                # 메인 윈도우 및 스택 뷰
│   ├── theme/                  # 다크/라이트/드라큘라/체리 테마 싱글톤
│   ├── components/             # 버튼, 텍스트필드, 슬라이더, 카드, 다이얼로그, 마크다운 뷰, 토스트
│   └── views/                  # ChatView, SidebarView, CharacterEditorView, PresetSettingsView, LorebookEditorView, PersonaEditorView, GlobalSettingsView
└── tests/
    └── test_main.cpp           # C++20 통합/단위 테스트 스위트
```
