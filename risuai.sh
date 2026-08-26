#!/bin/sh
set -eu

# RisuAI Node/storage or static-web installer and lifecycle manager.
# Keep this file POSIX-sh compatible: it is used on Linux, macOS, and WSL.

program_version=2.2.0
config_version=3
project_name=risuai-rustfs

resolve_script_path() {
    resolved_path=$1
    case "$resolved_path" in
        */*) ;;
        *)
            command_path=$(command -v "$resolved_path" 2>/dev/null || true)
            [ -n "$command_path" ] && resolved_path=$command_path
            ;;
    esac
    case "$resolved_path" in
        /*) ;;
        *) resolved_path=$PWD/$resolved_path ;;
    esac

    link_count=0
    while [ -L "$resolved_path" ]; do
        command -v readlink >/dev/null 2>&1 || break
        link_target=$(readlink "$resolved_path") || break
        case "$link_target" in
            /*) resolved_path=$link_target ;;
            *) resolved_path=${resolved_path%/*}/$link_target ;;
        esac
        link_count=$((link_count + 1))
        [ "$link_count" -lt 40 ] || {
            printf 'Error: too many symbolic links while resolving %s\n' "$1" >&2
            exit 1
        }
    done

    resolved_dir=${resolved_path%/*}
    resolved_name=${resolved_path##*/}
    [ "$resolved_dir" != "$resolved_path" ] || resolved_dir=.
    resolved_dir=$(CDPATH='' cd -P "$resolved_dir" 2>/dev/null && pwd) || {
        printf 'Error: cannot resolve the directory containing %s\n' "$1" >&2
        exit 1
    }
    printf '%s/%s\n' "$resolved_dir" "$resolved_name"
}

script_path=$(resolve_script_path "$0")
script_dir=${script_path%/*}
state_dir=$script_dir/.risuai
env_file=$state_dir/rustfs.env
dynv6_token_file=$state_dir/dynv6-token
cloudflare_token_file=$state_dir/cloudflare-token
lock_dir=$state_dir/operation.lock

compose_base=$script_dir/docker-compose.rustfs.yml
compose_static=$script_dir/docker-compose.static.yml
compose_local=$script_dir/docker-compose.rustfs.local.yml
compose_lan=$script_dir/docker-compose.rustfs.lan.yml
compose_caddy=$script_dir/docker-compose.rustfs.caddy.yml
compose_dynv6=$script_dir/docker-compose.rustfs.dynv6.yml
compose_cloudflare=$script_dir/docker-compose.rustfs.cloudflare.yml
compose_proxy_docker=$script_dir/docker-compose.rustfs.proxy-docker.yml

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != dumb ]; then
    color_blue='\033[1;34m'
    color_yellow='\033[1;33m'
    color_red='\033[1;31m'
    color_green='\033[1;32m'
    color_reset='\033[0m'
else
    color_blue=
    color_yellow=
    color_red=
    color_green=
    color_reset=
fi

info() { printf '\n%b==>%b %s\n' "$color_blue" "$color_reset" "$*"; }
ok() { printf '%bOK:%b %s\n' "$color_green" "$color_reset" "$*"; }
warn() { printf '%bWarning:%b %s\n' "$color_yellow" "$color_reset" "$*" >&2; }
error() { printf '%bError:%b %s\n' "$color_red" "$color_reset" "$*" >&2; }
die() { error "$*"; exit 1; }

usage() {
    cat <<'EOF'
RisuAI Node/storage or static-web installer and manager

Usage:
  ./risuai.sh [install] [options]
  ./risuai.sh start|stop|restart|rebuild|down|status|doctor|config
  ./risuai.sh logs [--follow|--no-follow] [--tail N] [SERVICE]
  ./risuai.sh db status|password|sync-password|shell|backup|optimize
  ./risuai.sh help|version

Deployment modes:
  local    This machine only, over loopback HTTP
  lan      All IPv4 interfaces, over unencrypted HTTP
  domain   Caddy HTTPS with manual DNS or Cloudflare DDNS
  dynv6    Caddy HTTPS with dynv6 DDNS
  proxy    An existing reverse proxy on the host or a Docker network

Application runtimes:
  node     Node server with PostgreSQL and RustFS (default)
  static   Browser-only web build served by Caddy; no Node server or storage services

Database management:
  db status                         Check PostgreSQL health, credentials, version, and size
  db password [--generate]          Change the database password and update RisuAI safely
  db sync-password                  Repair a saved-password/database-password mismatch
  db shell                          Open an interactive PostgreSQL shell
  db backup [FILE]                  Create a PostgreSQL custom-format backup
  db optimize                       Run VACUUM (ANALYZE) on the RisuAI database

Install options:
  --runtime RUNTIME               node or static (default: node)
  --mode MODE                     local, lan, domain, dynv6, or proxy
  --domain HOSTNAME               HTTPS hostname (a trailing dot is accepted)
  --dns-provider PROVIDER         manual or cloudflare (domain mode)
  --cloudflare-zone-id ID         32-character Cloudflare Zone ID
  --cloudflare-token-file FILE    Read the Cloudflare API token from FILE
  --cloudflare-token TOKEN        Deprecated; token is visible in process argv
  --dynv6-token-file FILE         Read the dynv6 HTTP token from FILE
  --dynv6-token TOKEN             Deprecated; token is visible in process argv
  --token TOKEN                   Compatibility alias for --dynv6-token
  --proxy-type TYPE               host or docker
  --proxy-network NAME            Existing external Docker network
  --app-port PORT                 Published RisuAI host port (default: 6001)
  --rustfs-api-port PORT          Loopback RustFS API port (default: 9000)
  --rustfs-console-port PORT      Loopback RustFS console port (default: 9001)
  --http-port PORT                Caddy HTTP host port (default: 80)
  --https-port PORT               Caddy HTTPS/HTTP3 host port (default: 443)
  --ddns-interval SECONDS         DDNS interval, 60..86400 (default: 300)
  --ipv6 | --no-ipv6              Enable or disable AAAA updates
  --wait-timeout SECONDS          App readiness timeout, 10..3600 (default: 300)
  --skip-ddns-check               Skip the one-shot provider validation/update
  --skip-port-check               Rely on Docker instead of host preflight checks
  --configure-firewall            Best-effort UFW rules for 80/443 host mappings
  --no-start                      Save validated configuration without building/starting
  --dry-run                       Validate and show the plan without persistent changes
  --adopt-existing               Explicitly adopt matching legacy containers/volumes
  -y, --yes                       Accept the displayed installation plan
  --no-color                      Disable colored output
  -h, --help                      Show this help

Environment inputs:
  RISUAI_RUNTIME, RISUAI_MODE, RISUAI_DOMAIN, RISUAI_DNS_PROVIDER, RISUAI_PROXY_TYPE,
  RISUAI_PROXY_NETWORK, RISUAI_PORT, RUSTFS_API_PORT,
  RUSTFS_CONSOLE_PORT, RISUAI_HTTP_PORT, RISUAI_HTTPS_PORT,
  RISUAI_WAIT_TIMEOUT, DYNV6_TOKEN, CLOUDFLARE_TOKEN,
  CLOUDFLARE_ZONE_ID, POSTGRES_PASSWORD, RUSTFS_ACCESS_KEY,
  RUSTFS_SECRET_KEY

Existing settings, generated credentials, and provider tokens are preserved on
reinstall unless an explicit replacement is supplied. Provider token files are
safer than command-line token values.

Examples:
  ./risuai.sh install --mode local -y
  ./risuai.sh install --runtime static --mode local -y
  ./risuai.sh install --runtime static --mode domain --domain chat.example.com \
    --dns-provider manual -y
  ./risuai.sh install --mode lan --app-port 7000 -y
  ./risuai.sh install --mode domain --domain chat.example.com \
    --dns-provider manual -y
  ./risuai.sh install --mode domain --domain chat.example.com \
    --dns-provider cloudflare --cloudflare-zone-id 0123456789abcdef0123456789abcdef \
    --cloudflare-token-file /run/secrets/cloudflare-token -y
  ./risuai.sh install --mode dynv6 --domain chat.dynv6.net \
    --dynv6-token-file /run/secrets/dynv6-token --ipv6 -y
  ./risuai.sh install --mode proxy --proxy-type docker \
    --proxy-network reverse-proxy -y
EOF
}

short_usage() {
    printf 'Usage: %s [install|start|stop|restart|rebuild|down|status|logs|doctor|config|db|help|version]\n' "${0##*/}" >&2
}

# Capture user inputs, then remove deployment interpolation variables from the
# inherited environment. compose_with_env supplies a complete validated
# snapshot, so environment precedence cannot alter a saved deployment.
input_mode=${RISUAI_MODE:-}
input_runtime=${RISUAI_RUNTIME:-}
input_domain=${RISUAI_DOMAIN:-${DYNV6_ZONE:-}}
input_dns_provider=${RISUAI_DNS_PROVIDER:-}
input_proxy_type=${RISUAI_PROXY_TYPE:-}
input_proxy_network=${RISUAI_PROXY_NETWORK:-}
input_cloudflare_zone_id=${CLOUDFLARE_ZONE_ID:-}
input_cloudflare_token=${CLOUDFLARE_TOKEN:-}
input_dynv6_token=${DYNV6_TOKEN:-}
input_app_port=${RISUAI_PORT:-}
input_rustfs_api_port=${RUSTFS_API_PORT:-}
input_rustfs_console_port=${RUSTFS_CONSOLE_PORT:-}
input_http_port=${RISUAI_HTTP_PORT:-}
input_https_port=${RISUAI_HTTPS_PORT:-}
input_wait_timeout=${RISUAI_WAIT_TIMEOUT:-}
input_ddns_interval=${RISUAI_DDNS_INTERVAL:-}
[ -n "$input_ddns_interval" ] || input_ddns_interval=${DYNV6_UPDATE_INTERVAL:-${CLOUDFLARE_UPDATE_INTERVAL:-}}
input_ipv6=${RISUAI_IPV6:-}
[ -n "$input_ipv6" ] || input_ipv6=${DYNV6_IPV6:-${CLOUDFLARE_IPV6:-}}
input_postgres_password=${POSTGRES_PASSWORD:-}
input_rustfs_access_key=${RUSTFS_ACCESS_KEY:-}
input_rustfs_secret_key=${RUSTFS_SECRET_KEY:-}

unset COMPOSE_FILE COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_ENV_FILES
unset RISUAI_RUNTIME RISUAI_MODE RISUAI_DOMAIN RISUAI_DNS_PROVIDER RISUAI_PROXY_TYPE RISUAI_PROXY_NETWORK
unset RISUAI_PORT RISUAI_HTTP_PORT RISUAI_HTTPS_PORT RISUAI_INSTALLATION_ID RISUAI_MIGRATE_CONCURRENCY
unset RUSTFS_BIND_ADDRESS RUSTFS_API_PORT RUSTFS_CONSOLE_PORT
unset POSTGRES_PASSWORD RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY
unset DYNV6_ZONE DYNV6_TOKEN DYNV6_TOKEN_FILE DYNV6_IPV6 DYNV6_UPDATE_INTERVAL
unset CLOUDFLARE_TOKEN CLOUDFLARE_TOKEN_FILE CLOUDFLARE_ZONE_ID CLOUDFLARE_IPV6 CLOUDFLARE_UPDATE_INTERVAL

action=install
case "${1:-}" in
    install|start|stop|restart|rebuild|down|status|logs|doctor|config|db|help|version)
        action=$1
        shift
        ;;
    '') ;;
    -*) ;;
    *) short_usage; die "Unknown command: $1" ;;
esac

if [ "$action" = help ]; then
    [ "$#" -eq 0 ] || die "help does not accept arguments"
    usage
    exit 0
fi
if [ "$action" = version ]; then
    [ "$#" -eq 0 ] || die "version does not accept arguments"
    printf 'risuai.sh %s (configuration schema %s)\n' "$program_version" "$config_version"
    exit 0
fi

read_env_value_from() {
    read_file=$1
    read_key=$2
    [ -f "$read_file" ] || return 0
    awk -v wanted="$read_key" '
        index($0, wanted "=") == 1 {
            value = substr($0, length(wanted) + 2)
            sub(/\r$/, "", value)
            found = 1
        }
        END { if (found) printf "%s", value }
    ' "$read_file"
}

env_value_or() {
    value_file=$1
    value_key=$2
    value_default=$3
    value_result=$(read_env_value_from "$value_file" "$value_key")
    [ -n "$value_result" ] || value_result=$value_default
    printf '%s' "$value_result"
}

replace_env_value() {
    replace_file=$1
    replace_key=$2
    replace_value=$3
    replace_tmp=${replace_file}.tmp.$$
    awk -v wanted="$replace_key" -v replacement="$replace_value" '
        BEGIN { found = 0 }
        index($0, wanted "=") == 1 {
            print wanted "=" replacement
            found = 1
            next
        }
        { print }
        END { if (!found) print wanted "=" replacement }
    ' "$replace_file" >"$replace_tmp" || { rm -f "$replace_tmp"; return 1; }
    chmod 600 "$replace_tmp" || { rm -f "$replace_tmp"; return 1; }
    mv -f "$replace_tmp" "$replace_file"
}

stored_mode_from() {
    mode_file=$1
    mode_value=$(read_env_value_from "$mode_file" RISUAI_MODE)
    if [ -n "$mode_value" ]; then
        printf '%s' "$mode_value"
        return
    fi

    # A truncated env file must never silently become a public deployment.
    legacy_zone=$(read_env_value_from "$mode_file" DYNV6_ZONE)
    legacy_token_path=$(read_env_value_from "$mode_file" DYNV6_TOKEN_FILE)
    if [ -n "$legacy_zone" ] && [ -n "$legacy_token_path" ] && [ -s "$dynv6_token_file" ]; then
        printf 'dynv6'
    fi
}

stored_runtime_from() {
    runtime_file=$1
    runtime_value=$(read_env_value_from "$runtime_file" RISUAI_RUNTIME)
    [ -n "$runtime_value" ] || runtime_value=node
    printf '%s' "$runtime_value"
}

compose_base_for_runtime() {
    case "$1" in
        node) printf '%s' "$compose_base" ;;
        static) printf '%s' "$compose_static" ;;
        *) return 1 ;;
    esac
}

image_for_runtime() {
    case "$1" in
        node) printf 'risuai-full:local' ;;
        static) printf 'risuai-static:local' ;;
        *) return 1 ;;
    esac
}

is_valid_port() {
    candidate_port=$1
    case "$candidate_port" in ''|*[!0-9]*) return 1 ;; esac
    [ "${#candidate_port}" -le 5 ] || return 1
    awk -v port="$candidate_port" 'BEGIN { exit !(port >= 1 && port <= 65535) }'
}

normalize_port() {
    normalize_candidate=$1
    is_valid_port "$normalize_candidate" || die "Invalid port: $normalize_candidate (expected 1..65535)"
    awk -v port="$normalize_candidate" 'BEGIN { printf "%.0f", port }'
}

is_valid_integer_range() {
    integer_value=$1
    integer_min=$2
    integer_max=$3
    case "$integer_value" in ''|*[!0-9]*) return 1 ;; esac
    awk -v value="$integer_value" -v minimum="$integer_min" -v maximum="$integer_max" \
        'BEGIN { exit !(value >= minimum && value <= maximum) }'
}

normalize_bool() {
    case "$1" in
        true|TRUE|True|yes|YES|Yes|1|on|ON) printf 'true' ;;
        false|FALSE|False|no|NO|No|0|off|OFF) printf 'false' ;;
        *) return 1 ;;
    esac
}

is_safe_scalar() {
    scalar_value=$1
    # printf adds no newline, so any counted line feed came from the value.
    [ "$(printf '%s' "$scalar_value" | wc -l | tr -d '[:space:]')" = 0 ] || return 1
    ! printf '%s' "$scalar_value" | LC_ALL=C grep -q '[[:cntrl:]]'
}

normalize_hostname() {
    normalized_hostname=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
    case "$normalized_hostname" in *.) normalized_hostname=${normalized_hostname%.} ;; esac
    printf '%s' "$normalized_hostname"
}

is_valid_hostname() {
    hostname_value=$1
    [ -n "$hostname_value" ] || return 1
    is_safe_scalar "$hostname_value" || return 1
    [ "${#hostname_value}" -le 253 ] || return 1
    case "$hostname_value" in *.*) ;; *) return 1 ;; esac
    printf '%s\n' "$hostname_value" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$' || return 1
    printf '%s\n' "$hostname_value" | grep -Eq '^[0-9.]+$' && return 1
    return 0
}

is_valid_proxy_network() {
    network_value=$1
    [ -n "$network_value" ] || return 1
    is_safe_scalar "$network_value" || return 1
    [ "${#network_value}" -le 255 ] || return 1
    printf '%s\n' "$network_value" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$'
}

is_safe_credential() {
    credential_value=$1
    [ -n "$credential_value" ] || return 1
    is_safe_scalar "$credential_value" || return 1
    printf '%s\n' "$credential_value" | grep -Eq '^[A-Za-z0-9._~-]+$'
}

is_valid_secret() {
    secret_value=$1
    [ -n "$secret_value" ] || return 1
    is_safe_scalar "$secret_value" || return 1
    [ "$secret_value" = "$(printf '%s' "$secret_value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')" ] || return 1
    ! printf '%s' "$secret_value" | LC_ALL=C grep -q '[[:cntrl:]]'
}

file_mode() {
    mode_path=$1
    if stat -c '%a' "$mode_path" >/dev/null 2>&1; then
        stat -c '%a' "$mode_path"
    elif stat -f '%Lp' "$mode_path" >/dev/null 2>&1; then
        stat -f '%Lp' "$mode_path"
    else
        printf 'unknown'
    fi
}

file_owner_id() {
    owner_path=$1
    if stat -c '%u' "$owner_path" >/dev/null 2>&1; then
        stat -c '%u' "$owner_path"
    elif stat -f '%u' "$owner_path" >/dev/null 2>&1; then
        stat -f '%u' "$owner_path"
    else
        printf 'unknown'
    fi
}

validate_state_security() {
    [ -d "$state_dir" ] || { error "State directory is missing: $state_dir"; return 1; }
    [ ! -L "$state_dir" ] || { error "State directory must not be a symbolic link: $state_dir"; return 1; }
    current_uid=$(id -u 2>/dev/null || printf 'unknown')
    state_uid=$(file_owner_id "$state_dir")
    if [ "$current_uid" = unknown ] || [ "$state_uid" = unknown ] || [ "$state_uid" != "$current_uid" ]; then
        error "State directory owner UID is $state_uid; current UID is $current_uid"
        return 1
    fi
    for secure_path in "$env_file" "$dynv6_token_file" "$cloudflare_token_file"; do
        if [ ! -e "$secure_path" ] && [ ! -L "$secure_path" ]; then continue; fi
        [ -f "$secure_path" ] || { error "Protected state path is not a regular file: $secure_path"; return 1; }
        [ ! -L "$secure_path" ] || { error "Protected state path must not be a symbolic link: $secure_path"; return 1; }
        secure_uid=$(file_owner_id "$secure_path")
        [ "$secure_uid" = "$current_uid" ] || { error "Protected state file has a different owner: $secure_path"; return 1; }
    done
    return 0
}

validate_state_permissions() {
    [ "$(file_mode "$state_dir")" = 700 ] || { error "State directory must have mode 0700: $state_dir"; return 1; }
    for permission_path in "$env_file" "$dynv6_token_file" "$cloudflare_token_file"; do
        [ -e "$permission_path" ] || continue
        case "$(file_mode "$permission_path")" in
            600|400) ;;
            *) error "Protected state file must have mode 0600 or 0400: $permission_path"; return 1 ;;
        esac
    done
    return 0
}

has_controlling_tty() {
    [ -c /dev/tty ] || return 1
    ( : </dev/tty ) 2>/dev/null
}

prompt_line() {
    prompt_label=$1
    prompt_default=$2
    if [ -n "$prompt_default" ]; then
        printf '%s [%s]: ' "$prompt_label" "$prompt_default" >/dev/tty
    else
        printf '%s: ' "$prompt_label" >/dev/tty
    fi
    IFS= read -r prompt_result </dev/tty || die "Input ended while reading: $prompt_label"
    [ -n "$prompt_result" ] || prompt_result=$prompt_default
    printf '%s' "$prompt_result"
}

prompt_secret() (
    secret_label=$1
    printf '%s (input hidden): ' "$secret_label" >/dev/tty
    secret_tty_state=$(stty -g </dev/tty) || die "Cannot read terminal settings"
    trap 'stty "$secret_tty_state" </dev/tty 2>/dev/null || true; exit 129' 1
    trap 'stty "$secret_tty_state" </dev/tty 2>/dev/null || true; exit 130' 2
    trap 'stty "$secret_tty_state" </dev/tty 2>/dev/null || true; exit 143' 15
    stty -echo </dev/tty || die "Cannot disable terminal echo"
    if ! IFS= read -r secret_result </dev/tty; then
        stty "$secret_tty_state" </dev/tty 2>/dev/null || true
        printf '\n' >/dev/tty
        die "Input ended while reading: $secret_label"
    fi
    stty "$secret_tty_state" </dev/tty || true
    trap - 1 2 15
    printf '\n' >/dev/tty
    printf '%s' "$secret_result"
)

prompt_confirmation() {
    confirmation_prompt=$1
    confirmation_default=${2:-no}
    while :; do
        if [ "$confirmation_default" = yes ]; then
            printf '%s [Y/n] ' "$confirmation_prompt" >/dev/tty
        else
            printf '%s [y/N] ' "$confirmation_prompt" >/dev/tty
        fi
        IFS= read -r confirmation_answer </dev/tty || die "Input ended while waiting for confirmation"
        confirmation_answer=$(printf '%s' "$confirmation_answer" | tr '[:upper:]' '[:lower:]')
        case "$confirmation_answer:$confirmation_default" in
            :yes|y:*|yes:*) return 0 ;;
            :no|n:*|no:*) return 1 ;;
            *) warn "Please answer yes or no." ;;
        esac
    done
}

read_secret_source() {
    secret_source_path=$1
    secret_source_label=$2
    [ -r "$secret_source_path" ] || die "$secret_source_label is not readable: $secret_source_path"
    [ ! -d "$secret_source_path" ] || die "$secret_source_label must be a file: $secret_source_path"
    secret_source_value=$(sed -n '1p' "$secret_source_path") || die "Cannot read $secret_source_label: $secret_source_path"
    is_valid_secret "$secret_source_value" || die "$secret_source_label is empty or contains surrounding/control whitespace"
    printf '%s' "$secret_source_value"
}

required_file() {
    required_path=$1
    required_description=$2
    [ -f "$required_path" ] || die "Missing $required_description: $required_path"
}

require_files_for_configuration() {
    required_mode=$1
    required_dns=$2
    required_proxy=$3
    required_runtime=${4:-node}
    required_base=$(compose_base_for_runtime "$required_runtime") || die "Invalid application runtime: $required_runtime"
    required_file "$required_base" "$required_runtime Compose file"
    case "$required_runtime" in
        node) required_file "$script_dir/Dockerfile" "Node Dockerfile" ;;
        static)
            required_file "$script_dir/Dockerfile.static" "static-web Dockerfile"
            required_file "$script_dir/deploy/rustfs/Caddyfile.static" "static-web Caddy configuration"
            ;;
    esac
    case "$required_mode:$required_dns:$required_proxy" in
        local:*:*|proxy:*:host) required_file "$compose_local" "local Compose overlay" ;;
        lan:*:*) required_file "$compose_lan" "LAN Compose overlay" ;;
        domain:cloudflare:*)
            required_file "$compose_caddy" "Caddy Compose overlay"
            required_file "$compose_cloudflare" "Cloudflare Compose overlay"
            required_file "$script_dir/deploy/rustfs/Caddyfile" "Caddy configuration"
            required_file "$script_dir/deploy/rustfs/update-cloudflare.mjs" "Cloudflare updater"
            ;;
        domain:manual:*)
            required_file "$compose_caddy" "Caddy Compose overlay"
            required_file "$script_dir/deploy/rustfs/Caddyfile" "Caddy configuration"
            ;;
        dynv6:*:*)
            required_file "$compose_caddy" "Caddy Compose overlay"
            required_file "$compose_dynv6" "dynv6 Compose overlay"
            required_file "$script_dir/deploy/rustfs/Caddyfile" "Caddy configuration"
            required_file "$script_dir/deploy/rustfs/update-dynv6.sh" "dynv6 updater"
            ;;
        proxy:*:docker) required_file "$compose_proxy_docker" "Docker proxy Compose overlay" ;;
        *) die "Invalid deployment combination: $required_mode/$required_dns/$required_proxy" ;;
    esac
}

require_compose() {
    command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Engine/Desktop with Compose v2."
    docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is not available (expected: docker compose)."
}

require_docker_daemon() {
    require_compose
    docker info >/dev/null 2>&1 || die "Cannot access the Docker daemon. Start Docker or fix the current user's permissions."
}

require_local_docker() {
    case "${DOCKER_HOST:-}" in
        tcp://*|ssh://*) die "Remote Docker endpoints are unsupported because this stack uses local bind mounts and host port checks." ;;
    esac
    context_name=$(docker context show 2>/dev/null || true)
    if [ -n "$context_name" ]; then
        context_endpoint=$(docker context inspect "$context_name" --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
        case "$context_endpoint" in ''|unix://*|npipe://*) ;; *) die "Docker context '$context_name' is remote ($context_endpoint); use a local Docker context." ;; esac
    fi
}

validate_saved_configuration() {
    validate_file=$1
    [ -f "$validate_file" ] || return 1
    saved_version=$(read_env_value_from "$validate_file" RISUAI_CONFIG_VERSION)
    case "$saved_version" in ''|1|2|3) ;; *) error "Unsupported or invalid RISUAI_CONFIG_VERSION in $validate_file"; return 1 ;; esac
    saved_project=$(read_env_value_from "$validate_file" COMPOSE_PROJECT_NAME)
    case "$saved_project" in ''|risuai-rustfs) ;; *) error "Unexpected COMPOSE_PROJECT_NAME in $validate_file"; return 1 ;; esac
    saved_mode=$(stored_mode_from "$validate_file")
    case "$saved_mode" in local|lan|domain|dynv6|proxy) ;; *) error "Missing or invalid RISUAI_MODE in $validate_file"; return 1 ;; esac
    saved_runtime=$(stored_runtime_from "$validate_file")
    case "$saved_runtime" in node|static) ;; *) error "Missing or invalid RISUAI_RUNTIME in $validate_file"; return 1 ;; esac
    if [ "$saved_version" = 3 ] && [ -z "$(read_env_value_from "$validate_file" RISUAI_RUNTIME)" ]; then error "Schema 3 configuration is missing RISUAI_RUNTIME"; return 1; fi
    saved_dns=$(env_value_or "$validate_file" RISUAI_DNS_PROVIDER none)
    saved_proxy=$(env_value_or "$validate_file" RISUAI_PROXY_TYPE none)
    case "$saved_mode:$saved_dns:$saved_proxy" in
        local:none:none|lan:none:none|domain:manual:none|domain:cloudflare:none|dynv6:none:none|proxy:none:host|proxy:none:docker) ;;
        *) error "Inconsistent mode/DNS/proxy settings in $validate_file"; return 1 ;;
    esac
    for saved_port_key in RISUAI_PORT RUSTFS_API_PORT RUSTFS_CONSOLE_PORT RISUAI_HTTP_PORT RISUAI_HTTPS_PORT; do
        case "$saved_port_key" in
            RISUAI_PORT) saved_port_default=6001 ;;
            RUSTFS_API_PORT) saved_port_default=9000 ;;
            RUSTFS_CONSOLE_PORT) saved_port_default=9001 ;;
            RISUAI_HTTP_PORT) saved_port_default=80 ;;
            RISUAI_HTTPS_PORT) saved_port_default=443 ;;
        esac
        saved_port=$(env_value_or "$validate_file" "$saved_port_key" "$saved_port_default")
        is_valid_port "$saved_port" || { error "Invalid $saved_port_key in $validate_file"; return 1; }
    done
    if [ "$saved_runtime" = node ]; then
        saved_postgres=$(read_env_value_from "$validate_file" POSTGRES_PASSWORD)
        saved_access=$(read_env_value_from "$validate_file" RUSTFS_ACCESS_KEY)
        saved_secret=$(read_env_value_from "$validate_file" RUSTFS_SECRET_KEY)
        is_safe_credential "$saved_postgres" || { error "Missing or unsafe POSTGRES_PASSWORD in $validate_file"; return 1; }
        is_safe_credential "$saved_access" || { error "Missing or unsafe RUSTFS_ACCESS_KEY in $validate_file"; return 1; }
        is_safe_credential "$saved_secret" || { error "Missing or unsafe RUSTFS_SECRET_KEY in $validate_file"; return 1; }
    fi
    saved_id=$(read_env_value_from "$validate_file" RISUAI_INSTALLATION_ID)
    case "$saved_version" in
        2|3) [ -n "$saved_id" ] || { error "Schema $saved_version configuration is missing RISUAI_INSTALLATION_ID"; return 1; } ;;
    esac
    if [ -n "$saved_id" ]; then
        if ! is_safe_scalar "$saved_id" || ! printf '%s\n' "$saved_id" | grep -Eq '^[0-9a-f]{32}$'; then error "Invalid RISUAI_INSTALLATION_ID in $validate_file"; return 1; fi
    fi
    saved_interval=$(env_value_or "$validate_file" DYNV6_UPDATE_INTERVAL 300)
    is_valid_integer_range "$saved_interval" 60 86400 || { error "Invalid DDNS interval in $validate_file"; return 1; }
    saved_wait_timeout=$(env_value_or "$validate_file" RISUAI_WAIT_TIMEOUT 300)
    is_valid_integer_range "$saved_wait_timeout" 10 3600 || { error "Invalid readiness timeout in $validate_file"; return 1; }
    saved_ipv6=$(env_value_or "$validate_file" DYNV6_IPV6 false)
    normalize_bool "$saved_ipv6" >/dev/null 2>&1 || { error "Invalid IPv6 setting in $validate_file"; return 1; }
    case "$saved_mode" in
        domain|dynv6)
            saved_domain=$(normalize_hostname "$(read_env_value_from "$validate_file" RISUAI_DOMAIN)")
            is_valid_hostname "$saved_domain" || { error "Invalid RISUAI_DOMAIN in $validate_file"; return 1; }
            ;;
    esac
    if [ "$saved_mode" = dynv6 ]; then
        case "$saved_domain" in *.dynv6.net) ;; *) error "Saved dynv6 hostname is not below dynv6.net"; return 1 ;; esac
        [ -s "$dynv6_token_file" ] || { error "The saved dynv6 token is missing or empty"; return 1; }
    fi
    if [ "$saved_mode:$saved_dns" = domain:cloudflare ]; then
        saved_zone=$(read_env_value_from "$validate_file" CLOUDFLARE_ZONE_ID)
        if ! is_safe_scalar "$saved_zone" || ! printf '%s\n' "$saved_zone" | grep -Eq '^[0-9A-Fa-f]{32}$'; then error "Invalid saved Cloudflare Zone ID"; return 1; fi
        [ -s "$cloudflare_token_file" ] || { error "The saved Cloudflare token is missing or empty"; return 1; }
    fi
    if [ "$saved_mode:$saved_proxy" = proxy:docker ]; then
        saved_network=$(read_env_value_from "$validate_file" RISUAI_PROXY_NETWORK)
        is_valid_proxy_network "$saved_network" || { error "Invalid saved Docker proxy network"; return 1; }
    fi
    return 0
}

compose_with_env() (
    selected_env=$1
    selected_dynv6_path=$2
    selected_cloudflare_path=$3
    shift 3
    selected_runtime=$(stored_runtime_from "$selected_env")
    selected_base=$(compose_base_for_runtime "$selected_runtime") || return 64
    selected_mode=$(stored_mode_from "$selected_env")
    selected_dns=$(env_value_or "$selected_env" RISUAI_DNS_PROVIDER none)
    selected_proxy=$(env_value_or "$selected_env" RISUAI_PROXY_TYPE none)
    selected_proxy_network=$(read_env_value_from "$selected_env" RISUAI_PROXY_NETWORK)
    selected_postgres=$(read_env_value_from "$selected_env" POSTGRES_PASSWORD)
    selected_access=$(read_env_value_from "$selected_env" RUSTFS_ACCESS_KEY)
    selected_secret=$(read_env_value_from "$selected_env" RUSTFS_SECRET_KEY)
    selected_domain=$(read_env_value_from "$selected_env" RISUAI_DOMAIN)
    selected_zone=$(read_env_value_from "$selected_env" CLOUDFLARE_ZONE_ID)
    selected_ipv6=$(env_value_or "$selected_env" DYNV6_IPV6 false)
    selected_interval=$(env_value_or "$selected_env" DYNV6_UPDATE_INTERVAL 300)
    selected_app_port=$(env_value_or "$selected_env" RISUAI_PORT 6001)
    selected_api_port=$(env_value_or "$selected_env" RUSTFS_API_PORT 9000)
    selected_console_port=$(env_value_or "$selected_env" RUSTFS_CONSOLE_PORT 9001)
    selected_http_port=$(env_value_or "$selected_env" RISUAI_HTTP_PORT 80)
    selected_https_port=$(env_value_or "$selected_env" RISUAI_HTTPS_PORT 443)
    selected_installation_id=$(env_value_or "$selected_env" RISUAI_INSTALLATION_ID legacy)

    unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES
    COMPOSE_PROJECT_NAME=$project_name
    RISUAI_RUNTIME=$selected_runtime
    RISUAI_MODE=$selected_mode
    RISUAI_DNS_PROVIDER=$selected_dns
    RISUAI_PROXY_TYPE=$selected_proxy
    RISUAI_PROXY_NETWORK=$selected_proxy_network
    RISUAI_INSTALLATION_ID=$selected_installation_id
    RISUAI_PORT=$selected_app_port
    RISUAI_HTTP_PORT=$selected_http_port
    RISUAI_HTTPS_PORT=$selected_https_port
    POSTGRES_PASSWORD=$selected_postgres
    RUSTFS_ACCESS_KEY=$selected_access
    RUSTFS_SECRET_KEY=$selected_secret
    RUSTFS_BIND_ADDRESS=127.0.0.1
    RUSTFS_API_PORT=$selected_api_port
    RUSTFS_CONSOLE_PORT=$selected_console_port
    RISUAI_DOMAIN=$selected_domain
    DYNV6_ZONE=$selected_domain
    DYNV6_IPV6=$selected_ipv6
    DYNV6_TOKEN_FILE=$selected_dynv6_path
    DYNV6_UPDATE_INTERVAL=$selected_interval
    CLOUDFLARE_ZONE_ID=$selected_zone
    CLOUDFLARE_IPV6=$selected_ipv6
    CLOUDFLARE_TOKEN_FILE=$selected_cloudflare_path
    CLOUDFLARE_UPDATE_INTERVAL=$selected_interval
    RISUAI_MIGRATE_CONCURRENCY=4
    export COMPOSE_PROJECT_NAME RISUAI_RUNTIME RISUAI_MODE RISUAI_DNS_PROVIDER RISUAI_PROXY_TYPE RISUAI_PROXY_NETWORK
    export RISUAI_INSTALLATION_ID RISUAI_PORT RISUAI_HTTP_PORT RISUAI_HTTPS_PORT RISUAI_MIGRATE_CONCURRENCY
    export POSTGRES_PASSWORD RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY RUSTFS_BIND_ADDRESS RUSTFS_API_PORT RUSTFS_CONSOLE_PORT
    export RISUAI_DOMAIN DYNV6_ZONE DYNV6_IPV6 DYNV6_TOKEN_FILE DYNV6_UPDATE_INTERVAL
    export CLOUDFLARE_ZONE_ID CLOUDFLARE_IPV6 CLOUDFLARE_TOKEN_FILE CLOUDFLARE_UPDATE_INTERVAL

    case "$selected_mode:$selected_dns:$selected_proxy" in
        local:*:*|proxy:*:host)
            docker compose --project-name "$project_name" --project-directory "$script_dir" --env-file "$selected_env" -f "$selected_base" -f "$compose_local" "$@" ;;
        lan:*:*)
            docker compose --project-name "$project_name" --project-directory "$script_dir" --env-file "$selected_env" -f "$selected_base" -f "$compose_lan" "$@" ;;
        domain:cloudflare:*)
            docker compose --project-name "$project_name" --project-directory "$script_dir" --env-file "$selected_env" -f "$selected_base" -f "$compose_caddy" -f "$compose_cloudflare" "$@" ;;
        domain:manual:*)
            docker compose --project-name "$project_name" --project-directory "$script_dir" --env-file "$selected_env" -f "$selected_base" -f "$compose_caddy" "$@" ;;
        dynv6:*:*)
            docker compose --project-name "$project_name" --project-directory "$script_dir" --env-file "$selected_env" -f "$selected_base" -f "$compose_caddy" -f "$compose_dynv6" "$@" ;;
        proxy:*:docker)
            docker compose --project-name "$project_name" --project-directory "$script_dir" --env-file "$selected_env" -f "$selected_base" -f "$compose_proxy_docker" "$@" ;;
        *) return 64 ;;
    esac
)

compose() {
    compose_with_env "$env_file" ./.risuai/dynv6-token ./.risuai/cloudflare-token "$@"
}

random_secret() {
    generated_secret=
    if command -v openssl >/dev/null 2>&1; then
        generated_secret=$(openssl rand -hex 32 2>/dev/null || true)
    fi
    if ! printf '%s\n' "$generated_secret" | grep -Eq '^[0-9a-f]{64}$'; then
        [ -r /dev/urandom ] || die "Cannot generate credentials: neither working openssl nor /dev/urandom is available"
        generated_secret=$(od -An -N32 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n') || die "Cannot read secure random bytes"
    fi
    printf '%s\n' "$generated_secret" | grep -Eq '^[0-9a-f]{64}$' || die "Secure random generator returned invalid output"
    printf '%s' "$generated_secret"
}

recover_container_env() {
    recovery_container=$1
    recovery_key=$2
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$recovery_container" 2>/dev/null | \
        awk -v wanted="$recovery_key" 'index($0, wanted "=") == 1 { value=substr($0,length(wanted)+2) } END { printf "%s", value }'
}

container_label() {
    label_container=$1
    label_name=$2
    docker inspect --format "{{index .Config.Labels \"$label_name\"}}" "$label_container" 2>/dev/null || true
}

container_belongs_to_installation() {
    ownership_container=$1
    ownership_project=$(container_label "$ownership_container" com.docker.compose.project)
    [ "$ownership_project" = "$project_name" ] || return 1
    ownership_id=$(container_label "$ownership_container" io.risuai.installation-id)
    if [ -n "$ownership_id" ] && [ "$ownership_id" = "$installation_id" ]; then return 0; fi
    ownership_workdir=$(container_label "$ownership_container" com.docker.compose.project.working_dir)
    if [ "$saved_present" = true ] && { [ -z "$ownership_id" ] || [ "$ownership_id" = legacy ]; } && [ "$ownership_workdir" = "$script_dir" ]; then return 0; fi
    [ "$adopt_existing" = true ]
}

check_container_ownership() {
    for ownership_name in risuai risuai-postgres risuai-rustfs risuai-caddy risuai-dynv6 risuai-cloudflare-ddns; do
        docker inspect "$ownership_name" >/dev/null 2>&1 || continue
        if ! container_belongs_to_installation "$ownership_name"; then
            ownership_workdir=$(container_label "$ownership_name" com.docker.compose.project.working_dir)
            [ -n "$ownership_workdir" ] || ownership_workdir=unknown
            die "Container '$ownership_name' belongs to another installation ($ownership_workdir). Use that checkout, remove/rename it, or rerun install with --adopt-existing after verifying ownership."
        fi
    done
}

validate_port_layout() {
    if [ "$runtime" = node ]; then
        [ "$rustfs_api_port" != "$rustfs_console_port" ] || die "RustFS API and console ports must be different"
        if [ "$mode:$proxy_type" != proxy:docker ]; then
            [ "$app_port" != "$rustfs_api_port" ] || die "RisuAI and RustFS API cannot publish the same host port"
            [ "$app_port" != "$rustfs_console_port" ] || die "RisuAI and RustFS console cannot publish the same host port"
        fi
    fi
    case "$mode" in
        domain|dynv6)
            [ "$http_port" != "$https_port" ] || die "Caddy HTTP and HTTPS ports must be different"
            for public_tcp_port in "$http_port" "$https_port"; do
                if [ "$runtime" = node ]; then
                    [ "$public_tcp_port" != "$rustfs_api_port" ] || die "A Caddy port conflicts with the RustFS API port"
                    [ "$public_tcp_port" != "$rustfs_console_port" ] || die "A Caddy port conflicts with the RustFS console port"
                fi
                [ "$public_tcp_port" != "$app_port" ] || die "A Caddy port conflicts with the RisuAI maintenance port"
            done
            ;;
    esac
}

kernel_socket_details() {
    socket_protocol=$1
    socket_port=$2
    socket_bind=$3
    hex_port=$(printf '%04X' "$socket_port")
    for socket_table in /proc/net/"$socket_protocol" /proc/net/"${socket_protocol}6"; do
        [ -r "$socket_table" ] || continue
        awk -v suffix=":$hex_port" -v table="$socket_table" -v protocol="$socket_protocol" -v bind="$socket_bind" '
            NR > 1 {
                state=toupper($4)
                address=toupper($2)
                if (address !~ (suffix "$")) next
                if (protocol == "tcp" && state != "0A") next
                if (protocol == "udp" && state != "07") next
                if (bind == "loopback" && address !~ /^(0100007F|00000000000000000000000001000000|00000000|00000000000000000000000000000000):/) next
                print "Kernel socket in " table ": " $2
            }
        ' "$socket_table"
    done
}

port_details() {
    detail_protocol=$1
    detail_port=$2
    detail_bind=$3
    owned_binding=false
    foreign_binding=false
    container_ids=$(docker ps --filter "publish=$detail_port/$detail_protocol" --format '{{.ID}}' 2>/dev/null || true)
    for detail_id in $container_ids; do
        if container_belongs_to_installation "$detail_id"; then
            owned_binding=true
        else
            foreign_binding=true
            foreign_details=$(docker inspect --format 'Docker container {{.Name}}: {{json .NetworkSettings.Ports}}' "$detail_id" 2>/dev/null || true)
            if [ -n "$foreign_details" ]; then printf '%s\n' "$foreign_details"; else printf 'Foreign Docker container %s publishes %s/%s\n' "$detail_id" "$detail_port" "$detail_protocol"; fi
        fi
    done

    # Docker already proved a foreign conflict. If the only publisher belongs
    # to this installation, avoid mistaking Docker's host proxy for a conflict.
    [ "$foreign_binding" = false ] || return 0
    [ "$owned_binding" = false ] || return 0
    socket_output=
    if command -v ss >/dev/null 2>&1; then
        if [ "$detail_protocol" = tcp ]; then
            socket_output=$(ss -H -ltnp "sport = :$detail_port" 2>/dev/null || true)
        else
            socket_output=$(ss -H -lunp "sport = :$detail_port" 2>/dev/null || true)
        fi
        if [ "$detail_bind" = loopback ] && [ -n "$socket_output" ]; then
            socket_output=$(printf '%s\n' "$socket_output" | awk -v port="$detail_port" '$0 ~ ("127\\.0\\.0\\.1:" port) || $0 ~ ("\\[::1\\]:" port) || $0 ~ ("0\\.0\\.0\\.0:" port) || $0 ~ ("\\[::\\]:" port) || $0 ~ ("\\*:" port)')
        fi
    elif command -v lsof >/dev/null 2>&1; then
        if [ "$detail_protocol" = tcp ]; then
            socket_output=$(lsof -nP -iTCP:"$detail_port" -sTCP:LISTEN 2>/dev/null || true)
        else
            socket_output=$(lsof -nP -iUDP:"$detail_port" 2>/dev/null || true)
        fi
    elif command -v netstat >/dev/null 2>&1; then
        socket_output=$(netstat -an 2>/dev/null | awk -v port="$detail_port" '$4 ~ (":" port "$") || $4 ~ ("\\." port "$") { print }' || true)
    fi
    if [ -n "$socket_output" ]; then printf '%s\n' "$socket_output"; else kernel_socket_details "$detail_protocol" "$detail_port" "$detail_bind"; fi
}

check_port() {
    check_protocol=$1
    check_port_number=$2
    check_bind=$3
    conflicts=$(port_details "$check_protocol" "$check_port_number" "$check_bind")
    if [ -n "$conflicts" ]; then
        printf '%s\n' "$conflicts" >&2
        die "Port $check_port_number/$check_protocol conflicts with the requested $check_bind binding (use --skip-port-check only after verifying it manually)"
    fi
}

check_required_ports() {
    [ "$skip_port_check" = false ] || { warn "Skipping host port preflight checks by request."; return; }
    info "Checking every requested host port"
    if [ "$runtime" = node ]; then
        check_port tcp "$rustfs_api_port" loopback
        check_port tcp "$rustfs_console_port" loopback
    fi
    case "$mode:$proxy_type" in
        local:*|proxy:host) check_port tcp "$app_port" loopback ;;
        lan:*) check_port tcp "$app_port" all ;;
        domain:*|dynv6:*)
            check_port tcp "$app_port" loopback
            check_port tcp "$http_port" all
            check_port tcp "$https_port" all
            check_port udp "$https_port" all
            ;;
    esac
}

load_saved_port_settings() {
    runtime=$(stored_runtime_from "$env_file")
    mode=$(stored_mode_from "$env_file")
    dns_provider=$(env_value_or "$env_file" RISUAI_DNS_PROVIDER none)
    proxy_type=$(env_value_or "$env_file" RISUAI_PROXY_TYPE none)
    proxy_network=$(read_env_value_from "$env_file" RISUAI_PROXY_NETWORK)
    app_port=$(normalize_port "$(env_value_or "$env_file" RISUAI_PORT 6001)")
    rustfs_api_port=$(normalize_port "$(env_value_or "$env_file" RUSTFS_API_PORT 9000)")
    rustfs_console_port=$(normalize_port "$(env_value_or "$env_file" RUSTFS_CONSOLE_PORT 9001)")
    http_port=$(normalize_port "$(env_value_or "$env_file" RISUAI_HTTP_PORT 80)")
    https_port=$(normalize_port "$(env_value_or "$env_file" RISUAI_HTTPS_PORT 443)")
    skip_port_check=false
}

find_lan_address() {
    lan_address=
    if command -v ip >/dev/null 2>&1; then
        lan_address=$(ip route get 1.1.1.1 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit } }' || true)
        if [ -z "$lan_address" ]; then
            lan_address=$(ip -6 route get 2001:4860:4860::8888 2>/dev/null | awk '{ for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit } }' || true)
        fi
    fi
    if [ -z "$lan_address" ] && command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
        lan_interface=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2; exit}' || true)
        [ -z "$lan_interface" ] || lan_address=$(ipconfig getifaddr "$lan_interface" 2>/dev/null || true)
    fi
    if [ -z "$lan_address" ]; then
        hostname_addresses=$(hostname -I 2>/dev/null || true)
        for possible_address in $hostname_addresses; do
            case "$possible_address" in 127.*|169.254.*|::1|fe80:*) ;; *) lan_address=$possible_address; break ;; esac
        done
    fi
    [ -n "$lan_address" ] || lan_address=SERVER-IP
    case "$lan_address" in *:*) printf '[%s]' "$lan_address" ;; *) printf '%s' "$lan_address" ;; esac
}

deployment_url_from() {
    url_env=$1
    url_mode=$(stored_mode_from "$url_env")
    url_domain=$(read_env_value_from "$url_env" RISUAI_DOMAIN)
    url_proxy=$(env_value_or "$url_env" RISUAI_PROXY_TYPE none)
    url_app_port=$(env_value_or "$url_env" RISUAI_PORT 6001)
    url_https_port=$(env_value_or "$url_env" RISUAI_HTTPS_PORT 443)
    case "$url_mode:$url_proxy" in
        local:*) printf 'http://localhost:%s' "$url_app_port" ;;
        lan:*) printf 'http://%s:%s' "$(find_lan_address)" "$url_app_port" ;;
        domain:*|dynv6:*) if [ "$url_https_port" = 443 ]; then printf 'https://%s' "$url_domain"; else printf 'https://%s:%s' "$url_domain" "$url_https_port"; fi ;;
        proxy:host) printf 'host proxy target: http://127.0.0.1:%s' "$url_app_port" ;;
        proxy:docker) printf 'Docker proxy target: http://risuai:6001' ;;
        *) printf 'invalid configuration' ;;
    esac
}

show_deployment_from() {
    show_env=$1
    current_mode=$(stored_mode_from "$show_env")
    current_runtime=$(stored_runtime_from "$show_env")
    current_dns=$(env_value_or "$show_env" RISUAI_DNS_PROVIDER none)
    current_proxy=$(env_value_or "$show_env" RISUAI_PROXY_TYPE none)
    current_app_port=$(env_value_or "$show_env" RISUAI_PORT 6001)
    current_api_port=$(env_value_or "$show_env" RUSTFS_API_PORT 9000)
    current_console_port=$(env_value_or "$show_env" RUSTFS_CONSOLE_PORT 9001)
    current_http_port=$(env_value_or "$show_env" RISUAI_HTTP_PORT 80)
    current_https_port=$(env_value_or "$show_env" RISUAI_HTTPS_PORT 443)
    current_ipv6=$(env_value_or "$show_env" DYNV6_IPV6 false)
    current_id=$(env_value_or "$show_env" RISUAI_INSTALLATION_ID legacy)
    printf '\n  Runtime:           %s\n' "$current_runtime"
    printf '  Mode:              %s\n' "$current_mode"
    [ "$current_dns" = none ] || printf '  DNS provider:      %s\n' "$current_dns"
    [ "$current_proxy" = none ] || printf '  Proxy type:        %s\n' "$current_proxy"
    printf '  Configured target: %s\n' "$(deployment_url_from "$show_env")"
    case "$current_mode" in
        local) printf '  Published app:     127.0.0.1:%s/tcp\n' "$current_app_port" ;;
        lan) printf '  Published app:     0.0.0.0:%s/tcp (unencrypted)\n' "$current_app_port" ;;
        domain|dynv6)
            printf '  Host mappings:     %s/tcp -> HTTP, %s/tcp+udp -> HTTPS/HTTP3\n' "$current_http_port" "$current_https_port"
            printf '  Maintenance app:   127.0.0.1:%s/tcp\n' "$current_app_port"
            ;;
        proxy)
            if [ "$current_proxy" = docker ]; then printf '  Proxy network:     %s\n' "$(read_env_value_from "$show_env" RISUAI_PROXY_NETWORK)"; else printf '  Published app:     127.0.0.1:%s/tcp\n' "$current_app_port"; fi
            ;;
    esac
    if [ "$current_runtime" = node ]; then
        printf '  RustFS API:        127.0.0.1:%s/tcp\n' "$current_api_port"
        printf '  RustFS console:    http://127.0.0.1:%s\n' "$current_console_port"
    else
        printf '  Web server:        Caddy static file server\n'
    fi
    printf '  IPv6 DDNS:         %s\n' "$current_ipv6"
    printf '  Installation ID:   %s\n' "$current_id"
    printf '  Config file:       %s\n' "$env_file"
}

expected_services() { compose config --services; }

services_are_running() {
    report_errors=${1:-true}
    expected_list=$(expected_services 2>/dev/null) || return 1
    running_list=$(compose ps --status running --services 2>/dev/null) || return 1
    services_ok=true
    for expected_service in $expected_list; do
        printf '%s\n' "$running_list" | grep -Fx "$expected_service" >/dev/null 2>&1 || {
            [ "$report_errors" = false ] || error "Service is not running: $expected_service"
            services_ok=false
            continue
        }
        service_id=$(compose ps -q "$expected_service" 2>/dev/null || true)
        [ -n "$service_id" ] || {
            [ "$report_errors" = false ] || error "Cannot resolve container for service: $expected_service"
            services_ok=false
            continue
        }
        health_state=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$service_id" 2>/dev/null || true)
        case "$health_state" in
            healthy|none) ;;
            *)
                [ "$report_errors" = false ] || error "Service health is not ready ($health_state): $expected_service"
                services_ok=false
                ;;
        esac
    done
    [ "$services_ok" = true ]
}

show_readiness_diagnostics() {
    diagnostic_elapsed=$1
    warn "RisuAI is still starting after ${diagnostic_elapsed}s; current status and recent app logs follow."
    compose ps --all >&2 || true
    compose logs --no-color --tail 40 risuai >&2 || true
}

wait_for_risuai() {
    wait_limit=$1
    info "Waiting up to ${wait_limit}s for RisuAI"
    wait_started=$(date +%s 2>/dev/null || printf '0')
    wait_elapsed=0
    next_diagnostic=10
    while :; do
        wait_runtime=$(stored_runtime_from "$env_file")
        if [ "$wait_runtime" = static ]; then
            readiness_ok=false
            compose exec -T risuai wget -q --spider http://127.0.0.1:6001/ >/dev/null 2>&1 && readiness_ok=true
        else
            readiness_ok=false
            compose exec -T risuai node -e "fetch('http://127.0.0.1:6001').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1 && readiness_ok=true
        fi
        if [ "$readiness_ok" = true ]; then
            if services_are_running false; then ok "RisuAI and all services are running"; return 0; fi
        fi
        if [ "$wait_started" -gt 0 ] 2>/dev/null; then
            wait_now=$(date +%s 2>/dev/null || printf '0')
            wait_elapsed=$((wait_now - wait_started))
        else
            wait_elapsed=$((wait_elapsed + 2))
        fi
        if [ "$wait_elapsed" -ge "$next_diagnostic" ]; then
            show_readiness_diagnostics "$wait_elapsed"
            next_diagnostic=$((next_diagnostic + 30))
        fi
        [ "$wait_elapsed" -lt "$wait_limit" ] || break
        sleep 2
    done
    compose ps --all >&2 || true
    compose logs --no-color --tail 100 >&2 || true
    return 1
}

check_runtime_status() {
    compose ps --all
    show_deployment_from "$env_file"
    if services_are_running; then ok "All configured services are running"; return 0; fi
    error "The deployment is configured but not healthy/running"
    return 1
}

lock_held=false
state_dir_created=false
tmp_env=
tmp_dynv6=
tmp_cloudflare=
tmp_upgrade=
backup_env=
backup_dynv6=
backup_cloudflare=
had_env=false
had_dynv6=false
had_cloudflare=false
transaction_active=false
transaction_committed=false
old_was_running=false
child_pid=

release_lock() {
    [ "$lock_held" = true ] || return 0
    rm -f "$lock_dir/pid" 2>/dev/null || true
    rmdir "$lock_dir" 2>/dev/null || true
    lock_held=false
}

restore_file_from_backup() {
    restore_had=$1
    restore_backup=$2
    restore_destination=$3
    if [ "$restore_had" = true ] && [ -f "$restore_backup" ]; then mv -f "$restore_backup" "$restore_destination" || return 1; else rm -f "$restore_destination" || return 1; fi
}

rollback_installation() {
    [ "$transaction_active" = true ] || return 0
    transaction_active=false
    warn "Installation did not complete; restoring the previous protected configuration."
    if [ -f "$env_file" ] && docker info >/dev/null 2>&1; then compose down --remove-orphans >/dev/null 2>&1 || true; fi
    restore_file_from_backup "$had_dynv6" "$backup_dynv6" "$dynv6_token_file" || warn "Could not restore the previous dynv6 token"
    restore_file_from_backup "$had_cloudflare" "$backup_cloudflare" "$cloudflare_token_file" || warn "Could not restore the previous Cloudflare token"
    restore_file_from_backup "$had_env" "$backup_env" "$env_file" || warn "Could not restore the previous environment file"
    if [ "$old_was_running" = true ] && [ -f "$env_file" ] && docker info >/dev/null 2>&1; then
        if compose up -d --remove-orphans >/dev/null 2>&1; then warn "The previous deployment configuration was restarted."; else warn "The previous files were restored, but its containers could not be restarted. Run: $script_path doctor"; fi
    fi
}

cleanup() {
    cleanup_status=$?
    trap - 0 1 2 15
    set +e
    [ -z "$child_pid" ] || kill "$child_pid" >/dev/null 2>&1
    if [ "$transaction_active" = true ] && [ "$transaction_committed" != true ]; then rollback_installation; fi
    for cleanup_file in "$tmp_env" "$tmp_dynv6" "$tmp_cloudflare" "$tmp_upgrade" "$backup_env" "$backup_dynv6" "$backup_cloudflare"; do [ -z "$cleanup_file" ] || rm -f "$cleanup_file"; done
    release_lock
    if [ "$state_dir_created" = true ]; then rmdir "$state_dir" >/dev/null 2>&1 || true; fi
    exit "$cleanup_status"
}

trap cleanup 0
trap 'exit 129' 1
trap 'exit 130' 2
trap 'exit 143' 15

prepare_state_directory() {
    [ ! -L "$state_dir" ] || die "Refusing symbolic-link state directory: $state_dir"
    if [ -e "$state_dir" ] && [ ! -d "$state_dir" ]; then die "State path is not a directory: $state_dir"; fi
    if [ ! -d "$state_dir" ]; then
        umask 077
        mkdir "$state_dir" || die "Cannot create state directory: $state_dir"
        state_dir_created=true
    else
        validate_state_security || die "Refusing insecure or foreign-owned state directory"
    fi
    chmod 700 "$state_dir" || die "Cannot protect state directory: $state_dir"
    for protected_path in "$env_file" "$dynv6_token_file" "$cloudflare_token_file"; do [ ! -L "$protected_path" ] || die "Refusing symbolic-link protected file: $protected_path"; done
    for protected_path in "$env_file" "$dynv6_token_file" "$cloudflare_token_file"; do [ ! -e "$protected_path" ] || chmod 600 "$protected_path" || die "Cannot protect state file: $protected_path"; done
}

acquire_lock() {
    prepare_state_directory
    if ! mkdir "$lock_dir" 2>/dev/null; then
        [ -d "$lock_dir" ] || die "Invalid operation lock path: $lock_dir"
        lock_pid=$(sed -n '1p' "$lock_dir/pid" 2>/dev/null || true)
        case "$lock_pid" in ''|*[!0-9]*) lock_pid= ;; esac
        if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then die "Another risuai.sh operation is running (PID $lock_pid)"; fi
        warn "Removing a stale operation lock${lock_pid:+ from PID $lock_pid}."
        rm -f "$lock_dir/pid" 2>/dev/null || die "Cannot remove stale lock PID file"
        rmdir "$lock_dir" 2>/dev/null || die "Cannot remove stale lock directory; inspect $lock_dir"
        mkdir "$lock_dir" 2>/dev/null || die "Another operation acquired the lock"
    fi
    lock_held=true
    umask 077
    printf '%s\n' "$$" >"$lock_dir/pid" || die "Cannot write operation lock"
}

require_installation() {
    [ -f "$env_file" ] || die "No installation found. Run: $script_path install"
    validate_state_security || die "Refusing insecure or foreign-owned saved state"
    validate_state_permissions || die "Refusing saved state with unsafe permissions; fix it or rerun install to repair owned files"
    validate_saved_configuration "$env_file" || die "Saved configuration is invalid. Run: $script_path doctor"
    saved_mode=$(stored_mode_from "$env_file")
    saved_runtime=$(stored_runtime_from "$env_file")
    saved_dns=$(env_value_or "$env_file" RISUAI_DNS_PROVIDER none)
    saved_proxy=$(env_value_or "$env_file" RISUAI_PROXY_TYPE none)
    require_files_for_configuration "$saved_mode" "$saved_dns" "$saved_proxy" "$saved_runtime"
}

upgrade_legacy_installation_identity() {
    existing_id=$(read_env_value_from "$env_file" RISUAI_INSTALLATION_ID)
    [ -z "$existing_id" ] || { installation_id=$existing_id; return; }
    installation_id=$(random_secret | cut -c1-32)
    tmp_upgrade=$(mktemp "$state_dir/rustfs.env.upgrade.XXXXXX") || die "Cannot stage legacy configuration upgrade"
    awk '
        index($0, "RISUAI_CONFIG_VERSION=") != 1 &&
        index($0, "RISUAI_INSTALLATION_ID=") != 1 &&
        index($0, "RISUAI_RUNTIME=") != 1 &&
        index($0, "DYNV6_TOKEN_FILE=") != 1 &&
        index($0, "CLOUDFLARE_TOKEN_FILE=") != 1 { print }
    ' "$env_file" >"$tmp_upgrade" || die "Cannot read legacy configuration"
    {
        printf 'RISUAI_CONFIG_VERSION=%s\n' "$config_version"
        printf 'RISUAI_INSTALLATION_ID=%s\n' "$installation_id"
        printf 'RISUAI_RUNTIME=node\n'
        printf 'DYNV6_TOKEN_FILE=./.risuai/dynv6-token\n'
        printf 'CLOUDFLARE_TOKEN_FILE=./.risuai/cloudflare-token\n'
    } >>"$tmp_upgrade" || die "Cannot write upgraded configuration"
    chmod 600 "$tmp_upgrade" || die "Cannot protect upgraded configuration"
    mv -f "$tmp_upgrade" "$env_file" || die "Cannot activate upgraded configuration"
    tmp_upgrade=
    ok "Migrated legacy state to configuration schema $config_version with a unique installation ID"
}

validate_new_database_password() {
    database_password=$1
    is_safe_credential "$database_password" || die "Database password may contain only letters, numbers, '.', '_', '~', and '-'"
    [ "${#database_password}" -ge 12 ] || die "Database password must be at least 12 characters"
    [ "${#database_password}" -le 256 ] || die "Database password must be at most 256 characters"
}

postgres_is_running() {
    compose ps --status running --services 2>/dev/null | grep -Fx postgres >/dev/null 2>&1
}

ensure_postgres_running() {
    if ! postgres_is_running; then
        info "Starting PostgreSQL"
        compose up -d postgres
    fi
    postgres_wait=0
    while [ "$postgres_wait" -lt 30 ]; do
        if compose exec -T postgres pg_isready -U risuai -d risuai >/dev/null 2>&1; then return 0; fi
        postgres_wait=$((postgres_wait + 1))
        sleep 1
    done
    die "PostgreSQL did not become ready within 30s"
}

postgres_saved_password_matches() {
    saved_database_password=$(read_env_value_from "$env_file" POSTGRES_PASSWORD)
    [ -n "$saved_database_password" ] || return 1
    printf '%s\n' "$saved_database_password" | compose exec -T postgres sh -c '
        IFS= read -r PGPASSWORD || exit 1
        export PGPASSWORD
        exec psql -h 127.0.0.1 -U risuai -d risuai -Atqc "SELECT 1"
    ' >/dev/null 2>&1
}

postgres_admin_sql() {
    compose exec -T postgres psql -U risuai -d risuai -v ON_ERROR_STOP=1 "$@"
}

set_postgres_role_password() {
    new_database_password=$1
    is_safe_credential "$new_database_password" || die "Refusing to apply an unsafe database password"
    printf "ALTER ROLE risuai WITH PASSWORD '%s';\n" "$new_database_password" | \
        postgres_admin_sql >/dev/null
}

recreate_risuai_for_database_password() {
    if compose ps --status running --services 2>/dev/null | grep -Fx risuai >/dev/null 2>&1; then
        info "Recreating RisuAI with the updated database credentials"
        compose up -d --force-recreate risuai
        wait_for_risuai "$wait_timeout" || die "RisuAI did not become ready after the database password change"
    else
        warn "RisuAI is not running; the new password will be used on the next start."
    fi
}

manage_database() {
    require_installation
    [ "$saved_runtime" = node ] || die "Database commands are unavailable for the static runtime because it has no PostgreSQL service"
    require_docker_daemon
    require_local_docker
    installation_id=$(env_value_or "$env_file" RISUAI_INSTALLATION_ID legacy)
    saved_present=true
    adopt_existing=false
    [ -n "$input_wait_timeout" ] || wait_timeout=$(env_value_or "$env_file" RISUAI_WAIT_TIMEOUT 300)
    is_valid_integer_range "$wait_timeout" 10 3600 || die "Saved readiness timeout must be an integer from 10 to 3600"
    db_action=${1:-help}
    [ "$#" -eq 0 ] || shift

    case "$db_action" in
        help|-h|--help)
            cat <<'EOF'
Usage:
  ./risuai.sh db status
  ./risuai.sh db password [--generate | --password-file FILE]
  ./risuai.sh db sync-password
  ./risuai.sh db shell
  ./risuai.sh db backup [FILE]
  ./risuai.sh db optimize

The password commands keep the PostgreSQL role and saved RisuAI configuration
in sync. `sync-password` is the safe repair command when an existing database
volume rejects the password currently stored in .risuai/rustfs.env.
EOF
            return
            ;;
        status)
            [ "$#" -eq 0 ] || die "db status does not accept arguments"
            info "Checking PostgreSQL"
            if ! postgres_is_running; then
                error "PostgreSQL is not running"
                printf '  Repair: %s start\n' "${0##*/}" >&2
                return 1
            fi
            ok "PostgreSQL container is running"
            db_password_ok=false
            if postgres_saved_password_matches; then
                ok "Saved database password matches the PostgreSQL role"
                db_password_ok=true
            else
                error "Saved database password does not authenticate to PostgreSQL"
                printf '  Repair: %s db sync-password\n' "${0##*/}" >&2
            fi
            db_version=$(postgres_admin_sql -Atqc 'SHOW server_version;' 2>/dev/null || true)
            db_size=$(postgres_admin_sql -Atqc "SELECT pg_size_pretty(pg_database_size('risuai'));" 2>/dev/null || true)
            db_connections=$(postgres_admin_sql -Atqc "SELECT count(*) FROM pg_stat_activity WHERE datname='risuai';" 2>/dev/null || true)
            [ -n "$db_version" ] && printf '  PostgreSQL version: %s\n' "$db_version"
            [ -n "$db_size" ] && printf '  Database size:      %s\n' "$db_size"
            [ -n "$db_connections" ] && printf '  Connections:        %s\n' "$db_connections"
            if [ "$db_password_ok" = true ]; then return 0; fi
            return 1
            ;;
        shell)
            [ "$#" -eq 0 ] || die "db shell does not accept arguments"
            has_controlling_tty || die "db shell requires an interactive terminal"
            ensure_postgres_running
            info "Opening PostgreSQL shell (database=risuai, user=risuai)"
            compose exec postgres psql -U risuai -d risuai
            return
            ;;
        backup)
            [ "$#" -le 1 ] || die "db backup accepts at most one output file"
            ensure_postgres_running
            if [ "$#" -eq 1 ]; then
                backup_file=$1
            else
                backup_file=$PWD/risuai-postgres-$(date '+%Y%m%d-%H%M%S').dump
            fi
            is_safe_scalar "$backup_file" || die "Invalid backup path"
            [ ! -e "$backup_file" ] || die "Backup destination already exists: $backup_file"
            case "$backup_file" in
                */*) backup_dir=${backup_file%/*}; [ -d "$backup_dir" ] || die "Backup directory does not exist: $backup_dir" ;;
            esac
            info "Creating PostgreSQL backup"
            umask 077
            if compose exec -T postgres pg_dump -U risuai -d risuai -Fc >"$backup_file"; then
                ok "Database backup created: $backup_file"
                warn "This backup contains PostgreSQL data only; RustFS assets are not included."
            else
                rm -f "$backup_file"
                die "PostgreSQL backup failed"
            fi
            return
            ;;
        optimize)
            [ "$#" -eq 0 ] || die "db optimize does not accept arguments"
            acquire_lock
            check_container_ownership
            ensure_postgres_running
            info "Optimizing PostgreSQL statistics and reclaimable space"
            postgres_admin_sql -c 'VACUUM (ANALYZE);'
            ok "PostgreSQL optimization completed"
            return
            ;;
        sync-password)
            [ "$#" -eq 0 ] || die "db sync-password does not accept arguments"
            acquire_lock
            check_container_ownership
            ensure_postgres_running
            saved_database_password=$(read_env_value_from "$env_file" POSTGRES_PASSWORD)
            is_safe_credential "$saved_database_password" || die "Saved POSTGRES_PASSWORD is missing or invalid"
            info "Synchronizing the PostgreSQL role with the saved RisuAI password"
            set_postgres_role_password "$saved_database_password"
            recreate_risuai_for_database_password
            ok "Database password is synchronized"
            return
            ;;
        password)
            password_mode=
            password_file=
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    --generate) [ -z "$password_mode" ] || die "Choose only one password source"; password_mode=generate; shift ;;
                    --password-file) [ "$#" -ge 2 ] || die "--password-file requires a file"; [ -z "$password_mode" ] || die "Choose only one password source"; password_mode=file; password_file=$2; shift 2 ;;
                    -h|--help) printf 'Usage: %s db password [--generate | --password-file FILE]\n' "${0##*/}"; return ;;
                    *) die "Unknown db password option: $1" ;;
                esac
            done
            acquire_lock
            check_container_ownership
            ensure_postgres_running
            case "$password_mode" in
                generate) new_database_password=$(random_secret) ;;
                file) new_database_password=$(read_secret_source "$password_file" "database password file") ;;
                '')
                    if [ -n "$input_postgres_password" ]; then
                        new_database_password=$input_postgres_password
                    else
                        has_controlling_tty || die "Use --generate, --password-file, or POSTGRES_PASSWORD in non-interactive mode"
                        new_database_password=$(prompt_secret "New PostgreSQL password")
                        confirm_database_password=$(prompt_secret "Repeat PostgreSQL password")
                        [ "$new_database_password" = "$confirm_database_password" ] || die "The two passwords do not match"
                    fi
                    ;;
            esac
            validate_new_database_password "$new_database_password"
            old_database_password=$(read_env_value_from "$env_file" POSTGRES_PASSWORD)
            info "Changing PostgreSQL password"
            set_postgres_role_password "$new_database_password"
            if ! replace_env_value "$env_file" POSTGRES_PASSWORD "$new_database_password"; then
                warn "Could not update the saved configuration; restoring the previous PostgreSQL password."
                set_postgres_role_password "$old_database_password" || true
                die "Database password change was rolled back because the configuration could not be updated"
            fi
            recreate_risuai_for_database_password
            ok "Database password changed and saved configuration updated"
            return
            ;;
        *) die "Unknown db command: $db_action (use '${0##*/} db help')" ;;
    esac
}

run_doctor() {
    [ "$#" -eq 0 ] || die "doctor does not accept arguments"
    doctor_failures=0
    info "Checking checkout files"
    for doctor_file in "$compose_base" "$compose_static" "$compose_local" "$compose_lan" "$compose_caddy" "$compose_dynv6" "$compose_cloudflare" "$compose_proxy_docker" "$script_dir/Dockerfile" "$script_dir/Dockerfile.static" "$script_dir/deploy/rustfs/Caddyfile" "$script_dir/deploy/rustfs/Caddyfile.static" "$script_dir/deploy/rustfs/update-dynv6.sh" "$script_dir/deploy/rustfs/update-cloudflare.mjs"; do
        if [ -f "$doctor_file" ]; then ok "Found ${doctor_file#"$script_dir"/}"; else error "Missing $doctor_file"; doctor_failures=$((doctor_failures + 1)); fi
    done
    info "Checking Docker"
    if ! command -v docker >/dev/null 2>&1; then
        error "Docker is not installed"; doctor_failures=$((doctor_failures + 1))
    elif ! docker compose version >/dev/null 2>&1; then
        error "Docker Compose v2 is unavailable"; doctor_failures=$((doctor_failures + 1))
    elif ! docker info >/dev/null 2>&1; then
        error "Docker daemon is unavailable"; doctor_failures=$((doctor_failures + 1))
    else
        ok "Docker daemon and Compose are available"
    fi
    if [ ! -f "$env_file" ]; then
        warn "No saved installation exists; installer prerequisites were checked only."
    else
        info "Checking protected state"
        if validate_state_security; then
            ok "State paths are regular files owned by the current user"
        else
            doctor_failures=$((doctor_failures + 1))
        fi
        if validate_state_permissions; then
            ok "Protected state permissions are restrictive"
        else
            doctor_failures=$((doctor_failures + 1))
        fi
        state_mode=$(file_mode "$state_dir")
        env_mode=$(file_mode "$env_file")
        case "$state_mode" in 700) ok "State directory mode is 0700" ;; unknown) warn "Could not determine state directory permissions" ;; *) error "State directory mode is $state_mode (expected 700)"; doctor_failures=$((doctor_failures + 1)) ;; esac
        case "$env_mode" in 600) ok "Configuration mode is 0600" ;; unknown) warn "Could not determine configuration permissions" ;; *) error "Configuration mode is $env_mode (expected 600)"; doctor_failures=$((doctor_failures + 1)) ;; esac
        if validate_saved_configuration "$env_file"; then
            ok "Saved configuration schema and required secrets are valid"
            doctor_mode=$(stored_mode_from "$env_file")
            doctor_runtime=$(stored_runtime_from "$env_file")
            doctor_dns=$(env_value_or "$env_file" RISUAI_DNS_PROVIDER none)
            doctor_proxy=$(env_value_or "$env_file" RISUAI_PROXY_TYPE none)
            if ( require_files_for_configuration "$doctor_mode" "$doctor_dns" "$doctor_proxy" "$doctor_runtime" ) 2>/dev/null; then ok "Runtime and mode-specific support files are present"; else error "Runtime or mode-specific support files are incomplete"; doctor_failures=$((doctor_failures + 1)); fi
            if docker info >/dev/null 2>&1; then
                if compose config --quiet; then ok "Docker Compose model is valid and isolated from ambient deployment variables"; else error "Docker Compose model is invalid"; doctor_failures=$((doctor_failures + 1)); fi
                if [ "$doctor_mode:$doctor_proxy" = proxy:docker ]; then
                    doctor_network=$(read_env_value_from "$env_file" RISUAI_PROXY_NETWORK)
                    if docker network inspect "$doctor_network" >/dev/null 2>&1; then ok "External proxy network exists"; else error "External proxy network is missing: $doctor_network"; doctor_failures=$((doctor_failures + 1)); fi
                fi
                if services_are_running; then
                    ok "All configured services are running"
                else
                    error "One or more configured services are stopped, restarting, or unhealthy"
                    doctor_failures=$((doctor_failures + 1))
                    compose ps --all || true
                fi
                if [ "$doctor_runtime" = static ]; then
                    ok "Static runtime correctly has no PostgreSQL authentication check"
                elif postgres_is_running; then
                    if postgres_saved_password_matches; then
                        ok "Saved PostgreSQL password authenticates successfully"
                    else
                        error "Saved PostgreSQL password does not match the database role"
                        printf '  Repair: %s db sync-password\n' "${0##*/}" >&2
                        doctor_failures=$((doctor_failures + 1))
                    fi
                else
                    warn "PostgreSQL password authentication was not checked because the service is stopped."
                fi
            fi
            show_deployment_from "$env_file"
        else
            doctor_failures=$((doctor_failures + 1))
        fi
    fi
    if [ "$doctor_failures" -gt 0 ]; then error "Doctor found $doctor_failures blocking problem(s)."; return 1; fi
    ok "Doctor found no blocking configuration problems."
}

manage_existing_installation() {
    require_installation
    case "$action" in
        start|restart|rebuild)
            [ -n "$input_wait_timeout" ] || wait_timeout=$(env_value_or "$env_file" RISUAI_WAIT_TIMEOUT 300)
            is_valid_integer_range "$wait_timeout" 10 3600 || die "Saved readiness timeout must be an integer from 10 to 3600"
            ;;
    esac
    if [ "$action" = config ]; then
        [ "$#" -eq 0 ] || die "config does not accept arguments"
        show_deployment_from "$env_file"
        return
    fi
    require_docker_daemon
    require_local_docker
    installation_id=$(env_value_or "$env_file" RISUAI_INSTALLATION_ID legacy)
    saved_present=true
    adopt_existing=false
    case "$action" in
        status)
            [ "$#" -eq 0 ] || die "status does not accept arguments"
            check_runtime_status
            return
            ;;
        logs)
            logs_follow=true
            logs_tail=200
            logs_service=
            while [ "$#" -gt 0 ]; do
                case "$1" in
                    -f|--follow) logs_follow=true; shift ;;
                    --no-follow) logs_follow=false; shift ;;
                    --tail) [ "$#" -ge 2 ] || die "--tail requires a non-negative integer"; case "$2" in ''|*[!0-9]*) die "Invalid --tail value: $2" ;; esac; logs_tail=$2; shift 2 ;;
                    -h|--help) printf 'Usage: %s logs [--follow|--no-follow] [--tail N] [SERVICE]\n' "${0##*/}"; return ;;
                    --) shift; [ "$#" -le 1 ] || die "logs accepts at most one service"; [ "$#" -eq 0 ] || logs_service=$1; shift "$#" ;;
                    -*) die "Unknown logs option: $1" ;;
                    *) [ -z "$logs_service" ] || die "logs accepts at most one service"; logs_service=$1; shift ;;
                esac
            done
            if [ -n "$logs_service" ]; then
                if ! is_safe_scalar "$logs_service" || ! printf '%s\n' "$logs_service" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$'; then die "Invalid service name: $logs_service"; fi
                expected_services | grep -Fx "$logs_service" >/dev/null 2>&1 || die "Unknown service for the saved mode: $logs_service"
            fi
            if [ "$logs_follow" = true ]; then
                if [ -n "$logs_service" ]; then compose logs --tail "$logs_tail" --follow "$logs_service"; else compose logs --tail "$logs_tail" --follow; fi
            else
                if [ -n "$logs_service" ]; then compose logs --tail "$logs_tail" "$logs_service"; else compose logs --tail "$logs_tail"; fi
            fi
            return
            ;;
    esac
    acquire_lock
    check_container_ownership
    upgrade_legacy_installation_identity
    case "$action" in
        start)
            [ "$#" -eq 0 ] || die "start does not accept arguments"
            load_saved_port_settings
            validate_port_layout
            if [ "$mode:$proxy_type" = proxy:docker ] && ! docker network inspect "$proxy_network" >/dev/null 2>&1; then die "Saved Docker proxy network is missing: $proxy_network"; fi
            check_required_ports
            info "Starting the saved RisuAI deployment"
            runtime_image=$(image_for_runtime "$runtime")
            if docker image inspect "$runtime_image" >/dev/null 2>&1; then compose up -d --remove-orphans; else warn "The local $runtime RisuAI image is missing; building it now."; compose up -d --build --remove-orphans; fi
            wait_for_risuai "$wait_timeout" || die "RisuAI did not become ready within ${wait_timeout}s"
            compose ps --all
            show_deployment_from "$env_file"
            ;;
        stop)
            [ "$#" -eq 0 ] || die "stop does not accept arguments"
            info "Stopping RisuAI without deleting containers or data"
            compose stop
            ;;
        down)
            [ "$#" -eq 0 ] || die "down does not accept arguments"
            info "Removing RisuAI containers and private networks; persistent data is kept"
            compose down --remove-orphans
            ;;
        restart)
            [ "$#" -eq 0 ] || die "restart does not accept arguments"
            load_saved_port_settings
            validate_port_layout
            if [ "$mode:$proxy_type" = proxy:docker ] && ! docker network inspect "$proxy_network" >/dev/null 2>&1; then die "Saved Docker proxy network is missing: $proxy_network"; fi
            check_required_ports
            info "Reconciling and restarting all RisuAI containers"
            runtime_image=$(image_for_runtime "$runtime")
            if docker image inspect "$runtime_image" >/dev/null 2>&1; then compose up -d --remove-orphans; else warn "The local $runtime RisuAI image is missing; building it now."; compose up -d --build --remove-orphans; fi
            compose restart
            wait_for_risuai "$wait_timeout" || die "RisuAI did not become ready within ${wait_timeout}s"
            compose ps --all
            ;;
        rebuild)
            [ "$#" -eq 0 ] || die "rebuild does not accept arguments"
            load_saved_port_settings
            validate_port_layout
            if [ "$mode:$proxy_type" = proxy:docker ] && ! docker network inspect "$proxy_network" >/dev/null 2>&1; then die "Saved Docker proxy network is missing: $proxy_network"; fi
            check_required_ports
            info "Rebuilding and recreating the RisuAI application"
            compose build risuai
            compose up -d --force-recreate risuai
            compose up -d --remove-orphans
            wait_for_risuai "$wait_timeout" || die "Rebuilt RisuAI did not become ready within ${wait_timeout}s"
            compose ps --all
            ;;
        *) die "Internal error: unsupported management action $action" ;;
    esac
}

wait_timeout=${input_wait_timeout:-300}
case "$action" in
    start|restart|rebuild)
        is_valid_integer_range "$wait_timeout" 10 3600 || die "RISUAI_WAIT_TIMEOUT must be an integer from 10 to 3600"
        ;;
esac

if [ "$action" = doctor ]; then run_doctor "$@"; exit $?; fi
if [ "$action" = db ]; then manage_database "$@"; exit $?; fi
if [ "$action" != install ]; then manage_existing_installation "$@"; exit $?; fi

# ------------------------------ install ------------------------------

runtime=$input_runtime
mode=$input_mode
domain=$input_domain
dns_provider=$input_dns_provider
proxy_type=$input_proxy_type
proxy_network=$input_proxy_network
cloudflare_zone_id=$input_cloudflare_zone_id
cloudflare_token=$input_cloudflare_token
dynv6_token=$input_dynv6_token
app_port=$input_app_port
rustfs_api_port=$input_rustfs_api_port
rustfs_console_port=$input_rustfs_console_port
http_port=$input_http_port
https_port=$input_https_port
ddns_interval=$input_ddns_interval
ipv6_input=$input_ipv6
postgres_password=$input_postgres_password
rustfs_access_key=$input_rustfs_access_key
rustfs_secret_key=$input_rustfs_secret_key

assume_yes=false
skip_ddns_check=false
skip_port_check=false
configure_firewall=false
no_start=false
dry_run=false
adopt_existing=false
wait_timeout_explicit=false
[ -n "$input_wait_timeout" ] && wait_timeout_explicit=true
dynv6_token_source=none
cloudflare_token_source=none
dynv6_token_path=
cloudflare_token_path=
dynv6_cli_source=none
cloudflare_cli_source=none
[ -n "$dynv6_token" ] && dynv6_token_source=environment
[ -n "$cloudflare_token" ] && cloudflare_token_source=environment
http_port_explicit=false
https_port_explicit=false
rustfs_api_port_explicit=false
rustfs_console_port_explicit=false
[ -n "$http_port" ] && http_port_explicit=true
[ -n "$https_port" ] && https_port_explicit=true
[ -n "$rustfs_api_port" ] && rustfs_api_port_explicit=true
[ -n "$rustfs_console_port" ] && rustfs_console_port_explicit=true

while [ "$#" -gt 0 ]; do
    case "$1" in
        --runtime) [ "$#" -ge 2 ] || die "--runtime requires a value"; runtime=$2; shift 2 ;;
        --mode) [ "$#" -ge 2 ] || die "--mode requires a value"; mode=$2; shift 2 ;;
        --domain) [ "$#" -ge 2 ] || die "--domain requires a value"; domain=$2; shift 2 ;;
        --dns-provider) [ "$#" -ge 2 ] || die "--dns-provider requires a value"; dns_provider=$2; shift 2 ;;
        --cloudflare-zone-id) [ "$#" -ge 2 ] || die "--cloudflare-zone-id requires a value"; cloudflare_zone_id=$2; shift 2 ;;
        --cloudflare-token-file)
            [ "$#" -ge 2 ] || die "--cloudflare-token-file requires a value"
            [ "$cloudflare_cli_source" = none ] || die "Choose exactly one Cloudflare token source"
            cloudflare_token=; cloudflare_token_path=$2; cloudflare_cli_source='file'; cloudflare_token_source='file'; shift 2
            ;;
        --cloudflare-token)
            [ "$#" -ge 2 ] || die "--cloudflare-token requires a value"
            [ "$cloudflare_cli_source" = none ] || die "Choose exactly one Cloudflare token source"
            cloudflare_token=$2; cloudflare_token_path=; cloudflare_cli_source=argv; cloudflare_token_source=argv; shift 2
            ;;
        --dynv6-token-file)
            [ "$#" -ge 2 ] || die "--dynv6-token-file requires a value"
            [ "$dynv6_cli_source" = none ] || die "Choose exactly one dynv6 token source"
            dynv6_token=; dynv6_token_path=$2; dynv6_cli_source='file'; dynv6_token_source='file'; shift 2
            ;;
        --dynv6-token|--token)
            [ "$#" -ge 2 ] || die "$1 requires a value"
            [ "$dynv6_cli_source" = none ] || die "Choose exactly one dynv6 token source"
            dynv6_token=$2; dynv6_token_path=; dynv6_cli_source=argv; dynv6_token_source=argv; shift 2
            ;;
        --proxy-type) [ "$#" -ge 2 ] || die "--proxy-type requires a value"; proxy_type=$2; shift 2 ;;
        --proxy-network) [ "$#" -ge 2 ] || die "--proxy-network requires a value"; proxy_network=$2; shift 2 ;;
        --app-port) [ "$#" -ge 2 ] || die "--app-port requires a value"; app_port=$2; shift 2 ;;
        --rustfs-api-port) [ "$#" -ge 2 ] || die "--rustfs-api-port requires a value"; rustfs_api_port=$2; rustfs_api_port_explicit=true; shift 2 ;;
        --rustfs-console-port) [ "$#" -ge 2 ] || die "--rustfs-console-port requires a value"; rustfs_console_port=$2; rustfs_console_port_explicit=true; shift 2 ;;
        --http-port) [ "$#" -ge 2 ] || die "--http-port requires a value"; http_port=$2; http_port_explicit=true; shift 2 ;;
        --https-port) [ "$#" -ge 2 ] || die "--https-port requires a value"; https_port=$2; https_port_explicit=true; shift 2 ;;
        --ddns-interval) [ "$#" -ge 2 ] || die "--ddns-interval requires a value"; ddns_interval=$2; shift 2 ;;
        --wait-timeout) [ "$#" -ge 2 ] || die "--wait-timeout requires a value"; wait_timeout=$2; wait_timeout_explicit=true; shift 2 ;;
        --ipv6) ipv6_input=true; shift ;;
        --no-ipv6) ipv6_input=false; shift ;;
        --skip-ddns-check) skip_ddns_check=true; shift ;;
        --skip-port-check) skip_port_check=true; shift ;;
        --configure-firewall) configure_firewall=true; shift ;;
        --no-start) no_start=true; shift ;;
        --dry-run) dry_run=true; no_start=true; shift ;;
        --adopt-existing) adopt_existing=true; shift ;;
        -y|--yes) assume_yes=true; shift ;;
        --no-color) color_blue=; color_yellow=; color_red=; color_green=; color_reset=; shift ;;
        -h|--help) usage; exit 0 ;;
        --) shift; [ "$#" -eq 0 ] || die "install does not accept positional arguments" ;;
        *) die "Unknown install option: $1" ;;
    esac
done

is_valid_integer_range "$wait_timeout" 10 3600 || die "--wait-timeout must be an integer from 10 to 3600"
interactive=false
if [ "$assume_yes" = false ] && has_controlling_tty; then interactive=true; fi

required_file "$compose_base" "base Compose file"
acquire_lock
saved_present=false
saved_configuration_valid=false
saved_mode=
saved_runtime=
if [ -f "$env_file" ]; then
    saved_present=true
    if validate_saved_configuration "$env_file"; then
        saved_configuration_valid=true
        saved_mode=$(stored_mode_from "$env_file")
        saved_runtime=$(stored_runtime_from "$env_file")
    else
        [ -n "$mode" ] || die "The existing configuration is damaged; specify a complete replacement with --mode after reviewing $env_file"
        warn "The existing configuration is invalid. It will be backed up and replaced only after validation."
    fi
fi

if [ -z "$runtime" ] && [ "$saved_configuration_valid" = true ]; then runtime=$saved_runtime; fi
if [ -z "$runtime" ] && [ "$interactive" = true ]; then runtime=$(prompt_line "Application runtime (node or static)" node); fi
[ -n "$runtime" ] || runtime=node
case "$runtime" in node|static) ;; *) die "Invalid --runtime: $runtime (expected node or static)" ;; esac
if [ "$runtime" = static ]; then
    if [ "$rustfs_api_port_explicit" = true ] || [ "$rustfs_console_port_explicit" = true ]; then die "--rustfs-api-port/--rustfs-console-port are only valid with --runtime node"; fi
    # Storage credentials from the shell are irrelevant to a static deployment
    # and must not leak into its saved configuration. Credentials already saved
    # by a previous Node deployment are preserved later for a reversible switch.
    postgres_password=
    rustfs_access_key=
    rustfs_secret_key=
fi

if [ -z "$mode" ] && [ -n "$domain" ] && [ -n "$dynv6_token" ]; then mode=dynv6; fi
if [ -z "$mode" ] && [ "$saved_configuration_valid" = true ]; then mode=$saved_mode; fi
if [ -z "$mode" ]; then
    if [ "$interactive" != true ]; then die "Non-interactive installation requires --mode (or a valid existing installation)"; fi
    cat >/dev/tty <<'EOF'

Choose how RisuAI will be reached:
  1) local  - this machine only (default)
  2) lan    - all IPv4 interfaces, unencrypted HTTP
  3) domain - Caddy HTTPS with manual DNS or Cloudflare DDNS
  4) dynv6  - Caddy HTTPS with dynv6 DDNS
  5) proxy  - an existing host or Docker reverse proxy
EOF
    while :; do
        selection=$(prompt_line "Selection" "1")
        case "$selection" in
            1|local) mode=local; break ;;
            2|lan) mode=lan; break ;;
            3|domain) mode=domain; break ;;
            4|dynv6) mode=dynv6; break ;;
            5|proxy) mode=proxy; break ;;
            *) warn "Choose 1..5 or a mode name." ;;
        esac
    done
fi
case "$mode" in local|lan|domain|dynv6|proxy) ;; *) die "Invalid --mode: $mode" ;; esac

if [ "$mode" = domain ]; then
    if [ -z "$dns_provider" ] && [ "$saved_configuration_valid" = true ] && [ "$saved_mode" = domain ]; then dns_provider=$(env_value_or "$env_file" RISUAI_DNS_PROVIDER manual); fi
    if [ -z "$dns_provider" ] && [ "$interactive" = true ]; then dns_provider=$(prompt_line "DNS provider (manual or cloudflare)" manual); fi
    [ -n "$dns_provider" ] || dns_provider=manual
    case "$dns_provider" in manual|cloudflare) ;; *) die "Invalid --dns-provider: $dns_provider" ;; esac
else
    case "$dns_provider" in ''|none) dns_provider=none ;; *) die "--dns-provider is only valid with --mode domain" ;; esac
fi

if [ "$mode" = proxy ]; then
    if [ -z "$proxy_type" ] && [ "$saved_configuration_valid" = true ] && [ "$saved_mode" = proxy ]; then proxy_type=$(env_value_or "$env_file" RISUAI_PROXY_TYPE host); fi
    if [ -z "$proxy_type" ] && [ "$interactive" = true ]; then proxy_type=$(prompt_line "Proxy type (host or docker)" host); fi
    [ -n "$proxy_type" ] || die "--mode proxy requires --proxy-type host|docker in non-interactive mode"
    case "$proxy_type" in host|docker) ;; *) die "Invalid --proxy-type: $proxy_type" ;; esac
    if [ "$proxy_type" = docker ]; then
        if [ -z "$proxy_network" ] && [ "$saved_configuration_valid" = true ] && [ "$saved_mode" = proxy ]; then proxy_network=$(read_env_value_from "$env_file" RISUAI_PROXY_NETWORK); fi
        if [ -z "$proxy_network" ] && [ "$interactive" = true ]; then proxy_network=$(prompt_line "Existing Docker proxy network" ""); fi
        is_valid_proxy_network "$proxy_network" || die "Invalid or missing Docker proxy network name: $proxy_network"
    else
        [ -z "$proxy_network" ] || die "--proxy-network is only valid with --proxy-type docker"
    fi
else
    case "$proxy_type" in ''|none) proxy_type=none ;; *) die "--proxy-type is only valid with --mode proxy" ;; esac
    [ -z "$proxy_network" ] || die "--proxy-network is only valid with --mode proxy"
fi

case "$mode" in
    domain|dynv6)
        if [ -z "$domain" ] && [ "$saved_configuration_valid" = true ]; then case "$saved_mode" in domain|dynv6) domain=$(read_env_value_from "$env_file" RISUAI_DOMAIN) ;; esac; fi
        if [ -z "$domain" ] && [ "$interactive" = true ]; then domain=$(prompt_line "Fully qualified hostname" ""); fi
        domain=$(normalize_hostname "$domain")
        is_valid_hostname "$domain" || die "Invalid fully qualified hostname: $domain (Unicode names must use punycode)"
        ;;
    *) [ -z "$domain" ] || die "--domain is only valid with domain or dynv6 mode" ;;
esac
if [ "$mode" = dynv6 ]; then case "$domain" in *.dynv6.net) ;; *) die "dynv6 mode requires a hostname below dynv6.net" ;; esac; fi

if [ -z "$app_port" ] && [ "$saved_configuration_valid" = true ]; then app_port=$(env_value_or "$env_file" RISUAI_PORT 6001); fi
if [ -z "$rustfs_api_port" ] && [ "$saved_configuration_valid" = true ]; then rustfs_api_port=$(env_value_or "$env_file" RUSTFS_API_PORT 9000); fi
if [ -z "$rustfs_console_port" ] && [ "$saved_configuration_valid" = true ]; then rustfs_console_port=$(env_value_or "$env_file" RUSTFS_CONSOLE_PORT 9001); fi
if [ -z "$http_port" ] && [ "$saved_configuration_valid" = true ]; then http_port=$(env_value_or "$env_file" RISUAI_HTTP_PORT 80); fi
if [ -z "$https_port" ] && [ "$saved_configuration_valid" = true ]; then https_port=$(env_value_or "$env_file" RISUAI_HTTPS_PORT 443); fi
app_port=$(normalize_port "${app_port:-6001}")
rustfs_api_port=$(normalize_port "${rustfs_api_port:-9000}")
rustfs_console_port=$(normalize_port "${rustfs_console_port:-9001}")
http_port=$(normalize_port "${http_port:-80}")
https_port=$(normalize_port "${https_port:-443}")
if [ "$mode:$proxy_type" = proxy:docker ] && [ "$app_port" != 6001 ]; then die "--app-port has no host mapping with --proxy-type docker; use internal upstream risuai:6001"; fi
if [ "$mode" != domain ] && [ "$mode" != dynv6 ] && { [ "$http_port_explicit" = true ] || [ "$https_port_explicit" = true ]; }; then die "--http-port/--https-port are only valid with domain or dynv6 mode"; fi

if [ -z "$ddns_interval" ] && [ "$saved_configuration_valid" = true ]; then ddns_interval=$(env_value_or "$env_file" DYNV6_UPDATE_INTERVAL 300); fi
ddns_interval=${ddns_interval:-300}
is_valid_integer_range "$ddns_interval" 60 86400 || die "--ddns-interval must be an integer from 60 to 86400"
if [ "$wait_timeout_explicit" = false ] && [ "$saved_configuration_valid" = true ]; then wait_timeout=$(env_value_or "$env_file" RISUAI_WAIT_TIMEOUT 300); fi
is_valid_integer_range "$wait_timeout" 10 3600 || die "--wait-timeout must be an integer from 10 to 3600"
if [ -z "$ipv6_input" ] && [ "$saved_configuration_valid" = true ] && { [ "$mode" = dynv6 ] || [ "$mode:$dns_provider" = domain:cloudflare ]; }; then ipv6_input=$(env_value_or "$env_file" DYNV6_IPV6 false); fi
enable_ipv6=$(normalize_bool "${ipv6_input:-false}") || die "Invalid IPv6 boolean: $ipv6_input"
if [ "$enable_ipv6" = true ] && [ "$mode" != dynv6 ] && [ "$mode:$dns_provider" != domain:cloudflare ]; then die "--ipv6 is only valid with dynv6 or Cloudflare DDNS"; fi

if [ -n "$dynv6_token_path" ]; then dynv6_token=$(read_secret_source "$dynv6_token_path" "dynv6 token file"); fi
if [ -n "$cloudflare_token_path" ]; then cloudflare_token=$(read_secret_source "$cloudflare_token_path" "Cloudflare token file"); fi
if [ "$mode" = dynv6 ]; then
    if [ -z "$dynv6_token" ] && [ -s "$dynv6_token_file" ]; then dynv6_token=$(sed -n '1p' "$dynv6_token_file"); dynv6_token_source=saved; fi
    if [ -z "$dynv6_token" ] && [ "$interactive" = true ]; then dynv6_token=$(prompt_secret "dynv6 HTTP token"); dynv6_token_source=prompt; fi
    is_valid_secret "$dynv6_token" || die "A non-empty dynv6 token is required"
else
    [ -z "$dynv6_token" ] || die "A dynv6 token is only valid in dynv6 mode"
fi
if [ "$mode:$dns_provider" = domain:cloudflare ]; then
    if [ -z "$cloudflare_zone_id" ] && [ "$saved_configuration_valid" = true ] && [ "$saved_mode" = domain ] && [ "$(env_value_or "$env_file" RISUAI_DNS_PROVIDER none)" = cloudflare ]; then cloudflare_zone_id=$(read_env_value_from "$env_file" CLOUDFLARE_ZONE_ID); fi
    if [ -z "$cloudflare_zone_id" ] && [ "$interactive" = true ]; then cloudflare_zone_id=$(prompt_line "Cloudflare Zone ID" ""); fi
    if ! is_safe_scalar "$cloudflare_zone_id" || ! printf '%s\n' "$cloudflare_zone_id" | grep -Eq '^[0-9A-Fa-f]{32}$'; then die "Invalid Cloudflare Zone ID (expected 32 hexadecimal characters)"; fi
    if [ -z "$cloudflare_token" ] && [ -s "$cloudflare_token_file" ]; then cloudflare_token=$(sed -n '1p' "$cloudflare_token_file"); cloudflare_token_source=saved; fi
    if [ -z "$cloudflare_token" ] && [ "$interactive" = true ]; then cloudflare_token=$(prompt_secret "Cloudflare Zone-scoped DNS Write token"); cloudflare_token_source=prompt; fi
    is_valid_secret "$cloudflare_token" || die "A non-empty Cloudflare token is required"
else
    if [ -n "$cloudflare_zone_id" ] || [ -n "$cloudflare_token" ]; then die "Cloudflare options require --mode domain --dns-provider cloudflare"; fi
fi
case "$dynv6_token_source $cloudflare_token_source" in *argv*) warn "A provider token was supplied in process argv; prefer the corresponding --*-token-file option." ;; esac

validate_port_layout
require_files_for_configuration "$mode" "$dns_provider" "$proxy_type" "$runtime"
require_docker_daemon
require_local_docker
if [ "$mode:$proxy_type" = proxy:docker ] && ! docker network inspect "$proxy_network" >/dev/null 2>&1; then die "Docker network '$proxy_network' does not exist. Create it first or select --proxy-type host."; fi

if [ "$saved_configuration_valid" = true ]; then saved_id=$(read_env_value_from "$env_file" RISUAI_INSTALLATION_ID); else saved_id=; fi
if [ -n "$saved_id" ]; then installation_id=$saved_id; else installation_id=$(random_secret | cut -c1-32); fi
check_container_ownership

if [ "$no_start" = true ] && [ "$dry_run" = false ] && [ "$saved_configuration_valid" = true ] && compose ps --status running --services 2>/dev/null | grep -q .; then
    die "--no-start cannot replace the active configuration while this deployment is running; run '$script_path down' first, use --dry-run, or omit --no-start"
fi

postgres_volume=${project_name}_risuai-postgres
rustfs_volume=${project_name}_rustfs-data
if [ "$runtime" = node ] && [ "$saved_present" = false ]; then
    existing_data=false
    docker volume inspect "$postgres_volume" >/dev/null 2>&1 && existing_data=true
    docker volume inspect "$rustfs_volume" >/dev/null 2>&1 && existing_data=true
    if [ "$existing_data" = true ] && [ "$adopt_existing" != true ]; then die "Persistent RisuAI volumes exist but this checkout has no protected configuration. Refusing to generate incompatible credentials; recover .risuai or rerun with --adopt-existing and explicit credentials after verifying the volumes."; fi
fi

if [ "$saved_configuration_valid" = true ]; then
    saved_postgres_password=$(read_env_value_from "$env_file" POSTGRES_PASSWORD)
    saved_rustfs_access_key=$(read_env_value_from "$env_file" RUSTFS_ACCESS_KEY)
    saved_rustfs_secret_key=$(read_env_value_from "$env_file" RUSTFS_SECRET_KEY)
    if [ -n "$postgres_password" ] && [ -n "$saved_postgres_password" ] && [ "$postgres_password" != "$saved_postgres_password" ]; then die "POSTGRES_PASSWORD cannot be changed during reinstall; use '$script_path db password' (or 'db password --generate') so PostgreSQL and RisuAI stay synchronized"; fi
    if [ -n "$rustfs_access_key" ] && [ -n "$saved_rustfs_access_key" ] && [ "$rustfs_access_key" != "$saved_rustfs_access_key" ]; then die "RUSTFS_ACCESS_KEY cannot be changed during reinstall"; fi
    if [ -n "$rustfs_secret_key" ] && [ -n "$saved_rustfs_secret_key" ] && [ "$rustfs_secret_key" != "$saved_rustfs_secret_key" ]; then die "RUSTFS_SECRET_KEY cannot be changed during reinstall"; fi
    [ -z "$saved_postgres_password" ] || postgres_password=$saved_postgres_password
    [ -z "$saved_rustfs_access_key" ] || rustfs_access_key=$saved_rustfs_access_key
    [ -z "$saved_rustfs_secret_key" ] || rustfs_secret_key=$saved_rustfs_secret_key
fi
if [ "$runtime" = node ]; then
    if [ -z "$postgres_password" ] && [ "$adopt_existing" = true ]; then postgres_password=$(recover_container_env risuai-postgres POSTGRES_PASSWORD); fi
    if [ -z "$rustfs_access_key" ] && [ "$adopt_existing" = true ]; then rustfs_access_key=$(recover_container_env risuai-rustfs RUSTFS_ACCESS_KEY); fi
    if [ -z "$rustfs_secret_key" ] && [ "$adopt_existing" = true ]; then rustfs_secret_key=$(recover_container_env risuai-rustfs RUSTFS_SECRET_KEY); fi
    if docker volume inspect "$postgres_volume" >/dev/null 2>&1 && [ -z "$postgres_password" ]; then die "Existing PostgreSQL data requires its original POSTGRES_PASSWORD"; fi
    if docker volume inspect "$rustfs_volume" >/dev/null 2>&1 && { [ -z "$rustfs_access_key" ] || [ -z "$rustfs_secret_key" ]; }; then die "Existing RustFS data requires its original RUSTFS_ACCESS_KEY and RUSTFS_SECRET_KEY"; fi
    [ -n "$postgres_password" ] || postgres_password=$(random_secret)
    [ -n "$rustfs_access_key" ] || rustfs_access_key=risuai-$(random_secret | cut -c1-24)
    [ -n "$rustfs_secret_key" ] || rustfs_secret_key=$(random_secret)
    is_safe_credential "$postgres_password" || die "POSTGRES_PASSWORD must contain only URL-safe A-Z/a-z/0-9/._~- characters"
    is_safe_credential "$rustfs_access_key" || die "RUSTFS_ACCESS_KEY contains unsupported characters"
    is_safe_credential "$rustfs_secret_key" || die "RUSTFS_SECRET_KEY contains unsupported characters"
fi

check_required_ports

if [ "$assume_yes" != true ] && [ "$dry_run" != true ]; then
    [ "$interactive" = true ] || die "No controlling terminal is available for confirmation; rerun with --yes after reviewing --dry-run output"
    printf '\nInstallation plan:\n'
    printf '  Runtime:           %s\n' "$runtime"
    printf '  Mode:              %s\n' "$mode"
    printf '  Configured target: %s\n' "$(case "$mode:$proxy_type" in local:*) printf 'http://localhost:%s' "$app_port" ;; lan:*) printf 'http://SERVER-IP:%s' "$app_port" ;; domain:*|dynv6:*) if [ "$https_port" = 443 ]; then printf 'https://%s' "$domain"; else printf 'https://%s:%s' "$domain" "$https_port"; fi ;; proxy:host) printf 'http://127.0.0.1:%s' "$app_port" ;; proxy:docker) printf 'http://risuai:6001 on %s' "$proxy_network" ;; esac)"
    if [ "$runtime" = node ]; then printf '  RustFS:            loopback ports %s/%s only\n' "$rustfs_api_port" "$rustfs_console_port"; else printf '  Web server:        Caddy serving the browser-only static build\n'; fi
    [ "$saved_present" = false ] || printf '  Existing data:     credentials and volumes will be preserved\n'
    case "$mode" in lan) warn "LAN mode listens on every IPv4 interface without TLS." ;; domain|dynv6) warn "Public/NAT TCP mappings must ultimately expose HTTP on 80 and HTTPS on 443 for automatic certificates." ;; esac
    prompt_confirmation "Apply this plan?" no || { info "Installation cancelled"; exit 0; }
fi

umask 077
tmp_env=$(mktemp "$state_dir/rustfs.env.new.XXXXXX") || die "Cannot create staged configuration"
tmp_dynv6=$(mktemp "$state_dir/dynv6-token.new.XXXXXX") || die "Cannot create staged dynv6 token"
tmp_cloudflare=$(mktemp "$state_dir/cloudflare-token.new.XXXXXX") || die "Cannot create staged Cloudflare token"
printf '%s' "$dynv6_token" >"$tmp_dynv6" || die "Cannot stage dynv6 token"
printf '%s' "$cloudflare_token" >"$tmp_cloudflare" || die "Cannot stage Cloudflare token"
chmod 600 "$tmp_env" "$tmp_dynv6" "$tmp_cloudflare" || die "Cannot protect staged configuration"
staged_dynv6_path=./.risuai/${tmp_dynv6##*/}
staged_cloudflare_path=./.risuai/${tmp_cloudflare##*/}

write_env() {
    write_destination=$1
    write_dynv6_path=$2
    write_cloudflare_path=$3
    cat >"$write_destination" <<EOF
RISUAI_CONFIG_VERSION=$config_version
COMPOSE_PROJECT_NAME=$project_name
RISUAI_INSTALLATION_ID=$installation_id
RISUAI_RUNTIME=$runtime
RISUAI_MODE=$mode
RISUAI_DNS_PROVIDER=$dns_provider
RISUAI_PROXY_TYPE=$proxy_type
RISUAI_PROXY_NETWORK=$proxy_network
RISUAI_PORT=$app_port
RISUAI_HTTP_PORT=$http_port
RISUAI_HTTPS_PORT=$https_port
POSTGRES_PASSWORD=$postgres_password
RUSTFS_ACCESS_KEY=$rustfs_access_key
RUSTFS_SECRET_KEY=$rustfs_secret_key
RUSTFS_BIND_ADDRESS=127.0.0.1
RUSTFS_API_PORT=$rustfs_api_port
RUSTFS_CONSOLE_PORT=$rustfs_console_port
RISUAI_DOMAIN=$domain
DYNV6_ZONE=$domain
DYNV6_IPV6=$enable_ipv6
DYNV6_TOKEN_FILE=$write_dynv6_path
DYNV6_UPDATE_INTERVAL=$ddns_interval
CLOUDFLARE_ZONE_ID=$cloudflare_zone_id
CLOUDFLARE_IPV6=$enable_ipv6
CLOUDFLARE_TOKEN_FILE=$write_cloudflare_path
CLOUDFLARE_UPDATE_INTERVAL=$ddns_interval
RISUAI_WAIT_TIMEOUT=$wait_timeout
EOF
}

write_env "$tmp_env" "$staged_dynv6_path" "$staged_cloudflare_path"
info "Validating the isolated prospective Compose model"
compose_with_env "$tmp_env" "$staged_dynv6_path" "$staged_cloudflare_path" config --quiet || die "Prospective Docker Compose configuration is invalid"

if [ "$dry_run" = true ]; then
    ok "Dry run succeeded; no configuration, DNS, firewall, image, or container was changed."
    show_deployment_from "$tmp_env"
    exit 0
fi

if [ "$no_start" = false ]; then
    info "Building RisuAI before changing the active configuration"
    compose_with_env "$tmp_env" "$staged_dynv6_path" "$staged_cloudflare_path" build risuai
    if [ "$skip_ddns_check" = false ]; then
        case "$mode:$dns_provider" in
            dynv6:*)
                info "Validating and updating dynv6 once"
                compose_with_env "$tmp_env" "$staged_dynv6_path" "$staged_cloudflare_path" run --rm --no-deps -e DYNV6_ONCE=true dynv6 || die "dynv6 rejected the update; check hostname, token, IPv6, and network connectivity"
                ;;
            domain:cloudflare)
                info "Validating and updating Cloudflare DNS once"
                compose_with_env "$tmp_env" "$staged_dynv6_path" "$staged_cloudflare_path" run --rm --no-deps -e CLOUDFLARE_ONCE=true -e CLOUDFLARE_FORCE_WRITE=true cloudflare-ddns || die "Cloudflare DDNS failed; check Zone ID, DNS Write token scope, hostname, IPv6, and connectivity"
                ;;
        esac
    else
        warn "Skipping the live DDNS validation/update by request."
    fi
fi

# Snapshot the previous protected generation before changing active files.
if [ -f "$env_file" ]; then had_env=true; backup_env=$(mktemp "$state_dir/rustfs.env.rollback.XXXXXX"); cp -p "$env_file" "$backup_env"; fi
if [ -f "$dynv6_token_file" ]; then had_dynv6=true; backup_dynv6=$(mktemp "$state_dir/dynv6-token.rollback.XXXXXX"); cp -p "$dynv6_token_file" "$backup_dynv6"; fi
if [ -f "$cloudflare_token_file" ]; then had_cloudflare=true; backup_cloudflare=$(mktemp "$state_dir/cloudflare-token.rollback.XXXXXX"); cp -p "$cloudflare_token_file" "$backup_cloudflare"; fi
if [ "$saved_configuration_valid" = true ] && compose ps --status running --services 2>/dev/null | grep -q .; then old_was_running=true; fi

transaction_active=true
if [ "$mode" = dynv6 ]; then mv -f "$tmp_dynv6" "$dynv6_token_file"; tmp_dynv6=; fi
if [ "$mode:$dns_provider" = domain:cloudflare ]; then mv -f "$tmp_cloudflare" "$cloudflare_token_file"; tmp_cloudflare=; fi
write_env "$tmp_env" ./.risuai/dynv6-token ./.risuai/cloudflare-token
chmod 600 "$tmp_env"
mv -f "$tmp_env" "$env_file"
tmp_env=
chmod 600 "$env_file"

if [ "$no_start" = false ]; then
    if [ "$runtime" = node ]; then
        mkdir -p "$script_dir/save" || die "Cannot create the persistent save directory"
        [ -w "$script_dir/save" ] || die "Persistent save directory is not writable: $script_dir/save"
    fi
    info "Starting the validated deployment"
    compose up -d --remove-orphans
    wait_for_risuai "$wait_timeout" || die "RisuAI did not become ready within ${wait_timeout}s"
else
    warn "Configuration was saved without building or starting containers. The next 'start' builds if needed."
fi

transaction_committed=true
transaction_active=false
if [ "$mode" != dynv6 ]; then rm -f "$dynv6_token_file"; fi
if [ "$mode:$dns_provider" != domain:cloudflare ]; then rm -f "$cloudflare_token_file"; fi

if [ "$configure_firewall" = true ]; then
    if [ "$mode" != domain ] && [ "$mode" != dynv6 ]; then
        warn "--configure-firewall has no effect outside domain/dynv6 mode."
    elif ! command -v ufw >/dev/null 2>&1; then
        warn "UFW is not installed; no firewall rules were changed."
    else
        firewall_status=$(ufw status 2>&1 || true)
        if printf '%s\n' "$firewall_status" | grep -q '^Status: active'; then
            info "Adding requested UFW host-port rules (Docker-published ports may require additional DOCKER-USER policy)"
            ufw allow "$http_port/tcp" >/dev/null 2>&1 || warn "Could not add UFW rule for $http_port/tcp"
            ufw allow "$https_port/tcp" >/dev/null 2>&1 || warn "Could not add UFW rule for $https_port/tcp"
            ufw allow "$https_port/udp" >/dev/null 2>&1 || warn "Could not add UFW rule for $https_port/udp"
        elif printf '%s\n' "$firewall_status" | grep -q '^Status: inactive'; then
            warn "UFW is inactive; no rules were added."
        else
            warn "Could not inspect UFW (possibly insufficient privileges); no rules were added."
        fi
    fi
fi

if [ "$no_start" = false ]; then printf '\nRisuAI is running.\n'; else printf '\nRisuAI configuration is installed but not started.\n'; fi
show_deployment_from "$env_file"
case "$mode" in
    lan) warn "Traffic on the published app port is unencrypted; do not expose it to the internet." ;;
    domain|dynv6) printf '\nDNS propagation and the first TLS certificate can take several minutes. UDP %s is optional HTTP/3; TCP HTTP/HTTPS mappings are required for normal access.\n' "$https_port" ;;
esac
printf '\nManage this installation with:\n  %s start|stop|restart|rebuild|down|status|logs|doctor|config\n' "$script_path"
