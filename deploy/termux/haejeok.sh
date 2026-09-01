#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
APP_ROOT="${HAEJEOK_TERMUX_HOME:-$HOME/.local/share/haejeok-risuai}"
CONFIG="$APP_ROOT/config.env"
SVDIR="$PREFIX/var/service"
LOGDIR="$PREFIX/var/log"
export SVDIR LOGDIR

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

load_config() {
  [ -f "$CONFIG" ] || fail "Haejeok RisuAI is not installed."
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG"
  set +a
}

service_daemon_running() {
  local pidfile="${PREFIX}/var/run/service-daemon.pid"
  [ -r "$pidfile" ] || return 1
  kill -0 "$(cat "$pidfile")" 2>/dev/null
}
ensure_service_daemon() {
  if service_daemon_running; then
    return
  fi
  command -v service-daemon >/dev/null 2>&1 || fail "termux-services is not installed."
  service-daemon start >/dev/null 2>&1 || true
  sleep 0.2
  service_daemon_running || fail "Could not start the Termux service daemon."
}

wait_postgres() {
  local attempt
  for attempt in $(seq 1 40); do
    if pg_isready -h 127.0.0.1 -p "$HAEJEOK_DB_PORT" -U "$HAEJEOK_DB_USER" -d "$HAEJEOK_DB_NAME" >/dev/null 2>&1; then
      return
    fi
    sleep 0.5
  done
  fail "PostgreSQL did not become ready. Run: haejeok logs postgres"
}

wait_app() {
  local attempt
  for attempt in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  fail "Haejeok RisuAI did not become healthy. Run: haejeok logs"
}

start_services() {
  load_config
  ensure_service_daemon
  sv up haejeok-postgres
  wait_postgres
  sv up haejeok-risuai
  wait_app
}
stop_services() {
  load_config
  ensure_service_daemon
  sv down haejeok-risuai || true
  sv down haejeok-postgres || true
}

update_config_value() {
  local key="$1"
  local value="$2"
  local tmp="${CONFIG}.tmp.$$"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$CONFIG" > "$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$CONFIG"
}

show_status() {
  load_config
  ensure_service_daemon
  sv status haejeok-postgres || true
  sv status haejeok-risuai || true
}
show_logs() {
  load_config
  local service="${1:-app}"
  local path
  case "$service" in
    app|node|risuai) path="$LOGDIR/sv/haejeok-risuai/current" ;;
    postgres|pg) path="$LOGDIR/sv/haejeok-postgres/current" ;;
    *) fail "Unknown log target: $service" ;;
  esac
  [ -e "$path" ] || fail "Log file does not exist yet: $path"
  tail -n 100 -F "$path"
}

set_lan_mode() {
  load_config
  case "${1:-}" in
    on)
      update_config_value RISU_HOST 0.0.0.0
      printf 'LAN access enabled on port %s.\n' "$PORT"
      ;;
    off)
      update_config_value RISU_HOST 127.0.0.1
      printf 'LAN access disabled; listening on localhost only.\n'
      ;;
    *) fail "Usage: haejeok lan on|off" ;;
  esac
  ensure_service_daemon
  sv restart haejeok-risuai >/dev/null || true
}
open_browser() {
  start_services
  load_config
  local url="http://127.0.0.1:${PORT}"
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "$url"
  else
    printf 'Open %s in your browser.\n' "$url"
  fi
}

run_doctor() {
  load_config
  local failed=0
  for cmd in node postgres pg_isready sv curl; do
    if command -v "$cmd" >/dev/null 2>&1; then
      printf 'OK   %s\n' "$cmd"
    else
      printf 'MISS %s\n' "$cmd"
      failed=1
    fi
  done
  printf 'App: %s\n' "$HAEJEOK_APP_DIR"
  printf 'Data: %s\n' "$HAEJEOK_SAVE_DIR"
  printf 'Listen: %s:%s\n' "$RISU_HOST" "$PORT"
  [ -d "$HAEJEOK_APP_DIR" ] || failed=1
  [ -d "$HAEJEOK_PGDATA" ] || failed=1
  return "$failed"
}
usage() {
  cat <<'EOF'
Haejeok RisuAI Termux manager

Usage:
  haejeok open
  haejeok start|stop|restart|status
  haejeok logs [app|postgres]
  haejeok lan on|off
  haejeok update
  haejeok doctor
  haejeok version
EOF
}

command_name="${1:-open}"
shift || true

case "$command_name" in
  open) open_browser ;;
  start) start_services ;;
  stop) stop_services ;;
  restart) stop_services; start_services ;;
  status) show_status ;;
  logs) show_logs "${1:-app}" ;;
  lan) set_lan_mode "${1:-}" ;;
  update)
    curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/deploy/termux/install.sh | bash
    ;;
  doctor) run_doctor ;;
  version)
    load_config
    printf '%s\n' "${HAEJEOK_RELEASE:-unknown}"
    ;;
  help|-h|--help) usage ;;
  *) usage; fail "Unknown command: $command_name" ;;
esac
