#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state_dir="$script_dir/.risuai"
env_file="$state_dir/rustfs.env"
token_file="$state_dir/dynv6-token"
compose_base="$script_dir/docker-compose.rustfs.yml"
compose_public="$script_dir/docker-compose.rustfs.dynv6.yml"
assume_yes=false
enable_ipv6=false
domain=${RISUAI_DOMAIN:-${DYNV6_ZONE:-}}
dynv6_token=${DYNV6_TOKEN:-}

info() {
    printf '\n\033[1;34m==>\033[0m %s\n' "$*"
}

die() {
    printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
RisuAI + PostgreSQL + RustFS + dynv6 one-click installer

Usage:
  ./install-rustfs.sh [options]

Options:
  --domain HOSTNAME   dynv6 hostname (for example, my-risu.dynv6.net)
  --token TOKEN       dynv6 HTTP token (prompted securely when omitted)
  --ipv6              Update both IPv4 and IPv6 records
  -y, --yes           Do not ask for confirmation
  -h, --help          Show this help

The server must be reachable from the internet on TCP ports 80 and 443.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --domain)
            [ "$#" -ge 2 ] || die "--domain requires a value"
            domain=$2
            shift 2
            ;;
        --token)
            [ "$#" -ge 2 ] || die "--token requires a value"
            dynv6_token=$2
            shift 2
            ;;
        --ipv6)
            enable_ipv6=true
            shift
            ;;
        -y|--yes)
            assume_yes=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "Unknown option: $1"
            ;;
    esac
done

[ -f "$compose_base" ] || die "Run this installer from a complete RisuAI checkout"
[ -f "$compose_public" ] || die "Missing $compose_public"

if [ -z "$domain" ]; then
    [ -r /dev/tty ] || die "Set RISUAI_DOMAIN or use --domain"
    printf 'dynv6 hostname (example: my-risu.dynv6.net): ' >/dev/tty
    IFS= read -r domain </dev/tty
fi

domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
if [ "${#domain}" -gt 253 ] || ! printf '%s\n' "$domain" | grep -Eq \
    '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
    die "Invalid fully qualified hostname: $domain"
fi

if ! command -v docker >/dev/null 2>&1; then
    die "Docker is not installed. Install Docker Engine with the Compose plugin, then rerun this script."
fi
if ! docker compose version >/dev/null 2>&1; then
    die "The Docker Compose plugin is not installed"
fi
if ! docker info >/dev/null 2>&1; then
    die "Cannot access the Docker daemon. Start Docker or run this script with appropriate permissions."
fi

kernel_socket_details() {
    protocol=$1
    port=$2
    hex_port=$(printf '%04X' "$port")
    for socket_table in /proc/net/"$protocol" /proc/net/"${protocol}6"; do
        [ -r "$socket_table" ] || continue
        awk -v suffix=":$hex_port" -v table="$socket_table" \
            'NR > 1 && toupper($2) ~ (suffix "$") { print "Kernel socket in " table ": " $2 }' \
            "$socket_table"
    done
}

port_details() {
    protocol=$1
    port=$2

    docker ps \
        --filter "publish=$port/$protocol" \
        --format 'Docker container {{.Names}}: {{.Ports}}' 2>/dev/null || true

    if command -v ss >/dev/null 2>&1; then
        if [ "$protocol" = tcp ]; then
            ss -H -ltnp "sport = :$port" 2>/dev/null || true
        else
            ss -H -lunp "sport = :$port" 2>/dev/null || true
        fi
    elif command -v lsof >/dev/null 2>&1; then
        if [ "$protocol" = tcp ]; then
            lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
        else
            lsof -nP -iUDP:"$port" 2>/dev/null || true
        fi
    elif command -v netstat >/dev/null 2>&1; then
        if [ "$protocol" = tcp ]; then
            netstat -lntp 2>/dev/null | awk -v suffix=":$port" '$4 ~ (suffix "$")' || true
        else
            netstat -lnup 2>/dev/null | awk -v suffix=":$port" '$4 ~ (suffix "$")' || true
        fi
    fi

    # /proc remains available when socket tools cannot reveal details due to
    # limited permissions. It also prevents a false negative in that case.
    kernel_socket_details "$protocol" "$port"
}

existing_caddy=$(docker inspect \
    --format '{{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}}' \
    risuai-caddy 2>/dev/null || true)

if [ "$existing_caddy" != "true risuai-rustfs" ]; then
    info "Checking public ports"
    for public_socket in tcp:80 tcp:443 udp:443; do
        protocol=${public_socket%%:*}
        port=${public_socket#*:}
        details=$(port_details "$protocol" "$port")
        if [ -n "$details" ]; then
            printf '%s\n' "$details" >&2
            die "Port $port/$protocol is already in use. Stop or reconfigure it, then rerun the installer. If no process name is shown, inspect it with sudo."
        fi
    done
fi

if [ -z "$dynv6_token" ]; then
    [ -r /dev/tty ] || die "Set DYNV6_TOKEN or use --token"
    printf 'dynv6 HTTP token (input hidden): ' >/dev/tty
    tty_state=$(stty -g </dev/tty)
    trap 'stty "$tty_state" </dev/tty' 0 1 2 15
    stty -echo </dev/tty
    IFS= read -r dynv6_token </dev/tty || true
    stty "$tty_state" </dev/tty
    trap - 0 1 2 15
    printf '\n' >/dev/tty
fi
[ -n "$dynv6_token" ] || die "The dynv6 token cannot be empty"

if [ "$assume_yes" != true ]; then
    cat <<EOF

This will install RisuAI at https://$domain using:
  - PostgreSQL for structured data
  - RustFS for assets
  - Caddy for automatic HTTPS
  - dynv6 updates every 5 minutes

Only ports 80 and 443 will be public. RisuAI (6001) and RustFS (9000/9001)
will listen on localhost for maintenance access.
EOF
    printf 'Continue? [Y/n] ' >/dev/tty
    IFS= read -r answer </dev/tty
    case "$answer" in
        n|N|no|NO) exit 0 ;;
    esac
fi

random_secret() {
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32
    else
        od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
    fi
}

read_env_value() {
    key=$1
    [ -f "$env_file" ] || return 0
    sed -n "s/^${key}=//p" "$env_file" | tail -n 1
}

postgres_password=$(read_env_value POSTGRES_PASSWORD)
rustfs_access_key=$(read_env_value RUSTFS_ACCESS_KEY)
rustfs_secret_key=$(read_env_value RUSTFS_SECRET_KEY)
[ -n "$postgres_password" ] || postgres_password=$(random_secret)
[ -n "$rustfs_access_key" ] || rustfs_access_key="risuai-$(random_secret | cut -c1-24)"
[ -n "$rustfs_secret_key" ] || rustfs_secret_key=$(random_secret)

info "Writing protected deployment configuration"
umask 077
mkdir -p "$state_dir"
printf '%s' "$dynv6_token" >"$token_file"
cat >"$env_file" <<EOF
COMPOSE_PROJECT_NAME=risuai-rustfs
POSTGRES_PASSWORD=$postgres_password
RUSTFS_ACCESS_KEY=$rustfs_access_key
RUSTFS_SECRET_KEY=$rustfs_secret_key
RUSTFS_BIND_ADDRESS=127.0.0.1
RISUAI_BIND_ADDRESS=127.0.0.1
RISUAI_DOMAIN=$domain
DYNV6_ZONE=$domain
DYNV6_IPV6=$enable_ipv6
DYNV6_TOKEN_FILE=./.risuai/dynv6-token
DYNV6_UPDATE_INTERVAL=300
EOF
chmod 600 "$env_file" "$token_file"

compose() {
    docker compose \
        --project-directory "$script_dir" \
        --env-file "$env_file" \
        -f "$compose_base" \
        -f "$compose_public" \
        "$@"
}

info "Validating the Compose configuration"
compose config --quiet

info "Checking the dynv6 hostname and token"
if ! compose run --rm -e DYNV6_ONCE=true dynv6; then
    die "dynv6 rejected the update. Check the hostname, token, and internet connection."
fi

info "Starting dynv6 updater"
compose up -d dynv6
sleep 2
if ! compose ps --status running --services | grep -qx dynv6; then
    compose logs --no-color --tail 30 dynv6 >&2 || true
    die "The dynv6 updater did not start"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    info "Allowing HTTP and HTTPS through UFW"
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
fi

info "Building and starting RisuAI (the first build can take several minutes)"
compose up -d --build

info "Waiting for RisuAI"
attempt=0
until docker exec risuai node -e \
    "fetch('http://127.0.0.1:6001').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
    >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then
        compose logs --no-color --tail 80 risuai >&2 || true
        die "RisuAI did not become ready within 5 minutes"
    fi
    sleep 5
done

cat <<EOF

RisuAI is running.

  URL:            https://$domain
  RustFS console: http://127.0.0.1:9001 (use an SSH tunnel remotely)
  Config:         $env_file

DNS propagation and the first TLS certificate can take a few minutes.
View status with:
  docker compose --env-file '$env_file' -f '$compose_base' -f '$compose_public' ps
EOF
