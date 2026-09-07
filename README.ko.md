# Haejeok RisuAI

[English](README.md) | [한국어](README.ko.md)

> 이 문서는 LLM 의해 작성되었습니다. 헛소리 혹은 개소리를 포함되어 있을 수도 있으니 참고해주세요.

<picture>
  <img alt="Haejeok RisuAI" src="./public/logo_typo_small.avif" width="400"/>
</picture>

[![Svelte](https://img.shields.io/badge/svelte-5-red?logo=svelte)](https://svelte.dev/) [![TypeScript](https://img.shields.io/badge/typescript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/) [![Tauri](https://img.shields.io/badge/tauri-2.5-%2324C8D8?logo=tauri)](https://tauri.app/) [![Vite](https://img.shields.io/badge/vite-8-%23646CFF?logo=vite)](https://vite.dev/) [![Tailwind CSS](https://img.shields.io/badge/tailwindcss-4-%2306B6D4?logo=tailwindcss)](https://tailwindcss.com/)

**Haejeok RisuAI**는 [RisuAI](https://github.com/kwaroran/RisuAI)의 독립적인 포크(fork) 프로젝트로, 셀프 호스팅, 서버 환경 운영, 데스크톱 배포, 그리고 개인 인프라를 위한 실용적인 배포 경로를 유지하는 데 중점을 두고 있습니다.

업스트림 프로젝트와 독립적으로 Haejeok 고유의 변경 사항을 개발 및 배포하면서도, RisuAI의 핵심 채팅 경험을 그대로 유지합니다.

> [!IMPORTANT]
> Haejeok RisuAI는 공식 RisuAI 릴리스가 아닙니다. 버그 보고, 릴리스, 배포 지원 및 프로젝트 고유의 변경 사항은 업스트림 프로젝트가 아닌 본 저장소로 문의해 주시기 바랍니다.

## 프로젝트 현황

Haejeok RisuAI는 현재 활발히 개발 중인 독립 빌드입니다. 현재 테스트 및 문서화가 집중적으로 이루어지고 있는 주요 서버 배포 방식은 **Docker + PostgreSQL + RustFS**입니다. 저장소 내에 다른 배포 모드도 존재할 수 있으나, 명시적으로 문서화되지 않은 경우 테스트가 덜 진행된 것으로 간주해야 합니다.

## 무엇이 다른가요?

- 독립적인 GitHub 릴리스 및 데스크톱 업데이트 기능
- 독립적인 Docker/OCI 이미지 배포
- PostgreSQL 기반 서버 스토리지
- RustFS S3 호환 에셋 스토리지 지원
- 셀프 호스팅 및 Node 서버 개선
- Git 커밋 기록 기반의 `bNNNN` 빌드 넘버링
- 내장 Risu 계정 로그인 및 계정 동기화 미포함
- RisuRealm은 외부 업스트림 서비스로 취급되며 자체 인증, 이용약관 및 콘텐츠 규정을 따름

## Q&A

Q. 갤럭시 S2에서 실행되나요?

A. 아니요

Q. 파워맥(Power Mac)에서 실행되나요?

A. 아니요

Q. 삼성 옴니아 시리즈에서 실행되나요?

A. 아니요

Q. LG 옵티머스 시리즈에서 실행되나요?

A. 아니요

Q. 아이폰 3GS에서 실행되나요?

A. 아니요

Q. Windows 98/95에서 실행되나요?

A. 아니요

Q. 인텔 80486에서 실행되나요?

A. 아니요

Q. 컴팩 데스크프로(Compaq Deskpro)에서 실행되나요?

A. 아니요

Q. 탠디 1000(Tandy 1000)에서 실행되나요?

A. 아니요

Q. 애니콜 시리즈에서 실행되나요?

A. 아니요

Q. 인텔 4004에서 실행되나요?

A. 아니요

## 주요 기능

Haejeok RisuAI는 RisuAI의 방대한 기능을 이어받았습니다:

- OpenAI, Claude, Gemini, OpenRouter 및 호환 엔드포인트 등 다양한 AI API 제공자 지원
- 캐릭터 카드, 그룹 챗, 로어북(Lorebook), 정규식 스크립트, 플러그인 및 커스텀 프롬프팅
- 감정 이미지, 추가 에셋, TTS, 번역 및 테마 커스터마이징
- HypaMemory, SupaMemory를 포함한 장기 기억(메모리) 시스템
- 웹(Web), Node 서버, Tauri 데스크톱 타깃 지원

## 스크린샷

아래 스크린샷은 업스트림 UI 참고 이미지이며 최신 Haejeok RisuAI 빌드와 완전히 일치하지 않을 수 있습니다.

|         스크린샷 1         |         스크린샷 2         |
| :------------------------: | :------------------------: |
| ![스크린샷 1][screenshot1] | ![스크린샷 2][screenshot2] |
| ![스크린샷 3][screenshot3] | ![스크린샷 4][screenshot4] |

[screenshot1]: https://github.com/kwaroran/Risuai/assets/116663078/cccb9b33-5dbd-47d7-9c85-61464790aafe
[screenshot2]: https://github.com/kwaroran/Risuai/assets/116663078/30d29f85-1380-4c73-9b82-1a40f2c5d2ea
[screenshot3]: https://github.com/kwaroran/Risuai/assets/116663078/faad0de5-56f3-4176-b38e-61c2d3a8698e
[screenshot4]: https://github.com/kwaroran/Risuai/assets/116663078/ef946882-2311-43e7-81e7-5ca2d484fa90

## 설치 방법

### 데스크톱 릴리스

사전 빌드된 데스크톱 릴리스는 [Haejeok RisuAI 릴리스](https://github.com/nevaeh5379/HaejeokRisuAI/releases) 페이지를 통해 배포됩니다.

Linux 릴리스는 여러 형식으로 제공됩니다:

- `.deb` — Debian, Ubuntu, Linux Mint, Pop!_OS 및 기타 Debian 계열 배포판 (`sudo apt install ./<package>.deb`)
- `.rpm` — Fedora, RHEL, Rocky Linux, AlmaLinux 및 기타 RPM 계열 배포판 (`sudo dnf install ./<package>.rpm`), openSUSE 사용자는 `sudo zypper install ./<package>.rpm`
- `.pkg.tar.zst` — Arch Linux, Manjaro, EndeavourOS, CachyOS 및 기타 Arch 계열 배포판 (`sudo pacman -U ./<package>.pkg.tar.zst`)
- `.AppImage` — 기타 호환되는 glibc 기반 Linux 배포판을 위한 포터블 대체 형식 (`chmod +x <package>.AppImage && ./<package>.AppImage`)

x86_64 및 ARM64 Linux 빌드가 모두 제공됩니다.

### Docker 서버 (권장)

권장되는 서버 배포 방식은 **PostgreSQL 17 + RustFS + restic**와 함께 사전 빌드된 Docker 이미지를 사용하는 것입니다.

#### 요구 사항

- Docker Engine 또는 Docker Desktop
- Docker Compose v2 (`docker compose`)
- `curl`

#### 원클릭 설치 스크립트

```sh
curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/install.sh | sh
```

설치 스크립트는 `~/haejeok-risuai` 디렉터리를 생성하고, 무작위 인증 정보를 생성하며, 간편 Compose 스택을 다운로드하고, `ubfaole9/risuai:latest` 이미지를 받아 서비스를 시작합니다. 설치 완료 후 `http://localhost:6001`에 접속하세요.

설치 프로그램이 구성하는 항목:

- `ubfaole9/risuai:latest` 기반의 Haejeok RisuAI
- PostgreSQL 17 (`postgres:17-alpine`)
- RustFS S3 호환 오브젝트 스토리지
- 암호화된 스냅샷 저장을 위한 restic

PostgreSQL은 Docker 내부 네트워크 내에만 유지됩니다. RustFS는 기본적으로 루프백에 바인딩됩니다(S3 API는 `127.0.0.1:9000`, 콘솔은 `127.0.0.1:9001`).

#### 서버 관리 및 백업

```sh
cd ~/haejeok-risuai
docker compose ps
docker compose logs -f risuai
./backup.sh
docker compose pull && docker compose up -d
```

백업 도우미 스크립트는 애플리케이션 쓰기를 일시적으로 중지하고, PostgreSQL `pg_dump`를 생성하며, 볼륨을 읽는 동안 RustFS를 중지한 후 데이터베이스 덤프, RustFS 데이터 및 `save/` 상태를 restic에 저장합니다. 기본 암호화된 restic 저장소는 로컬의 `backup/restic`에 위치하므로, 진정한 재해 복구를 위해서는 외부 호스트로 복사하거나 원격 저장소를 구성하고 `RESTIC_PASSWORD`를 별도로 안전하게 보관하세요.

백업에 대한 자세한 내용과 원격 restic 구성은 [빠른 배포 가이드](deploy/quick/README.ko.md)를 참고하세요.

### Android / Termux 서버

안드로이드 기기에서는 Docker 없이 Termux에서 직접 Node 서버를 실행할 수 있습니다. Termux 빌드는 비공개 PostgreSQL 클러스터와 로컬 파일 시스템 에셋 스토리지를 사용합니다.

```sh
curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/deploy/termux/install.sh | bash
```

설치 후 `haejeok open` 명령어로 서비스를 시작하고 로컬 브라우저를 열 수 있습니다. 서버는 기본적으로 localhost 전용입니다. 로컬 네트워크(LAN)의 다른 기기에서 접근해야 하는 경우에만 `haejeok lan on`을 사용하세요. 자세한 내용은 [Termux 배포 가이드](deploy/termux/README.ko.md)를 참고하세요.

#### 고급 / 소스 기반 설치

Node/서버 또는 브라우저 전용 정적 소스 빌드와 `lan`, `domain`, `dynv6` 및 외부 리버스 프록시 모드를 위한 전체 `risuai.sh` 설치 스크립트도 계속 제공됩니다:

```sh
git clone https://github.com/nevaeh5379/HaejeokRisuAI.git
cd HaejeokRisuAI
./risuai.sh install --mode local -y

# Node/PostgreSQL/RustFS 없이 Caddy로 서빙되는 정적 웹 빌드
./risuai.sh install --runtime static --mode local -y
```

해당 모드와 보안 관련 주의 사항은 [고급 배포 가이드](deploy/rustfs/README.ko.md)를 참고하세요.

### 개발 환경 설정

개발을 위해서는 Node.js 20.19+ 또는 22.12+ 버전과 pnpm이 필요합니다.

```sh
git clone https://github.com/nevaeh5379/HaejeokRisuAI.git
cd HaejeokRisuAI
pnpm install
pnpm dev
```

## 법적 고지 및 업스트림 서비스

- [Haejeok RisuAI 이용약관](docs/TERMS.md)
- [Haejeok RisuAI 개인정보처리방침](docs/PRIVACY.md)
- [원작 RisuAI 서비스 약관](https://sv.risuai.xyz/hub/tos)
- [RisuRealm 콘텐츠 규정](https://realm.risuai.net/help/content-rules)

Haejeok RisuAI는 내장 Risu 계정 로그인이나 계정 동기화 기능을 제공하지 않습니다. RisuRealm 및 기타 업스트림에서 호스팅하는 서비스는 원작 RisuAI 메인테이너가 운영하는 별도의 서비스이며, 각 서비스의 자체 정책을 따릅니다.

## 커뮤니티 및 기술 지원

Haejeok RisuAI의 버그, 배포 문제, 프로젝트 고유 기능 제안은 [Haejeok RisuAI 이슈 트래커](https://github.com/nevaeh5379/HaejeokRisuAI/issues)를 이용해 주세요.

업스트림 RisuAI Discord 서버, 웹사이트 및 지원 채널은 Haejeok RisuAI의 지원 채널이 아닙니다.

## 업스트림 프로젝트

Haejeok RisuAI는 [RisuAI](https://github.com/kwaroran/RisuAI)를 기반으로 하며, Git 커밋 기록과 GPL-3.0 라이선스 소스 헤리티지를 유지하고 있습니다.

업스트림의 개발, 문서 및 커뮤니티 리소스는 원작 RisuAI 프로젝트의 소유입니다. Haejeok 고유의 릴리스와 변경 사항은 본 저장소에서 독자적으로 유지 관리됩니다.

만약 변경 사항이 원작 프로젝트에도 적합한 내용이라면, 업스트림 RisuAI에 별도로 기여(PR)할 수 있습니다.

## 라이선스

이 프로젝트는 저장소의 [GNU General Public License v3.0](LICENSE)에 따라 배포됩니다.
