# RisuAI Node/스토리지 및 정적 웹 배포 가이드

[English](README.md) | [한국어](README.ko.md)

`risuai.sh`는 전체 RisuAI Node/PostgreSQL/RustFS 스택 또는 Caddy로 서빙되는 브라우저 전용 정적 빌드를 위한 안내형 설치 및 수명 주기 관리 스크립트입니다. 저장된 구성에 필요한 런타임, 네트워킹 및 DDNS 서비스만 선별하여 실행합니다. 로컬 Docker Engine 또는 Docker Desktop 데몬 및 Docker Compose v2가 설치된 소스 체크아웃 디렉터리에서 실행하세요:

```sh
./risuai.sh install
```

이 스크립트는 로컬 호스트의 경로와 포트 상태를 검사하므로 원격 Docker 컨텍스트는 거부됩니다. 대화형 기본값은 `node` 및 `local`입니다. 유효한 설정이 이미 저장되어 있는 상태에서 재설치할 경우 기존에 저장된 런타임, 모드 및 인증 정보가 기본적으로 유지됩니다.

## 애플리케이션 런타임

| 런타임 | 애플리케이션 서비스 | 스토리지 서비스 | 주 사용 목적 |
| --- | --- | --- | --- |
| `node` | `Dockerfile`로 빌드된 Node 서버 | PostgreSQL 및 RustFS | 서버 환경 / 다중 기기 배포 |
| `static` | `pnpm buildsite` 출력물을 서빙하는 Caddy | 없음 | 브라우저 전용 웹 애플리케이션 |

호환성을 위해 기본값은 `node`로 유지됩니다. 정적 런타임은 `--runtime static` 옵션으로 선택할 수 있습니다. 정적(static) 모드는 Node 서버, PostgreSQL, RustFS를 시작하지 않으며 `risuai.sh db ...` 명령어를 사용할 수 없습니다. 애플리케이션 데이터와 기능은 Node 서버가 아닌 브라우저 빌드를 따르므로, 서버 측 영구 저장소나 Node 전용 API는 작동하지 않습니다. 기존 Node 설정을 정적으로 전환하더라도 네임드 데이터 볼륨은 그대로 유지되지만, 정적 애플리케이션에서는 해당 볼륨을 사용하지 않습니다.

정적 애플리케이션 자체는 내부 Caddy 컨테이너에 의해 6001 포트로 서빙됩니다. `domain` 및 `dynv6` 모드에서는 기존 에지(edge) Caddy 서비스가 공용 TLS를 종단(terminate)하고 내부 정적 서버로 프록시합니다. 이를 통해 모든 외부 노출 모드와 외부 프록시 타깃의 일관성을 유지합니다.

## 배포 모드

| 모드 | 외부 노출 접근 방식 | 추가 서비스 |
| --- | --- | --- |
| `local` | 루프백 HTTP (기본값: `http://localhost:6001`) | 없음 |
| `lan` | 모든 IPv4 인터페이스의 일반 HTTP (기본 포트: 6001) | 없음 |
| `domain` | 수동 관리 또는 Cloudflare 관리 호스트네임 기반 Caddy HTTPS | Caddy 및 선택적 Cloudflare DDNS |
| `dynv6` | `dynv6.net` 서브도메인 기반 Caddy HTTPS | Caddy 및 dynv6 DDNS |
| `proxy` | 기존 호스트 또는 Docker 리버스 프록시 연동 | 번들 프록시 없음 |

PostgreSQL은 외부에 노출되지 않습니다. 설치 프로그램은 `lan` 모드를 포함하여 항상 RustFS S3 API 및 콘솔을 IPv4 루프백(localhost)에만 바인딩합니다. `domain` 및 `dynv6` 모드에서는 Caddy가 공용 매핑을 수신하는 동안 RisuAI 역시 루프백 전용 유지보수 매핑을 유지합니다.

`lan` 모드는 사설 서브넷으로 자동 제한되지 않습니다. `0.0.0.0`은 호스트의 모든 IPv4 인터페이스를 의미하므로, 호스트 네트워크와 상위 방화벽이 신뢰할 수 있는 클라이언트로 접근을 엄격히 제한하고 있을 때만 이 모드를 사용하세요.

## 설치 옵션

공식 명령어 요약은 `./risuai.sh help`를 실행하여 확인하세요. 주요 설치 옵션은 다음과 같습니다:

| 목적 | 옵션 |
| --- | --- |
| 애플리케이션 | `--runtime node|static` |
| 모드 설정 | `--mode`, `--domain`, `--dns-provider`, `--proxy-type`, `--proxy-network` |
| DDNS 인증 정보 | `--dynv6-token-file`, `--cloudflare-token-file`, `--cloudflare-zone-id` |
| DDNS 동작 | `--ddns-interval`, `--ipv6`, `--no-ipv6`, `--skip-ddns-check` |
| 호스트 포트 | `--app-port`, `--rustfs-api-port`, `--rustfs-console-port`, `--http-port`, `--https-port` |
| 검증 및 실행 | `--wait-timeout`, `--skip-port-check`, `--dry-run`, `--no-start`, `--configure-firewall`, `--adopt-existing`, `--yes` |

포트는 `1..65535` 범위 내여야 하며, 선택한 레이아웃 내에서 충돌할 수 없고, 향후 관리 명령어를 위해 저장됩니다. 기본값은 앱 6001, RustFS API 9000, RustFS 콘솔 9001, Caddy HTTP 80, Caddy HTTPS/HTTP3 443입니다.
`--http-port` 및 `--https-port`는 `domain` 또는 `dynv6` 모드에서만 유효합니다.
Docker 프록시 모드는 앱 호스트 매핑이 없으며 항상 내부 업스트림 `risuai:6001`을 사용하므로, 이 모드에서는 `--app-port`를 6001로 유지해야 합니다.
RustFS 포트 옵션은 `--runtime node`에서만 유효합니다. 새로운 정적 구성에서는 PostgreSQL/RustFS 인증 정보 환경 변수가 무시됩니다.

`--ddns-interval`은 60초부터 86400초까지 설정할 수 있습니다. `--ipv6`는 AAAA 레코드 업데이트를 추가하며, 번들된 두 DDNS 업데이터 모두 IPv4도 함께 업데이트하므로 배포가 IPv6 전용이 되는 것은 아닙니다. AAAA 레코드 업데이트가 성공하려면 업데이터 컨테이너 자체에 정상적인 IPv6 연결이 가능해야 합니다.

### 토큰 입력 방식

명령어 인수로 전달된 토큰 값은 프로세스 목록에 노출되고 셸 히스토리에 남을 수 있으므로 토큰 파일을 사용하는 것이 권장됩니다. 설치 프로그램은 제공된 파일의 첫 번째 줄을 읽어 유효성을 검사한 후 `.risuai/` 아래의 모드별 파일로 복사합니다. 원본 파일은 실행 중인 컨테이너에 마운트되지 않습니다.

`DYNV6_TOKEN` 및 `CLOUDFLARE_TOKEN` 환경 변수도 지원됩니다. `--dynv6-token`, 레거시 별칭인 `--token`, 그리고 `--cloudflare-token`도 호환성을 위해 유지되지만 경고가 출력됩니다. 동일한 모드를 재설치할 때 새 토큰을 명시적으로 전달하지 않으면 기존에 보호되어 저장된 토큰이 재사용됩니다.

## 사용 예시

```sh
# 로컬 전용 설치
./risuai.sh install --mode local -y

# Caddy를 통해 로컬에서 서빙되는 브라우저 전용 웹 빌드
./risuai.sh install --runtime static --mode local -y

# 자동 HTTPS가 적용된 브라우저 전용 웹 빌드
./risuai.sh install --runtime static --mode domain \
  --domain static.example.com --dns-provider manual -y

# 커스텀 애플리케이션 포트를 사용하는 LAN HTTP
./risuai.sh install --mode lan --app-port 7000 -y

# A/AAAA 레코드가 외부에서 관리되는 도메인
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider manual -y

# Cloudflare DDNS가 적용된 도메인
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider cloudflare \
  --cloudflare-zone-id 0123456789abcdef0123456789abcdef \
  --cloudflare-token-file /run/secrets/cloudflare-token \
  --ipv6 -y

# dynv6 DDNS
./risuai.sh install --mode dynv6 --domain my-chat.dynv6.net \
  --dynv6-token-file /run/secrets/dynv6-token --ipv6 -y

# 호스트에 직접 설치된 리버스 프록시 연동
./risuai.sh install --mode proxy --proxy-type host \
  --app-port 7000 -y

# 기존 Docker 네트워크에서 실행 중인 리버스 프록시 연동
docker network create reverse-proxy
./risuai.sh install --mode proxy --proxy-type docker \
  --proxy-network reverse-proxy -y
```

설정, DNS, 방화벽 규칙, 이미지 또는 컨테이너를 변경하지 않고 사전 검증 및 계획만 확인하려면:

```sh
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider manual --dry-run
```

`--dry-run`을 실행하더라도 정상 작동하는 로컬 Docker 데몬이 필요하며, 소유권, 포트, 저장된 상태 및 Compose 검증을 수행합니다. `--skip-port-check`는 호스트 소켓 검색을 사용할 수 없는 플랫폼을 위한 우회 수단이며, 충돌하는 Docker 매핑을 해결해 주지는 않습니다.

`--no-start`는 설정을 검증하고 저장하지만 이미지 빌드, 1회성 DDNS 검사, 컨테이너 조정(reconciliation) 및 준비 대기를 건너뜁니다. 다음 `start` 실행 시 로컬 RisuAI 이미지가 없으면 빌드합니다. 이미 실행 중인 설치본에 `--no-start`로 설정을 변경하면 `down`/`start`나 다른 설치 실행으로 조정되기 전까지 기존 컨테이너가 이전 설정대로 계속 작동합니다. `--configure-firewall`은 `--no-start`와 함께 사용해도 UFW를 변경할 수 있으므로, 설정만 미리 준비해 둘 때는 이 옵션을 제외하세요.

`--adopt-existing`은 일반 설치 옵션이 아닌 복구용 옵션입니다. 기존 컨테이너나 고정된 `risuai-rustfs_*` 볼륨이 현재 설치본에 속하고 기존 PostgreSQL 및 RustFS 인증 정보를 사용할 수 있음을 확인한 후에만 사용하세요. 그렇지 않으면 설치 프로그램은 기존 데이터 위에 새 인증 정보를 생성하는 것을 거부합니다.

## 보호 상태 및 트랜잭션 범위

설치 프로그램은 스크립트 옆의 `.risuai/` 디렉터리에 설정을 보관합니다:

- 디렉터리는 `0700` 권한으로, 설정 및 토큰 파일은 `0600` 권한으로 생성합니다.
- 심볼릭 링크, 타 소유자의 상태 경로, 잘못된 설정 조합, 안전하지 않은 인증 정보 특수문자를 거부합니다.
- 관련 없는 셸 변수로부터 Compose 변수 치환을 격리하고 Compose 프로젝트 이름을 고정합니다.
- 서비스 레이블에 32자의 고유 설치 ID를 부여하고 다른 체크아웃 소유의 컨테이너를 거부합니다.
- 상태를 변경하는 작업들을 작업 잠금(operation lock)을 통해 순차화합니다.

이는 파일 시스템 권한 제어이며 암호화가 아닙니다. `.risuai/rustfs.env` 또는 토큰 파일이 포함된 백업은 동일한 수준의 보호를 받아야 합니다. 또한 고정된 Compose 프로젝트 및 컨테이너 이름으로 인해 안내형 스택은 Docker 데몬당 단 하나의 설치본만 지원합니다.

일반 설치 또는 재설치 시 스크립트는 새로운 보호 파일을 활성화하기 전에 예정된 Compose 모델을 검증하고, RisuAI를 빌드하며, 요청된 1회성 DDNS 업데이트를 수행합니다. 그 후 이전 env 및 토큰 파일의 스냅샷을 생성하고 새 버전을 활성화한 뒤 Compose를 시작하고 내부 RisuAI 준비 상태 검사를 기다립니다. 활성화나 시작에 실패하면 이전 보호 파일을 복원하고, 이전에 배포본이 실행 중이었던 경우 재시작을 시도합니다.

이 롤백은 영구 애플리케이션 데이터를 복원하거나, DNS 업데이트를 취소하거나, 새로 빌드된 이미지를 삭제하거나, 이미 실행된 데이터베이스 마이그레이션을 되돌리지 **않습니다**. UFW 변경 사항은 설정 트랜잭션이 커밋된 후에만 적용되며 스크립트에 의해 롤백되거나 사후 삭제되지 않습니다. 업그레이드, 마이그레이션 또는 위험한 모드 변경 전에는 반드시 실제 백업을 수행하세요.

Node 구성의 기존 PostgreSQL 및 RustFS 인증 정보는 재설치를 통해 교체(rotate)할 수 없습니다. 두 서비스 모두 전용 교체 절차가 필요하므로 스크립트는 변경된 값을 거부합니다.

## DNS, TLS, 라우터 및 방화벽

수동 DNS의 경우 A 레코드를 생성하고, 엔드투엔드 IPv6를 사용할 수 있는 경우에만 AAAA 레코드를 추가하세요. 설치 프로그램은 호스트네임과 Compose 모델을 검증하지만 공용 DNS 전파, 라우터 도달 가능성, 클라우드 방화벽 정책 또는 외부 TLS 접근 성공 여부를 보증하지는 않습니다.

Caddy의 자동 인증서 발급 절차는 서비스가 표준 포트를 통해 외부에 공개적으로 도달할 수 있어야 합니다. 기본 호스트 매핑을 사용할 경우 공용 TCP 80을 호스트 TCP 80으로, 공용 TCP 443을 호스트 TCP 443으로 포트포워딩하세요. UDP 443은 선택 사항으로 HTTP/3을 활성화하며, 일반적인 HTTPS는 TCP 443을 사용합니다. 자세한 내용은 Caddy의 [자동 HTTPS 문서](https://caddyserver.com/docs/automatic-https)를 참고하세요.

커스텀 `--http-port` 및 `--https-port` 값은 **호스트 측** Docker 매핑을 변경하는 것이며, 공용 ACME 포트를 변경하는 것이 아닙니다. 예를 들어 `--http-port 8080 --https-port 8443`으로 설정한 경우 라우터는 다음과 같이 매핑해야 합니다:

```text
WAN TCP 80  -> 서버 TCP 8080
WAN TCP 443 -> 서버 TCP 8443
WAN UDP 443 -> 서버 UDP 8443   # 선택적 HTTP/3
```

서버에 공용 IP가 직접 할당되어 있고 상위 장비에서 포트 변환을 하지 않는다면 기본 호스트 포트 80과 443을 유지하세요. 라우터/NAT 규칙, CGNAT, 클라우드 제공업체 보안 그룹, Split DNS는 설치 프로그램의 제어 범위를 벗어납니다.

설치 프로그램은 기본적으로 방화벽을 변경하지 않습니다. `--configure-firewall`은 UFW가 설치되어 활성화되어 있고 현재 사용자가 사용할 수 있을 때 선택된 HTTP TCP, HTTPS TCP 및 HTTPS UDP 호스트 포트 추가를 시도합니다. UFW를 직접 활성화하거나 firewalld/nftables/클라우드 방화벽을 구성하거나 `lan` 모드를 제한하거나 결과를 검증하거나 `down` 또는 이후의 모드 변경 시 규칙을 제거하지는 않습니다. Docker가 게시하는 포트는 일반 UFW 처리를 우회할 수 있으므로, Docker의 [패킷 필터링 및 UFW 가이드](https://docs.docker.com/engine/network/packet-filtering-firewalls/)를 검토하고 원하는 보안 정책을 독립적으로 적용하세요.

### Cloudflare DDNS

Cloudflare 모드에는 32자의 Zone ID와 DNS 쓰기 권한으로 해당 영역(zone)에 제한된 토큰이 필요합니다. `--skip-ddns-check`를 사용하지 않는 한, 설치 과정에서 구성을 활성화하기 전에 1회 실시간 조회/업데이트를 수행합니다. 이후 실행 중인 사이드카가 저장된 주기에 따라 주기적으로 검사를 진행합니다.

새로운 A/AAAA 레코드는 자동 TTL의 DNS 전용(DNS-only)으로 생성됩니다. 기존 레코드는 내용만 변경하여 업데이트되므로 TTL 및 프록시 설정이 보존됩니다. IPv6 업데이트가 비활성화된 경우 기존 AAAA 레코드는 변경되지 않습니다. 업데이터는 모호한 중복 A/AAAA 레코드 및 동일한 이름의 CNAME 레코드가 있을 경우 작업을 거부합니다. Cloudflare의 DNS 레코드 [조회(lookup)](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/), [생성(create)](https://developers.cloudflare.com/api/typescript/resources/dns/subresources/records/methods/create), [수정(edit)](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/) API를 사용합니다.

### dynv6 DDNS

안내형 `dynv6` 모드는 `dynv6.net` 하위의 호스트네임을 사용합니다. 항상 IPv4를 업데이트하며 선택적으로 IPv6를 업데이트합니다. 두 DDNS 구현 모두 제한된 간격과 요청 타임아웃을 검증하며 후속 주기에서 일시적 오류를 재시도합니다. `--skip-ddns-check`는 활성화 전 1회 작업만 건너뛰며, 스택 시작 후 주기적 업데이터를 비활성화하지는 않습니다.

## 기존 리버스 프록시 연동

`--proxy-type host`를 사용하는 경우 저장된 `--app-port` 값을 사용하여 업스트림을 `http://127.0.0.1:APP_PORT`로 구성하세요. `--proxy-type docker`를 사용하는 경우 지정된 외부 네트워크가 이미 존재해야 합니다. RisuAI만 해당 네트워크에 참여하며, PostgreSQL과 RustFS는 비공개 Compose 네트워크에 유지됩니다. 업스트림 주소는 항상 `http://risuai:6001`입니다.

설치 프로그램은 외부 프록시를 생성, 수정, 리로드하거나 상태를 검사하지 않습니다. TLS, WebSocket 전달, 요청 크기/시간 제한, 인증 등은 해당 프록시에서 직접 구성하세요. 프록시는 클라이언트가 제공한 포워딩 헤더를 신뢰할 수 있는 값으로 덮어써야 합니다. Compose는 Docker 프록시 네트워크를 [기존 외부 네트워크](https://docs.docker.com/compose/how-tos/networking/#use-an-existing-network)로 취급하며 이를 절대 삭제하지 않습니다.

## 관리 명령어

```sh
./risuai.sh start
./risuai.sh stop
./risuai.sh restart
./risuai.sh rebuild
./risuai.sh down
./risuai.sh status
./risuai.sh doctor
./risuai.sh config
./risuai.sh logs [--follow|--no-follow] [--tail N] [SERVICE]
./risuai.sh version
```

- `start`: 저장된 런타임과 모드를 로드하고, 포트와 소유권을 확인하며, 컨테이너를 생성/조정하고, 로컬 이미지가 없는 경우에만 RisuAI를 빌드합니다.
- `stop`: 컨테이너를 삭제하지 않고 중지합니다. 서비스가 `restart: unless-stopped`를 사용하므로 수동으로 중지된 컨테이너는 데몬이 재시작되어도 중지 상태로 유지됩니다.
- `restart`: 기존 컨테이너를 재시작하고 RisuAI 대기를 수행합니다. 수정된 Compose 파일이나 환경 변수 설정은 적용하지 않습니다.
- `rebuild`: RisuAI 애플리케이션만 다시 빌드하고 다시 생성합니다. 소스 업데이트, 이미지 업데이트, 백업 또는 롤백 명령어가 아닙니다.
- `down`: 스택의 컨테이너와 사설 네트워크를 제거하지만 네임드 볼륨, `save/`, `.risuai/`, Caddy 데이터 및 외부 프록시 네트워크는 유지합니다.
- `status`: Compose 상태를 출력하며 설정된 서비스가 중지, 재시작 중이거나 비정상(unhealthy) 상태인 경우 0이 아닌 종료 코드를 반환합니다.
- `doctor`: 체크아웃 파일, Docker/Compose, 보호 상태, 저장된 스키마, 모드별 파일, 외부 프록시 네트워크, Compose 렌더링 및 현재 컨테이너 상태를 검사합니다. 설치된 상태가 아니면 필수 구성 요소만 검사합니다. 따라서 의도적으로 중지되었거나 `down` 상태인 설치본은 런타임 검사 부분을 통과하지 않습니다.
- `config`: 비밀 정보를 가린 채 보호되어 저장된 배포 요약을 출력합니다.
- `logs`: 기본적으로 마지막 200줄을 추적(`--follow`)합니다. 스크립트에서는 `--no-follow` 옵션을 사용하는 것이 적합합니다.

## 헬스 체크 범위

Node 런타임에서 PostgreSQL은 `pg_isready` 헬스 체크를, RisuAI는 내부 HTTP 헬스 체크를 사용합니다. 정적 런타임은 Caddy가 서빙하는 루트 문서를 확인합니다. 에지 Caddy는 RisuAI가 정상 상태가 될 때까지 대기합니다. RustFS는 현재 Compose 헬스 체크가 없으며 RisuAI는 컨테이너 시작 여부에만 의존합니다. DDNS 사이드카 역시 별도의 Docker 헬스 상태가 없습니다. 설치 프로그램의 준비 대기 및 `doctor`는 RisuAI HTTP 응답과 선택된 모든 컨테이너의 실행 여부만 확인하며, 서명된 S3 작업을 수행하거나 외부 DNS, TLS, 라우터 또는 DDNS의 최신 상태를 증명하지는 않습니다. 이러한 검사에는 서비스 로그와 독립적인 외부 모니터링을 활용하세요.

## 백업, 복구 및 삭제

소스 체크아웃 기반의 전체 `risuai.sh` 배포에는 현재 `backup`, `restore`, `update`, `uninstall` 또는 `purge` 명령어가 내장되어 있지 않습니다. 별도의 빠른 Docker 설치본에는 연동된 restic 도우미가 포함되어 있습니다([`deploy/quick/README.ko.md`](../quick/README.ko.md) 참고). 이 고급 설치 프로그램의 경우 `down`은 백업이 아니며 `rebuild`는 업데이트 워크플로가 아닙니다. 이 올인원 배포의 완전한 백업은 활성화된 모든 저장 위치를 포함해야 합니다:

| 데이터 | 백업 요구 사항 |
| --- | --- |
| PostgreSQL | `risuai` 데이터베이스의 일관성 있는 `pg_dump` 또는 관리형 스냅샷 |
| RustFS | `risuai-assets` 버킷의 S3 호환 내보내기/미러링 또는 검증된 오프라인 볼륨 스냅샷 |
| Node 상태 | 전체 `save/` 디렉터리 |
| 배포 인증 정보 | 소유자 전용 권한 또는 강력한 암호화로 보관된 `.risuai/` |
| Caddy 상태 | ACME 계정/인증서 상태 유지를 위한 선택적 Caddy 네임드 볼륨 백업 |

저장소 간 일관된 복구 지점이 필요한 경우 애플리케이션 쓰기 작업을 일시 중지하고 복구 테스트를 별도로 진행하세요. PostgreSQL의 수정 이력(revision history)은 애플리케이션 기능일 뿐 이러한 백업을 대체할 수 없습니다. PostgreSQL, RustFS 및 Caddy 볼륨을 영구적으로 삭제할 명시적인 의도가 없는 한 `docker compose down -v`를 사용하지 마세요.

## Compose 직접 실행

환경 변수 치환을 격리하고 인증 정보를 생성 및 보호하며 소유권과 포트를 검증하고 올바른 오버레이를 선택해 주므로 설치 프로그램을 사용하는 것이 권장됩니다. Compose를 직접 사용하면 이러한 모든 안전장치를 우회하게 됩니다.

기본 파일에는 설치 고유 식별자나 스토리지 인증 정보의 기본값이 의도적으로 지정되어 있지 않습니다. Compose 작업을 직접 수행하기 전에 항상 안정적인 설치 ID와 세 가지 인증 정보를 모두 내보내야(export) 합니다. 아래 값들은 OpenSSL로 생성된 예시입니다. 향후 명령어 실행 및 복구를 위해 안전하게 보관하세요:

```sh
export RISUAI_INSTALLATION_ID="$(openssl rand -hex 16)"
export POSTGRES_PASSWORD="$(openssl rand -hex 32)"
export RUSTFS_ACCESS_KEY="risuai-$(openssl rand -hex 12)"
export RUSTFS_SECRET_KEY="$(openssl rand -hex 32)"

docker compose \
  -f docker-compose.rustfs.yml \
  -f docker-compose.rustfs.local.yml \
  up -d --build
```

원하는 모드에 필요한 오버레이만 정확히 선택하세요. DDNS 오버레이에는 공급자 변수와 읽기 가능한 토큰 파일 경로가 필요합니다. Caddy 오버레이에는 `RISUAI_DOMAIN`이 필요하며, Docker 프록시 오버레이에는 `RISUAI_PROXY_NETWORK`가 필요합니다. 커스텀 호스트 포트는 `RISUAI_PORT`, `RUSTFS_API_PORT`, `RUSTFS_CONSOLE_PORT`, `RISUAI_HTTP_PORT`, `RISUAI_HTTPS_PORT`를 사용합니다. 기본 Compose 파일은 `RISUAI_INSTALLATION_ID`, `POSTGRES_PASSWORD`, `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`를 필요로 하며, 하나라도 누락되면 변수 치환에 실패합니다.

로컬 정적 배포를 직접 실행하는 경우 스토리지 인증 정보가 필요하지 않습니다:

```sh
export RISUAI_INSTALLATION_ID="$(openssl rand -hex 16)"
docker compose \
  -f docker-compose.static.yml \
  -f docker-compose.rustfs.local.yml \
  up -d --build
```
