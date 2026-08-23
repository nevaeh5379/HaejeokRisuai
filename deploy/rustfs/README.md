# RisuAI PostgreSQL + RustFS deployment

`risuai.sh` is the guided installer and lifecycle manager for the RisuAI,
PostgreSQL, and RustFS Compose stack. It selects only the networking and DDNS
services required by the saved deployment mode. Run it from a source checkout
with a local Docker Engine or Docker Desktop daemon and Docker Compose v2:

```sh
./risuai.sh install
```

The script rejects remote Docker contexts because the stack uses paths and port
checks on the local host. The interactive default is `local`; a reinstall with
a valid saved configuration keeps the saved mode and credentials by default.

## Deployment modes

| Mode | Published access | Extra services |
| --- | --- | --- |
| `local` | Loopback HTTP, `http://localhost:6001` by default | None |
| `lan` | Plain HTTP on every IPv4 interface, port 6001 by default | None |
| `domain` | Caddy HTTPS for a manually managed or Cloudflare-managed hostname | Caddy and, optionally, Cloudflare DDNS |
| `dynv6` | Caddy HTTPS for a hostname below `dynv6.net` | Caddy and dynv6 DDNS |
| `proxy` | An existing host or Docker reverse proxy | No bundled proxy |

PostgreSQL is not published. The installer always binds the RustFS S3 API and
console to IPv4 loopback, including in `lan` mode. In `domain` and `dynv6`
modes, RisuAI also has a loopback-only maintenance mapping while Caddy receives
the public mappings.

`lan` is not restricted to a private subnet: `0.0.0.0` means every IPv4
interface on the host. Use this mode only when the host network and upstream
firewalls already limit access to trusted clients.

## Installer options

Run `./risuai.sh help` for the authoritative command summary. The principal
install options are:

| Purpose | Options |
| --- | --- |
| Mode | `--mode`, `--domain`, `--dns-provider`, `--proxy-type`, `--proxy-network` |
| DDNS credentials | `--dynv6-token-file`, `--cloudflare-token-file`, `--cloudflare-zone-id` |
| DDNS behavior | `--ddns-interval`, `--ipv6`, `--no-ipv6`, `--skip-ddns-check` |
| Host ports | `--app-port`, `--rustfs-api-port`, `--rustfs-console-port`, `--http-port`, `--https-port` |
| Validation and execution | `--wait-timeout`, `--skip-port-check`, `--dry-run`, `--no-start`, `--configure-firewall`, `--adopt-existing`, `--yes` |

Ports must be in `1..65535`, cannot conflict within the selected layout, and
are saved for later management commands. The defaults are app 6001, RustFS API
9000, RustFS console 9001, Caddy HTTP 80, and Caddy HTTPS/HTTP3 443.
`--http-port` and `--https-port` are valid only for `domain` or `dynv6`.
Docker-proxy mode has no app host mapping and always uses the internal upstream
`risuai:6001`, so `--app-port` must remain 6001 in that mode.

`--ddns-interval` accepts 60 through 86400 seconds. `--ipv6` adds an AAAA
update; it does not make the deployment IPv6-only, because both bundled DDNS
updaters still update IPv4. The updater container itself must have working IPv6
connectivity for an AAAA update to succeed.

### Token input

Token files are preferred because token values passed in command arguments are
visible in process listings and may be retained in shell history. The installer
reads the first line of the supplied file, validates it, and copies the value
into a mode-specific file under `.risuai/`. The source file is not mounted into
the running container.

`DYNV6_TOKEN` and `CLOUDFLARE_TOKEN` environment variables are also accepted.
`--dynv6-token`, its legacy `--token` alias, and `--cloudflare-token` remain
available for compatibility but emit a warning. Reinstalling the same mode
reuses the protected saved token unless a replacement is explicitly supplied.

## Examples

```sh
# Local-only installation
./risuai.sh install --mode local -y

# LAN HTTP on a custom application port
./risuai.sh install --mode lan --app-port 7000 -y

# Domain whose A/AAAA records are managed outside this installer
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider manual -y

# Domain with Cloudflare DDNS
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider cloudflare \
  --cloudflare-zone-id 0123456789abcdef0123456789abcdef \
  --cloudflare-token-file /run/secrets/cloudflare-token \
  --ipv6 -y

# dynv6 DDNS
./risuai.sh install --mode dynv6 --domain my-chat.dynv6.net \
  --dynv6-token-file /run/secrets/dynv6-token --ipv6 -y

# Reverse proxy installed directly on this host
./risuai.sh install --mode proxy --proxy-type host \
  --app-port 7000 -y

# Reverse proxy running on an existing Docker network
docker network create reverse-proxy
./risuai.sh install --mode proxy --proxy-type docker \
  --proxy-network reverse-proxy -y
```

Preview the same validation and plan without changing configuration, DNS,
firewall rules, images, or containers:

```sh
./risuai.sh install --mode domain --domain chat.example.com \
  --dns-provider manual --dry-run
```

`--dry-run` still needs a working local Docker daemon and performs ownership,
port, saved-state, and Compose validation. `--skip-port-check` is an escape
hatch for platforms where host socket discovery is unavailable; it does not
make a conflicting Docker mapping work.

`--no-start` validates and saves the configuration but skips the image build,
one-shot DDNS check, container reconciliation, and readiness wait. The next
`start` builds the local RisuAI image if it is missing. If `--no-start` is used
to change an already-running installation, the existing containers continue
with their old configuration until `down`/`start` or another install reconciles
them. `--configure-firewall` can still change UFW when combined with
`--no-start`, so omit it when only staging configuration.

`--adopt-existing` is a recovery option, not a normal install option. Use it
only after confirming that legacy containers or the fixed
`risuai-rustfs_*` volumes belong to this installation and that the original
PostgreSQL and RustFS credentials are available. The installer otherwise
refuses to generate new credentials over existing data.

## Protected state and transaction scope

The installer keeps its configuration in `.risuai/` beside the script. It:

- creates the directory with mode `0700` and configuration/token files with
  mode `0600`;
- rejects symbolic links, foreign-owned state paths, invalid configuration
  combinations, and unsafe credential characters;
- isolates Compose interpolation from unrelated shell variables and fixes the
  Compose project name;
- assigns a stable 32-character installation ID to service labels and refuses
  containers owned by another checkout;
- serializes mutating operations with an operation lock.

These are filesystem permission controls, not encryption. Backups containing
`.risuai/rustfs.env` or token files must receive equivalent protection. Fixed
Compose project and container names also mean that the guided stack supports
one such installation per Docker daemon.

For a normal install or reinstall, the script validates the prospective
Compose model, builds RisuAI, and performs the requested one-shot DDNS update
before activating new protected files. It then snapshots the previous env and
token files, activates the new generation, starts Compose, and waits for the
internal RisuAI readiness check. If activation or startup fails, it restores
the previous protected files and attempts to restart the previous deployment
when it had been running.

That rollback does **not** restore persistent application data, undo a DNS
update, remove a newly built image, or reverse database migrations that already
ran. UFW changes occur only after the configuration transaction commits and
are not rolled back or later removed by the script. Take a real backup before
upgrades, migrations, or risky mode changes.

Existing PostgreSQL and RustFS credentials cannot be rotated by reinstalling;
the script refuses changed values because both services require dedicated
rotation procedures.

## DNS, TLS, routers, and firewalls

For manual DNS, create an A record and add an AAAA record only when end-to-end
IPv6 is usable. The installer validates the hostname and Compose model but does
not prove public DNS propagation, router reachability, cloud-firewall policy,
or successful external TLS access.

Caddy's automatic certificate flows need the service to be publicly reachable
on the standard ports. With the default host mappings, forward public TCP 80 to
host TCP 80 and public TCP 443 to host TCP 443. UDP 443 is optional and enables
HTTP/3; ordinary HTTPS uses TCP 443. See Caddy's
[automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https).

Custom `--http-port` and `--https-port` values change the **host-side** Docker
mappings, not the public ACME ports. For example, with `--http-port 8080
--https-port 8443`, a router should map:

```text
WAN TCP 80  -> server TCP 8080
WAN TCP 443 -> server TCP 8443
WAN UDP 443 -> server UDP 8443   # optional HTTP/3
```

If the server is directly assigned the public address and no upstream device
translates ports, retain host ports 80 and 443. Router/NAT rules, CGNAT,
provider security groups, and split DNS are outside the installer's control.

The installer changes no firewall by default. `--configure-firewall` makes a
best-effort attempt to add the selected HTTP TCP, HTTPS TCP, and HTTPS UDP host
ports when UFW is installed, active, and usable by the current user. It does
not enable UFW, configure firewalld/nftables/cloud firewalls, restrict `lan`
mode, verify the result, or remove rules during `down` or a later mode change.
Docker-published ports can bypass ordinary UFW processing; review Docker's
[packet filtering and UFW guidance](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
and enforce the intended policy independently.

### Cloudflare DDNS

Cloudflare mode requires a 32-character Zone ID and a token limited to the zone
with DNS Write permission. Unless `--skip-ddns-check` is used, installation
performs one live lookup/update before activating the configuration. The
running sidecar then checks periodically using the saved interval.

New A/AAAA records are DNS-only with automatic TTL. Existing records are
updated by changing only their content, preserving TTL and proxy settings. An
existing AAAA record is left unchanged when IPv6 updates are disabled. The
updater refuses ambiguous duplicate A/AAAA records and a CNAME at the same
name. It uses Cloudflare's DNS record
[lookup](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/list/),
[create](https://developers.cloudflare.com/api/typescript/resources/dns/subresources/records/methods/create),
and [edit](https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/)
APIs.

### dynv6 DDNS

The guided `dynv6` mode accepts a hostname below `dynv6.net`. It always updates
IPv4 and optionally updates IPv6. Both DDNS implementations validate bounded
intervals and request timeouts and retry transient failures in later cycles.
`--skip-ddns-check` skips only the pre-activation one-shot operation; it does
not disable the periodic updater after the stack starts.

## Existing reverse proxies

With `--proxy-type host`, configure the upstream as
`http://127.0.0.1:APP_PORT`, using the saved `--app-port` value. With
`--proxy-type docker`, the named external network must already exist. Only
RisuAI joins that network; PostgreSQL and RustFS remain on the private Compose
network. The upstream is always `http://risuai:6001`.

The installer does not create, edit, reload, or health-check the external
proxy. Configure TLS, WebSocket forwarding, request-size/time limits, and
authentication there. The proxy must overwrite client-supplied forwarded
headers with trusted values. Compose treats the Docker proxy network as an
[existing external network](https://docs.docker.com/compose/how-tos/networking/#use-an-existing-network)
and never deletes it.

## Management commands

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

- `start` loads the saved mode, checks ports and ownership, creates/reconciles
  containers, and builds RisuAI only when its local image is missing.
- `stop` stops containers without deleting them. Services use
  `restart: unless-stopped`, so a manual stop remains stopped across daemon
  restarts.
- `restart` restarts existing containers and waits for RisuAI; it does not
  apply edited Compose or environment settings.
- `rebuild` rebuilds and recreates only the RisuAI application. It is not a
  source updater, image updater, backup, or rollback command.
- `down` removes the stack's containers and private networks but keeps named
  volumes, `save/`, `.risuai/`, Caddy data, and any external proxy network.
- `status` prints Compose state and returns nonzero when a configured service
  is stopped, restarting, or reports unhealthy.
- `doctor` checks checkout files, Docker/Compose, protected state, the saved
  schema, mode-specific files, the external proxy network, Compose rendering,
  and current container state. With no installation it checks prerequisites
  only. An intentionally stopped/down installation therefore does not pass the
  runtime portion.
- `config` prints the protected saved deployment summary without rendering
  secrets.
- `logs` follows the last 200 lines by default; `--no-follow` is suitable for
  scripts.

## Health-check scope

PostgreSQL has a `pg_isready` healthcheck and RisuAI has an internal HTTP
healthcheck. Caddy waits for RisuAI to be healthy. RustFS currently has no
Compose healthcheck and RisuAI depends only on its container having started;
the DDNS sidecars also have no Docker health status. Installer readiness and
`doctor` confirm the RisuAI HTTP response plus that all selected containers are
running, but they do not perform a signed S3 operation or prove external DNS,
TLS, router, or DDNS freshness. Use service logs and independent external
monitoring for those checks.

## Backups, recovery, and removal

The full source-checkout `risuai.sh` deployment currently has no `backup`,
`restore`, `update`, `uninstall`, or `purge` command. The separate quick Docker
installation includes a coordinated restic helper; see
[`deploy/quick/README.md`](../quick/README.md). For this advanced installer,
`down` is not a backup and `rebuild` is not an update workflow. A complete
backup of this all-in-one deployment must cover every active storage location:

| Data | Backup requirement |
| --- | --- |
| PostgreSQL | A consistent `pg_dump`/managed snapshot of the `risuai` database |
| RustFS | An S3-compatible export/mirror of the `risuai-assets` bucket, or a verified offline volume snapshot |
| Node state | The entire `save/` directory |
| Deployment credentials | `.risuai/`, stored with owner-only permissions or stronger encryption |
| Caddy state | Optional backup of the Caddy named volumes to retain ACME account/certificate state |

Quiesce application writes when a cross-store consistent recovery point is
required, and test restoration separately. PostgreSQL revision history is an
application feature, not a replacement for these backups. Do not use `docker
compose down -v` unless permanent deletion of the PostgreSQL, RustFS, and Caddy
volumes is explicitly intended.

## Running Compose directly

The installer is recommended because it isolates environment interpolation,
generates and protects credentials, validates ownership and ports, and selects
the correct overlays. Direct Compose use bypasses all of those safeguards.

The base file intentionally has no default installation identity or storage
credentials. Export a stable installation ID and all three credentials before
every direct Compose operation. The values below are examples generated with
OpenSSL; retain them securely for future commands and recovery:

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

Choose exactly the overlays required by the desired mode. DDNS overlays also
need their provider variables and readable token-file paths; the Caddy overlay
needs `RISUAI_DOMAIN`; the Docker-proxy overlay needs
`RISUAI_PROXY_NETWORK`. Custom host ports use `RISUAI_PORT`,
`RUSTFS_API_PORT`, `RUSTFS_CONSOLE_PORT`, `RISUAI_HTTP_PORT`, and
`RISUAI_HTTPS_PORT`. The base Compose file requires
`RISUAI_INSTALLATION_ID`, `POSTGRES_PASSWORD`, `RUSTFS_ACCESS_KEY`, and
`RUSTFS_SECRET_KEY` and will fail interpolation when any is absent.
