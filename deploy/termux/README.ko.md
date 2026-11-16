# Termux 배포 가이드

[English](README.md) | [한국어](README.ko.md)

Haejeok RisuAI는 Docker 없이 Termux를 통해 안드로이드 기기에서 직접 실행할 수 있습니다.
Termux 런타임은 다음을 사용합니다:

- Termux 저장소의 Node.js 24.12 이상
- `127.0.0.1`에 바인딩된 비공개 PostgreSQL 클러스터
- Haejeok 데이터 디렉터리 하위의 로컬 파일 시스템 에셋 스토리지
- PostgreSQL 및 Node 서버를 위한 `termux-services`/runit
- 최신 GitHub 릴리스의 사전 빌드된 Haejeok 프론트엔드

## 설치 방법

최신 버전의 Termux에서 다음 명령어를 실행합니다:

```sh
curl -fsSL https://raw.githubusercontent.com/ioshn/HaejeokRisuai_c4/main/deploy/termux/install.sh | bash
```

설치 프로그램이 서버를 시작하며, `termux-open-url`을 사용할 수 있는 경우 브라우저로 `http://127.0.0.1:6001`을 자동으로 엽니다.

기본 데이터 디렉터리:

```text
~/.local/share/haejeok-risuai
```

## 기존 원본 서버에서 이 포크로 전환

`nevaeh5379/HaejeokRisuai`의 네이티브 Termux 설치 프로그램으로 정상 실행 중인 서버 기준입니다. 실행 구성은 그대로 두고 설치·업데이트 대상만 `ioshn/HaejeokRisuai_c4`로 변경합니다. Git 저장소를 새로 clone하거나 데이터베이스를 새로 만들 필요는 없습니다.

먼저 이 포크의 최신 공개 릴리스에 `RisuAI-Termux-<태그>.tar.gz`와 같은 이름의 `.sha256` 파일이 있는지 확인하세요. 스크립트만 변경되고 런타임이 아직 릴리스되지 않았다면 전환하지 마세요.

1. 기존 서버를 중지하고 데이터 디렉터리를 백업합니다. 두 명령이 모두 성공한 뒤 진행하세요.

   ```sh
   haejeok stop
   tar -czf "$HOME/haejeok-before-c4-$(date +%Y%m%d-%H%M%S).tar.gz" \
     -C "${HAEJEOK_TERMUX_HOME:-$HOME/.local/share/haejeok-risuai}" .
   ```

   백업에는 설정·인증 정보와 PostgreSQL 데이터가 포함되므로 비공개로 보관하세요. 별도 `HAEJEOK_TERMUX_HOME`을 사용했다면 전환할 때도 동일한 값을 유지하세요. `config.env`에서 데이터 경로를 해당 디렉터리 밖으로 바꿨다면 그 경로도 별도로 백업해야 합니다.

2. 기존 `haejeok update` 대신 **포크의 설치 프로그램을 직접 한 번** 실행합니다. 기존 명령은 아직 원본 저장소를 가리킵니다.

   ```sh
   unset HAEJEOK_TERMUX_TAG
   curl -fsSL https://raw.githubusercontent.com/ioshn/HaejeokRisuai_c4/main/deploy/termux/install.sh | bash
   ```

   원본 설치 프로그램과 동일하게 Termux 패키지 업데이트도 수행합니다. 기존 `config.env`와 저장된 데이터·포트·LAN 설정을 재사용하고 앱과 `haejeok` 명령을 교체한 뒤 자동으로 시작합니다. PostgreSQL 버전 불일치 등으로 실패하면 오류를 먼저 해결하고, 기존 데이터 디렉터리를 삭제하거나 초기화하지 마세요.

3. 서비스와 설치 버전을 확인하고 기존 주소로 접속합니다.

   ```sh
   haejeok status
   haejeok version
   haejeok open
   ```

   기존 캐릭터·대화·에셋이 보이는지 확인하세요. 이후에는 `haejeok update`가 이 포크의 최신 릴리스를 설치합니다. 기존 홈 화면 바로가기도 그대로 사용합니다. 시작에 실패하면 `haejeok logs`와 `haejeok logs postgres`로 확인하세요.

## 명령어 안내

```sh
haejeok open             # 서비스 시작 및 로컬 브라우저 열기
haejeok start            # PostgreSQL 및 Node 서버 시작
haejeok stop             # 두 서비스 모두 중지
haejeok restart
haejeok status
haejeok logs             # Node 서버 로그 확인
haejeok logs postgres    # PostgreSQL 로그 확인
haejeok update           # 최신 릴리스된 Termux 런타임으로 업데이트
haejeok doctor
```

Node 서버는 기본적으로 기기(휴대폰) 로컬에서만 접속할 수 있도록 대기합니다. 동일한 네트워크의 다른 기기에서 접속할 수 있도록 허용하려면:

```sh
haejeok lan on
```

이 명령어는 `RISU_HOST`를 `0.0.0.0`으로 변경합니다. 다시 localhost 전용으로 되돌리려면:

```sh
haejeok lan off
```

LAN 모드가 활성화되었을 때는 휴대폰의 LAN IP 주소와 설정된 앱 포트를 사용하여 접속하세요. 암호화되지 않은 일반 HTTP 포트를 공용 인터넷에 직접 노출하지 마세요.

## 홈 화면 바로가기

설치 프로그램이 다음 경로에 바로가기 스크립트를 생성합니다:

```text
~/.shortcuts/Haejeok-RisuAI
```

Termux:Widget 앱이 설치되어 있다면 안드로이드 홈 화면에 해당 위젯 바로가기를 추가할 수 있습니다. 위젯을 탭하면 서비스가 시작되고 브라우저에서 Haejeok RisuAI가 열립니다.

## 스토리지 및 업데이트

애플리케이션 코드와 영구 보관 데이터는 의도적으로 분리되어 있습니다. 런타임을 업데이트하더라도 `app/` 디렉터리만 교체되며, 다음 항목은 안전하게 유지됩니다:

- `save/`
- 비공개 PostgreSQL 클러스터
- `config.env`

설치 프로그램은 새 서버가 `/api/health` 헬스체크를 통과할 때까지 이전 런타임을 `app.previous`로 유지한 후 삭제합니다.

## 현재 Termux 지원 범위

Termux용 최소 런타임은 의도적으로 PostgreSQL + 로컬 파일 시스템 조합만 사용하도록 구성되었습니다. S3/RustFS, Azure SQL, Oracle Database 및 네이티브 `sharp` 이미지 처리 모듈은 Termux 런타임 의존성에 포함되지 않습니다. 이러한 백엔드가 필요한 환경에서는 일반 Docker/서버 빌드를 사용하는 것이 적합합니다.
