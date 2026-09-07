# 빠른 Docker 설치 가이드

[English](README.md) | [한국어](README.ko.md)

이 배포 방식은 소스 코드 저장소를 복제(clone)하지 않고도 PostgreSQL, RustFS 및 restic 암호화 백업이 포함된 Haejeok RisuAI를 실행하려는 사용자를 위해 지원되는 최소 구성의 설치 경로입니다.

설치 명령어:

```sh
curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/install.sh | sh
```

설치 프로그램은 기본적으로 `~/haejeok-risuai`에 파일을 생성하고, 무작위 서비스 인증 정보를 생성하며, 사전 빌드된 `ubfaole9/risuai:latest` 이미지를 받아 스택을 실행합니다.

기본 엔드포인트는 루프백(localhost) 전용으로 바인딩됩니다:

- Haejeok RisuAI: `http://localhost:6001`
- RustFS S3 API: `http://127.0.0.1:9000`
- RustFS 콘솔: `http://127.0.0.1:9001`

PostgreSQL은 호스트 포트를 외부에 노출하지 않습니다.

## 파일 및 영구 데이터

설치 디렉터리 구성 요소:

- `.env`: 자동 생성된 PostgreSQL, RustFS 및 restic 인증 정보
- `docker-compose.yml`: 빠른 배포 정의 파일
- `backup.sh`: 유기적으로 연동되는 restic 백업 도우미 스크립트
- `save/`: 애플리케이션 파일 시스템 상태
- `backup/restic/`: 기본 로컬 암호화 restic 저장소
- `backup/staging/`: 임시 PostgreSQL 덤프 및 복구 메타데이터

PostgreSQL과 RustFS는 Docker 네임드 볼륨을 사용합니다.

## 백업

실행 방법:

```sh
cd ~/haejeok-risuai
./backup.sh
```

백업 도우미 스크립트의 동작 과정:

1. 필요 시 restic 저장소를 초기화합니다.
2. 스토리지 간 교차 쓰기를 방지하기 위해 애플리케이션을 일시 중지합니다.
3. 일관성 있는 PostgreSQL `pg_dump` 아카이브를 생성합니다.
4. 데이터 볼륨을 읽기 전에 RustFS를 중지합니다.
5. `save/`, RustFS 볼륨, 데이터베이스 덤프 및 복구 메타데이터를 restic으로 백업합니다.
6. 백업 실행 전에 동작 중이던 서비스들을 다시 시작합니다.

PostgreSQL 데이터 디렉터리 자체는 의도적으로 직접 복사하지 않습니다. 논리적 덤프(`pg_dump`)가 공식 지원되는 데이터베이스 백업 아티팩트입니다.

기본 restic 저장소는 로컬의 `backup/restic`에 위치합니다. 스냅샷을 암호화하여 보호하지만, 호스트 기기나 디스크의 물리적 손실까지는 보호하지 **못합니다**. 진정한 재해 복구(DR) 용도로 활용하려면 저장소를 다른 곳으로 복사하거나 원격 restic 백엔드를 구성하세요.

`.env`의 `RESTIC_PASSWORD`는 모든 스냅샷의 암호 해독에 필수적입니다. 이 비밀번호는 서버와 분리된 안전한 곳에 보관하세요.

## 원격 restic 저장소 설정

`.env` 파일을 편집하여 `RESTIC_REPOSITORY`를 변경합니다. S3 호환 백엔드의 경우, 빠른 배포 스택은 다음의 선택적 환경 변수도 restic에 전달합니다:

```text
RESTIC_AWS_ACCESS_KEY_ID=
RESTIC_AWS_SECRET_ACCESS_KEY=
RESTIC_AWS_DEFAULT_REGION=
RESTIC_AWS_SESSION_TOKEN=
```

저장소 경로 문자열(URI) 자체가 백엔드 유형을 결정합니다. 해당 백엔드에 필요한 인증 정보만 입력하세요.

데이터를 덮어쓰는 자동 복구 기능은 현재 의도적으로 포함되지 않았습니다. 백업 정책을 전적으로 신뢰하기 전에 restic 서비스를 통해 스냅샷을 확인하고 별도의 설치 환경에서 복구 테스트를 진행하세요.

## 관리 명령어

```sh
cd ~/haejeok-risuai
docker compose ps
docker compose logs -f risuai
docker compose pull && docker compose up -d
docker compose stop
docker compose up -d
```

도메인, DDNS, 외부 리버스 프록시 또는 소스 빌드 배포 모드를 사용하려면 소스 체크아웃 환경의 전체 `risuai.sh` 설치 프로그램을 사용하세요.
