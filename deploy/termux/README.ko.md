# Termux 배포 가이드

[English](README.md) | [한국어](README.ko.md)

Haejeok RisuAI는 Docker 없이 Termux를 통해 안드로이드 기기에서 직접 실행할 수 있습니다.
Termux 런타임은 다음을 사용합니다:

- Termux 저장소의 Node.js LTS
- `127.0.0.1`에 바인딩된 비공개 PostgreSQL 클러스터
- Haejeok 데이터 디렉터리 하위의 로컬 파일 시스템 에셋 스토리지
- PostgreSQL 및 Node 서버를 위한 `termux-services`/runit
- 최신 GitHub 릴리스의 사전 빌드된 Haejeok 프론트엔드

## 설치 방법

최신 버전의 Termux에서 다음 명령어를 실행합니다:

```sh
curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/deploy/termux/install.sh | bash
```

설치 프로그램이 서버를 시작하며, `termux-open-url`을 사용할 수 있는 경우 브라우저로 `http://127.0.0.1:6001`을 자동으로 엽니다.

기본 데이터 디렉터리:

```text
~/.local/share/haejeok-risuai
```

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
