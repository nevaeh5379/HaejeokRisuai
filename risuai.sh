#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state_dir="$script_dir/.risuai"
env_file="$state_dir/rustfs.env"
dynv6_token_file="$state_dir/dynv6-token"
cloudflare_token_file="$state_dir/cloudflare-token"
compose_base="$script_dir/docker-compose.rustfs.yml"
compose_local="$script_dir/docker-compose.rustfs.local.yml"
compose_lan="$script_dir/docker-compose.rustfs.lan.yml"
compose_caddy="$script_dir/docker-compose.rustfs.caddy.yml"
compose_dynv6="$script_dir/docker-compose.rustfs.dynv6.yml"
compose_cloudflare="$script_dir/docker-compose.rustfs.cloudflare.yml"
compose_proxy_docker="$script_dir/docker-compose.rustfs.proxy-docker.yml"

action=install
assume_yes=false
enable_ipv6=false
mode=${RISUAI_MODE:-}
domain=${RISUAI_DOMAIN:-${DYNV6_ZONE:-}}
dns_provider=${RISUAI_DNS_PROVIDER:-}
cloudflare_zone_id=${CLOUDFLARE_ZONE_ID:-}
cloudflare_token=${CLOUDFLARE_TOKEN:-}
dynv6_token=${DYNV6_TOKEN:-}
proxy_type=${RISUAI_PROXY_TYPE:-}
proxy_network=${RISUAI_PROXY_NETWORK:-}

case "${1:-}" in
    install|start|stop|restart|rebuild|status|logs) action=$1; shift ;;
esac

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
RisuAI PostgreSQL + RustFS installer and manager

Usage:
  ./risuai.sh [install] [options]
  ./risuai.sh start|stop|restart|rebuild|status
  ./risuai.sh logs [service]

Install modes:
  local    http://localhost:6001 (default in the interactive menu)
  lan      http://SERVER-IP:6001 on all network interfaces
  domain   HTTPS with Caddy and manual DNS or Cloudflare DDNS
  dynv6    HTTPS with Caddy and dynv6 DDNS
  proxy    Use an existing host or Docker reverse proxy

Options:
  --mode MODE                 local, lan, domain, dynv6, or proxy
  --domain HOSTNAME           HTTPS hostname
  --dns-provider PROVIDER     manual or cloudflare (domain mode)
  --cloudflare-zone-id ID     32-character Cloudflare Zone ID
  --cloudflare-token TOKEN    Zone-scoped DNS Write API token
  --dynv6-token TOKEN         dynv6 HTTP token
  --token TOKEN               Compatibility alias for --dynv6-token
  --proxy-type TYPE           host or docker
  --proxy-network NAME        Existing external Docker network
  --ipv6                      Also update the AAAA record for DDNS
  -y, --yes                   Do not ask for confirmation
  -h, --help                  Show this help

Examples:
  ./risuai.sh install
  ./risuai.sh install --mode local -y
  ./risuai.sh install --mode lan -y
  ./risuai.sh install --mode domain --domain chat.example.com --dns-provider manual -y
  ./risuai.sh install --mode domain --domain chat.example.com --dns-provider cloudflare \
    --cloudflare-zone-id 0123456789abcdef0123456789abcdef --cloudflare-token TOKEN -y
  ./risuai.sh install --mode dynv6 --domain chat.dynv6.net --dynv6-token TOKEN -y
  ./risuai.sh install --mode proxy --proxy-type docker --proxy-network proxy -y

Legacy --domain plus --token (or DYNV6_TOKEN) still selects dynv6 mode.
EOF
}

read_env_value_from() {
    read_file=$1
    read_key=$2
    [ -f "$read_file" ] || return 0
    sed -n "s/^${read_key}=//p" "$read_file" | tail -n 1
}

stored_mode() {
    stored=$(read_env_value_from "$env_file" RISUAI_MODE)
    [ -n "$stored" ] || stored=dynv6
    printf '%s' "$stored"
}

compose_with_env() {
    selected_env=$1
    shift
    selected_mode=$(read_env_value_from "$selected_env" RISUAI_MODE)
    [ -n "$selected_mode" ] || selected_mode=dynv6
    selected_dns=$(read_env_value_from "$selected_env" RISUAI_DNS_PROVIDER)
    selected_proxy=$(read_env_value_from "$selected_env" RISUAI_PROXY_TYPE)
    case "$selected_mode:$selected_dns:$selected_proxy" in
        local:*:*|proxy:*:host)
            docker compose --project-directory "$script_dir" --env-file "$selected_env" -f "$compose_base" -f "$compose_local" "$@" ;;
        lan:*:*)
            docker compose --project-directory "$script_dir" --env-file "$selected_env" -f "$compose_base" -f "$compose_lan" "$@" ;;
        domain:cloudflare:*)
            docker compose --project-directory "$script_dir" --env-file "$selected_env" -f "$compose_base" -f "$compose_caddy" -f "$compose_cloudflare" "$@" ;;
        domain:*:*)
            docker compose --project-directory "$script_dir" --env-file "$selected_env" -f "$compose_base" -f "$compose_caddy" "$@" ;;
        dynv6:*:*)
            docker compose --project-directory "$script_dir" --env-file "$selected_env" -f "$compose_base" -f "$compose_caddy" -f "$compose_dynv6" "$@" ;;
        proxy:*:docker)
            docker compose --project-directory "$script_dir" --env-file "$selected_env" -f "$compose_base" -f "$compose_proxy_docker" "$@" ;;
        *) die "Invalid saved deployment mode in $selected_env" ;;
    esac
}

compose() { compose_with_env "$env_file" "$@"; }

require_files() {
    for required_file in "$compose_base" "$compose_local" "$compose_lan" "$compose_caddy" "$compose_dynv6" "$compose_cloudflare" "$compose_proxy_docker"; do
        [ -f "$required_file" ] || die "Missing $required_file"
    done
}

require_docker() {
    command -v docker >/dev/null 2>&1 || die "Docker is not installed. Install Docker Engine with the Compose plugin, then rerun this script."
    docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is not installed"
    docker info >/dev/null 2>&1 || die "Cannot access the Docker daemon. Start Docker or fix its permissions."
}

deployment_url() {
    url_mode=$(stored_mode)
    url_domain=$(read_env_value_from "$env_file" RISUAI_DOMAIN)
    url_proxy=$(read_env_value_from "$env_file" RISUAI_PROXY_TYPE)
    case "$url_mode:$url_proxy" in
        local:*) printf 'http://localhost:6001' ;;
        lan:*)
            server_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
            [ -n "$server_ip" ] || server_ip=SERVER-IP
            printf 'http://%s:6001' "$server_ip" ;;
        domain:*|dynv6:*) printf 'https://%s' "$url_domain" ;;
        proxy:host) printf 'host proxy target: http://127.0.0.1:6001' ;;
        proxy:docker) printf 'Docker proxy target: http://risuai:6001' ;;
    esac
}

show_deployment() {
    current_mode=$(stored_mode)
    printf '\n  Mode:           %s\n  Access/target:  %s\n' "$current_mode" "$(deployment_url)"
    case "$current_mode" in
        local) printf '  Public ports:   none (6001 is bound to localhost)\n' ;;
        lan) printf '  Required port:  TCP 6001 on trusted LANs only (plain HTTP)\n' ;;
        domain|dynv6) printf '  Required ports: public TCP 80/443 and UDP 443; forward TCP 80/443 to this server\n' ;;
        proxy)
            if [ "$(read_env_value_from "$env_file" RISUAI_PROXY_TYPE)" = docker ]; then
                printf '  Proxy network:  %s\n' "$(read_env_value_from "$env_file" RISUAI_PROXY_NETWORK)"
            else printf '  Published port: localhost TCP 6001\n'; fi ;;
    esac
    printf '  RustFS console: http://127.0.0.1:9001\n  Config:         %s\n' "$env_file"
}

if [ "$action" != install ]; then
    require_files
    [ -f "$env_file" ] || die "No installation found. Run ./risuai.sh install first."
    require_docker
    case "$action" in
        start) [ "$#" -eq 0 ] || die "start does not accept arguments"; info "Starting RisuAI"; compose up -d --remove-orphans; compose ps; show_deployment ;;
        stop) [ "$#" -eq 0 ] || die "stop does not accept arguments"; info "Stopping RisuAI without deleting data"; compose stop ;;
        restart) [ "$#" -eq 0 ] || die "restart does not accept arguments"; info "Restarting RisuAI"; compose restart; compose ps; show_deployment ;;
        rebuild) [ "$#" -eq 0 ] || die "rebuild does not accept arguments"; info "Rebuilding the RisuAI application"; compose up -d --build --force-recreate risuai; compose ps; show_deployment ;;
        status) [ "$#" -eq 0 ] || die "status does not accept arguments"; compose ps; show_deployment ;;
        logs) [ "$#" -le 1 ] || die "logs accepts at most one service"; compose logs --tail 200 --follow "$@" ;;
    esac
    exit 0
fi

while [ "$#" -gt 0 ]; do
    case "$1" in
        --mode) [ "$#" -ge 2 ] || die "--mode requires a value"; mode=$2; shift 2 ;;
        --domain) [ "$#" -ge 2 ] || die "--domain requires a value"; domain=$2; shift 2 ;;
        --dns-provider) [ "$#" -ge 2 ] || die "--dns-provider requires a value"; dns_provider=$2; shift 2 ;;
        --cloudflare-zone-id) [ "$#" -ge 2 ] || die "--cloudflare-zone-id requires a value"; cloudflare_zone_id=$2; shift 2 ;;
        --cloudflare-token) [ "$#" -ge 2 ] || die "--cloudflare-token requires a value"; cloudflare_token=$2; shift 2 ;;
        --dynv6-token|--token) [ "$#" -ge 2 ] || die "$1 requires a value"; dynv6_token=$2; shift 2 ;;
        --proxy-type) [ "$#" -ge 2 ] || die "--proxy-type requires a value"; proxy_type=$2; shift 2 ;;
        --proxy-network) [ "$#" -ge 2 ] || die "--proxy-network requires a value"; proxy_network=$2; shift 2 ;;
        --ipv6) enable_ipv6=true; shift ;;
        -y|--yes) assume_yes=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "Unknown option: $1" ;;
    esac
done

require_files
interactive=false
if [ -r /dev/tty ] && [ "$assume_yes" = false ]; then interactive=true; fi

if [ -z "$mode" ] && [ -n "$domain" ] && [ -n "$dynv6_token" ]; then mode=dynv6; fi
if [ -z "$mode" ]; then
    if [ "$interactive" != true ]; then die "Non-interactive installation requires --mode (legacy --domain plus --token also selects dynv6)"; fi
    cat >/dev/tty <<'EOF'

Choose how RisuAI will be reached:
  1) local  - this machine only at http://localhost:6001 (default)
  2) lan    - trusted LAN at http://SERVER-IP:6001 (unencrypted HTTP)
  3) domain - your domain with Caddy HTTPS (manual DNS or Cloudflare DDNS)
  4) dynv6  - a dynv6 hostname with DDNS and Caddy HTTPS
  5) proxy  - an existing reverse proxy on the host or a Docker network
EOF
    printf 'Selection [1]: ' >/dev/tty
    IFS= read -r selection </dev/tty
    case "$selection" in
        ''|1|local) mode=local ;; 2|lan) mode=lan ;; 3|domain) mode=domain ;;
        4|dynv6) mode=dynv6 ;; 5|proxy) mode=proxy ;; *) die "Invalid menu selection: $selection" ;;
    esac
fi
case "$mode" in local|lan|domain|dynv6|proxy) ;; *) die "Invalid --mode: $mode" ;; esac

if [ "$mode" = domain ]; then
    if [ -z "$dns_provider" ] && [ "$interactive" = true ]; then
        printf 'DNS provider, manual or cloudflare [manual]: ' >/dev/tty
        IFS= read -r dns_provider </dev/tty
    fi
    [ -n "$dns_provider" ] || dns_provider=manual
    case "$dns_provider" in manual|cloudflare) ;; *) die "Invalid --dns-provider: $dns_provider" ;; esac
else
    [ -z "$dns_provider" ] || die "--dns-provider is only valid with --mode domain"
    dns_provider=none
fi

if [ "$mode" = proxy ]; then
    if [ -z "$proxy_type" ]; then
        if [ "$interactive" = true ]; then
            printf 'Proxy type, host or docker [host]: ' >/dev/tty
            IFS= read -r proxy_type </dev/tty
            [ -n "$proxy_type" ] || proxy_type=host
        else die "--mode proxy requires --proxy-type host|docker"; fi
    fi
    case "$proxy_type" in host|docker) ;; *) die "Invalid --proxy-type: $proxy_type" ;; esac
    if [ "$proxy_type" = docker ]; then
        [ -n "$proxy_network" ] || die "--proxy-type docker requires --proxy-network"
        [ "${#proxy_network}" -le 255 ] || die "Invalid Docker network name: $proxy_network"
        printf '%s\n' "$proxy_network" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9_.-]*$' || die "Invalid Docker network name: $proxy_network"
    else [ -z "$proxy_network" ] || die "--proxy-network is only valid with --proxy-type docker"; fi
else
    [ -z "$proxy_type" ] || die "--proxy-type is only valid with --mode proxy"
    [ -z "$proxy_network" ] || die "--proxy-network is only valid with --mode proxy"
    proxy_type=none
fi

prompt_value() {
    prompt_text=$1; current_value=$2
    if [ -n "$current_value" ]; then printf '%s' "$current_value"; return; fi
    [ "$interactive" = true ] || die "$prompt_text is required for non-interactive installation"
    printf '%s: ' "$prompt_text" >/dev/tty
    IFS= read -r entered_value </dev/tty
    printf '%s' "$entered_value"
}

prompt_secret() {
    secret_prompt=$1; secret_value=$2
    if [ -n "$secret_value" ]; then printf '%s' "$secret_value"; return; fi
    [ "$interactive" = true ] || die "$secret_prompt is required for non-interactive installation"
    printf '%s (input hidden): ' "$secret_prompt" >/dev/tty
    tty_state=$(stty -g </dev/tty)
    trap 'stty "$tty_state" </dev/tty' 0 1 2 15
    stty -echo </dev/tty
    IFS= read -r secret_value </dev/tty || true
    stty "$tty_state" </dev/tty
    trap - 0 1 2 15
    printf '\n' >/dev/tty
    printf '%s' "$secret_value"
}

case "$mode" in
    domain|dynv6)
        domain=$(prompt_value "A fully qualified hostname" "$domain")
        domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
        if [ "${#domain}" -gt 253 ] || ! printf '%s\n' "$domain" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then die "Invalid fully qualified hostname: $domain"; fi ;;
esac

if [ "$mode" != domain ] && [ "$mode" != dynv6 ] && [ -n "$domain" ]; then
    die "--domain is only valid with domain or dynv6 mode"
fi

if [ "$mode" = dynv6 ]; then
    case "$domain" in *.dynv6.net) ;; *) die "dynv6 mode requires a hostname below dynv6.net" ;; esac
    dynv6_token=$(prompt_secret "A dynv6 HTTP token" "$dynv6_token")
    [ -n "$dynv6_token" ] || die "The dynv6 token cannot be empty"
fi
if [ "$mode:$dns_provider" = domain:cloudflare ]; then
    cloudflare_zone_id=$(prompt_value "Cloudflare Zone ID" "$cloudflare_zone_id")
    printf '%s\n' "$cloudflare_zone_id" | grep -Eq '^[0-9A-Fa-f]{32}$' || die "Invalid Cloudflare Zone ID (expected 32 hexadecimal characters)"
    cloudflare_token=$(prompt_secret "A Zone-scoped Cloudflare DNS Write token" "$cloudflare_token")
    [ -n "$cloudflare_token" ] || die "The Cloudflare token cannot be empty"
fi

if [ "$mode" != dynv6 ] && [ -n "$dynv6_token" ]; then die "A dynv6 token is only valid in dynv6 mode"; fi
if [ "$mode:$dns_provider" != domain:cloudflare ] && { [ -n "$cloudflare_zone_id" ] || [ -n "$cloudflare_token" ]; }; then die "Cloudflare options require --mode domain --dns-provider cloudflare"; fi
if [ "$enable_ipv6" = true ] && [ "$mode" != dynv6 ] && [ "$mode:$dns_provider" != domain:cloudflare ]; then die "--ipv6 is only valid with dynv6 or Cloudflare DDNS"; fi

require_docker
if [ "$mode:$proxy_type" = proxy:docker ] && ! docker network inspect "$proxy_network" >/dev/null 2>&1; then
    die "Docker network '$proxy_network' does not exist. Create it first with: docker network create $proxy_network"
fi

current_project_owns_port() {
    check_protocol=$1; check_port_number=$2
    docker ps --filter 'label=com.docker.compose.project=risuai-rustfs' --filter "publish=$check_port_number/$check_protocol" --format '{{.ID}}' 2>/dev/null | grep -q .
}
kernel_socket_details() {
    socket_protocol=$1; socket_port=$2; hex_port=$(printf '%04X' "$socket_port")
    for socket_table in /proc/net/"$socket_protocol" /proc/net/"${socket_protocol}6"; do
        [ -r "$socket_table" ] || continue
        awk -v suffix=":$hex_port" -v table="$socket_table" 'NR > 1 && toupper($2) ~ (suffix "$") { print "Kernel socket in " table ": " $2 }' "$socket_table"
    done
}
port_details() {
    detail_protocol=$1; detail_port=$2
    docker ps --filter "publish=$detail_port/$detail_protocol" --format 'Docker container {{.Names}}: {{.Ports}}' 2>/dev/null | grep -v '^Docker container risuai\(-caddy\|-rustfs\)\{0,1\}:' || true
    if command -v ss >/dev/null 2>&1; then
        if [ "$detail_protocol" = tcp ]; then ss -H -ltnp "sport = :$detail_port" 2>/dev/null || true; else ss -H -lunp "sport = :$detail_port" 2>/dev/null || true; fi
    else kernel_socket_details "$detail_protocol" "$detail_port"; fi
}
check_port() {
    port_protocol=$1; port_number=$2
    if current_project_owns_port "$port_protocol" "$port_number"; then return; fi
    conflicts=$(port_details "$port_protocol" "$port_number")
    if [ -n "$conflicts" ]; then printf '%s\n' "$conflicts" >&2; die "Port $port_number/$port_protocol is already in use (current RisuAI project containers are ignored)"; fi
}

info "Checking required host ports"
check_port tcp 9000; check_port tcp 9001
case "$mode:$proxy_type" in
    local:*|lan:*|proxy:host) check_port tcp 6001 ;;
    domain:*|dynv6:*) check_port tcp 80; check_port tcp 443; check_port udp 443 ;;
esac

if [ "$assume_yes" != true ]; then
    printf '\nMode: %s\n' "$mode"
    case "$mode" in
        local) printf 'RisuAI will only be reachable at http://localhost:6001.\n' ;;
        lan) warn "LAN mode publishes unencrypted HTTP on every interface. Use it only on a trusted network." ;;
        domain|dynv6) printf 'RisuAI will use Caddy automatic HTTPS at https://%s.\nDNS must resolve to this server, and public TCP 80/443 must reach it for certificate issuance.\n' "$domain" ;;
        proxy) printf 'Reverse proxy type: %s\n' "$proxy_type" ;;
    esac
    printf 'PostgreSQL stays internal; RustFS remains bound to localhost. Continue? [Y/n] ' >/dev/tty
    IFS= read -r answer </dev/tty
    case "$answer" in n|N|no|NO) exit 0 ;; esac
fi

random_secret() {
    if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32; else od -An -N32 -tx1 /dev/urandom | tr -d ' \n'; fi
}
postgres_password=$(read_env_value_from "$env_file" POSTGRES_PASSWORD)
rustfs_access_key=$(read_env_value_from "$env_file" RUSTFS_ACCESS_KEY)
rustfs_secret_key=$(read_env_value_from "$env_file" RUSTFS_SECRET_KEY)
[ -n "$postgres_password" ] || postgres_password=$(random_secret)
[ -n "$rustfs_access_key" ] || rustfs_access_key="risuai-$(random_secret | cut -c1-24)"
[ -n "$rustfs_secret_key" ] || rustfs_secret_key=$(random_secret)

umask 077
mkdir -p "$state_dir"
tmp_env=$(mktemp "$state_dir/rustfs.env.new.XXXXXX")
tmp_dynv6=$(mktemp "$state_dir/dynv6-token.new.XXXXXX")
tmp_cloudflare=$(mktemp "$state_dir/cloudflare-token.new.XXXXXX")
cleanup_staging() { rm -f "$tmp_env" "$tmp_dynv6" "$tmp_cloudflare"; }
trap cleanup_staging 0 1 2 15
printf '%s' "$dynv6_token" >"$tmp_dynv6"
printf '%s' "$cloudflare_token" >"$tmp_cloudflare"

write_env() {
    destination=$1; dynv6_path=$2; cloudflare_path=$3
    cat >"$destination" <<EOF
COMPOSE_PROJECT_NAME=risuai-rustfs
RISUAI_MODE=$mode
RISUAI_DNS_PROVIDER=$dns_provider
RISUAI_PROXY_TYPE=$proxy_type
RISUAI_PROXY_NETWORK=$proxy_network
POSTGRES_PASSWORD=$postgres_password
RUSTFS_ACCESS_KEY=$rustfs_access_key
RUSTFS_SECRET_KEY=$rustfs_secret_key
RUSTFS_BIND_ADDRESS=127.0.0.1
RISUAI_DOMAIN=$domain
DYNV6_ZONE=$domain
DYNV6_IPV6=$enable_ipv6
DYNV6_TOKEN_FILE=$dynv6_path
DYNV6_UPDATE_INTERVAL=300
CLOUDFLARE_ZONE_ID=$cloudflare_zone_id
CLOUDFLARE_IPV6=$enable_ipv6
CLOUDFLARE_TOKEN_FILE=$cloudflare_path
CLOUDFLARE_UPDATE_INTERVAL=300
EOF
}

write_env "$tmp_env" "$tmp_dynv6" "$tmp_cloudflare"
chmod 600 "$tmp_env" "$tmp_dynv6" "$tmp_cloudflare"
info "Validating the prospective Compose configuration"
compose_with_env "$tmp_env" config --quiet

case "$mode:$dns_provider" in
    dynv6:*)
        info "Validating the dynv6 hostname and token"
        compose_with_env "$tmp_env" run --rm -e DYNV6_ONCE=true dynv6 || die "dynv6 rejected the update. Check the hostname, token, and internet connection." ;;
    domain:cloudflare)
        info "Validating and updating Cloudflare DNS"
        compose_with_env "$tmp_env" run --rm -e CLOUDFLARE_ONCE=true cloudflare-ddns || die "Cloudflare DDNS failed. Check the Zone ID, token, hostname, and internet connection." ;;
esac

info "Atomically installing the protected deployment configuration"
if [ "$mode" = dynv6 ]; then mv -f "$tmp_dynv6" "$dynv6_token_file"; else rm -f "$tmp_dynv6"; fi
if [ "$mode:$dns_provider" = domain:cloudflare ]; then mv -f "$tmp_cloudflare" "$cloudflare_token_file"; else rm -f "$tmp_cloudflare"; fi
write_env "$tmp_env" "$dynv6_token_file" "$cloudflare_token_file"
chmod 600 "$tmp_env"
mv -f "$tmp_env" "$env_file"
chmod 600 "$env_file"

if command -v ufw >/dev/null 2>&1 && { [ "$mode" = domain ] || [ "$mode" = dynv6 ]; } && ufw status 2>/dev/null | grep -q '^Status: active'; then
    info "Allowing HTTP and HTTPS through UFW"
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
fi

info "Building and starting RisuAI (the first build can take several minutes)"
compose up -d --build --remove-orphans
if [ "$mode" != dynv6 ]; then rm -f "$dynv6_token_file"; fi
if [ "$mode:$dns_provider" != domain:cloudflare ]; then rm -f "$cloudflare_token_file"; fi
trap - 0 1 2 15

info "Waiting for RisuAI"
attempt=0
until docker exec risuai node -e "fetch('http://127.0.0.1:6001').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 60 ]; then compose logs --no-color --tail 80 risuai >&2 || true; die "RisuAI did not become ready within 5 minutes"; fi
    sleep 5
done

printf '\nRisuAI is running.\n'
show_deployment
case "$mode" in
    lan) warn "Traffic on port 6001 is not encrypted. Do not expose LAN mode to the internet." ;;
    domain|dynv6) printf '\nDNS propagation and the first TLS certificate can take a few minutes.\n' ;;
esac
printf '\nManage it with ./risuai.sh start|stop|restart|rebuild|status|logs.\n'
