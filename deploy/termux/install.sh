#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

REPO="nevaeh5379/HaejeokRisuAI"
APP_ROOT="${HAEJEOK_TERMUX_HOME:-$HOME/.local/share/haejeok-risuai}"
APP_DIR="$APP_ROOT/app"
SAVE_DIR="$APP_ROOT/save"
PGDATA="$APP_ROOT/postgres"
CONFIG="$APP_ROOT/config.env"
TMP_DIR=""
POSTGRES_STARTED_BY_INSTALLER=0

info() { printf '\n==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ "$POSTGRES_STARTED_BY_INSTALLER" = 1 ] && [ -n "${HAEJEOK_DB_PORT:-}" ]; then
    pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
}
trap cleanup EXIT INT TERM

[ -n "${PREFIX:-}" ] || fail "This installer must run inside Termux."
command -v pkg >/dev/null 2>&1 || fail "The Termux pkg command is unavailable."
info "Installing Termux runtime prerequisites"
pkg install -y postgresql termux-services curl tar openssl-tool coreutils gawk >/dev/null
if ! command -v node >/dev/null 2>&1; then
  pkg install -y nodejs-lts >/dev/null
fi

node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit((major === 20 && minor >= 19) || (major === 22 && minor >= 12) || major > 22 ? 0 : 1);
' || fail "Node.js 20.19+ or 22+ is required. Upgrade the Termux Node package first."

for cmd in node npm postgres initdb pg_ctl psql createdb pg_isready curl tar sha256sum sv service-daemon awk; do
  command -v "$cmd" >/dev/null 2>&1 || fail "Required command is missing after package install: $cmd"
done

mkdir -p "$APP_ROOT" "$SAVE_DIR" "$APP_ROOT/logs"
chmod 700 "$APP_ROOT" "$SAVE_DIR" "$APP_ROOT/logs"

latest_tag() {
  local resolved
  resolved=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/${REPO}/releases/latest") || return 1
  resolved=${resolved%/}
  printf '%s' "${resolved##*/}"
}

TAG="${HAEJEOK_TERMUX_TAG:-}"
if [ -z "$TAG" ]; then
  info "Resolving the latest Haejeok RisuAI release"
  TAG=$(latest_tag) || fail "Could not resolve the latest GitHub release."
fi
[ -n "$TAG" ] || fail "The release tag is empty."

ARCHIVE_NAME="RisuAI-Termux-${TAG}.tar.gz"
ARCHIVE_URL="https://github.com/${REPO}/releases/download/${TAG}/${ARCHIVE_NAME}"
TMP_DIR=$(mktemp -d)
ARCHIVE="$TMP_DIR/$ARCHIVE_NAME"
CHECKSUM="$ARCHIVE.sha256"
STAGED_APP="$TMP_DIR/app"

info "Downloading $ARCHIVE_NAME"
curl -fL "$ARCHIVE_URL" -o "$ARCHIVE" || \
  fail "This release does not contain the Termux runtime bundle: $TAG"
curl -fL "${ARCHIVE_URL}.sha256" -o "$CHECKSUM" || \
  fail "Could not download the Termux runtime checksum."

(
  cd "$TMP_DIR"
  sha256sum -c "${ARCHIVE_NAME}.sha256"
) || fail "Termux runtime checksum verification failed."

mkdir -p "$STAGED_APP"
tar -xzf "$ARCHIVE" -C "$STAGED_APP"
[ -f "$STAGED_APP/dist/index.html" ] || fail "Runtime bundle is missing dist/index.html."
[ -f "$STAGED_APP/server/node/server.cjs" ] || fail "Runtime bundle is missing the Node server."
[ -f "$STAGED_APP/package.json" ] || fail "Runtime bundle is missing package.json."
[ -f "$STAGED_APP/package-lock.json" ] || fail "Runtime bundle is missing package-lock.json."

info "Installing minimal Node runtime dependencies"
(
  cd "$STAGED_APP"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
)
write_config_value() {
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

valid_port() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] 2>/dev/null && [ "$1" -le 65535 ] 2>/dev/null
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi
  [ -r /dev/urandom ] || fail "Neither openssl nor /dev/urandom is available for credential generation."
  od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n'
}

create_initial_config() {
  local app_port="${HAEJEOK_PORT:-6001}"
  local db_port="${HAEJEOK_DB_PORT:-54329}"
  valid_port "$app_port" || fail "Invalid HAEJEOK_PORT: $app_port"
  valid_port "$db_port" || fail "Invalid HAEJEOK_DB_PORT: $db_port"
  local db_password admin_password
  db_password=$(random_hex 32)
  admin_password=$(random_hex 32)

  cat > "$CONFIG" <<EOF
HAEJEOK_RELEASE=$TAG
HAEJEOK_APP_DIR=$APP_DIR
HAEJEOK_SAVE_DIR=$SAVE_DIR
HAEJEOK_PGDATA=$PGDATA
HAEJEOK_DB_PORT=$db_port
HAEJEOK_DB_NAME=haejeok
HAEJEOK_DB_USER=haejeok
HAEJEOK_DB_PASSWORD=$db_password
HAEJEOK_PG_ADMIN_PASSWORD=$admin_password
DATABASE_URL=postgresql://haejeok:${db_password}@127.0.0.1:${db_port}/haejeok
PORT=$app_port
RISU_HOST=127.0.0.1
RISU_SAVE_PATH=$SAVE_DIR
DB_VENDOR=postgres
RISU_STORAGE_TYPE=fs
RISU_POSTGRES_ENABLED=true
RISU_POSTGRES_POOL_MAX=4
RISUAI_MIGRATE_CONCURRENCY=2
NODE_ENV=production
EOF
  chmod 600 "$CONFIG"
}

if [ ! -f "$CONFIG" ]; then
  create_initial_config
else
  chmod 600 "$CONFIG"
fi
set -a
# shellcheck disable=SC1090
. "$CONFIG"
set +a

for required in HAEJEOK_APP_DIR HAEJEOK_SAVE_DIR HAEJEOK_PGDATA HAEJEOK_DB_PORT \
  HAEJEOK_DB_NAME HAEJEOK_DB_USER HAEJEOK_DB_PASSWORD HAEJEOK_PG_ADMIN_PASSWORD \
  DATABASE_URL PORT RISU_HOST; do
  [ -n "${!required:-}" ] || fail "Existing config is missing $required."
done
valid_port "$PORT" || fail "Invalid saved PORT: $PORT"
valid_port "$HAEJEOK_DB_PORT" || fail "Invalid saved HAEJEOK_DB_PORT: $HAEJEOK_DB_PORT"

initialize_postgres() {
  [ ! -f "$HAEJEOK_PGDATA/PG_VERSION" ] || return
  info "Initializing private PostgreSQL cluster"
  mkdir -p "$HAEJEOK_PGDATA"
  chmod 700 "$HAEJEOK_PGDATA"

  local pwfile="$TMP_DIR/postgres-admin-password"
  printf '%s\n' "$HAEJEOK_PG_ADMIN_PASSWORD" > "$pwfile"
  chmod 600 "$pwfile"
  initdb -D "$HAEJEOK_PGDATA" --username=postgres --pwfile="$pwfile" \
    --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --no-locale >/dev/null

  pg_ctl -D "$HAEJEOK_PGDATA" -l "$APP_ROOT/logs/postgres-bootstrap.log" \
    -o "-h 127.0.0.1 -p $HAEJEOK_DB_PORT" -w start >/dev/null
  POSTGRES_STARTED_BY_INSTALLER=1
}
NEEDS_POSTGRES_INIT=0
[ -f "$HAEJEOK_PGDATA/PG_VERSION" ] || NEEDS_POSTGRES_INIT=1
initialize_postgres

if [ "$NEEDS_POSTGRES_INIT" = 1 ]; then
  info "Creating the Haejeok RisuAI database"
  PGPASSWORD="$HAEJEOK_PG_ADMIN_PASSWORD" psql \
    -h 127.0.0.1 -p "$HAEJEOK_DB_PORT" -U postgres -d postgres \
    -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE haejeok WITH LOGIN PASSWORD '$HAEJEOK_DB_PASSWORD';" >/dev/null
  PGPASSWORD="$HAEJEOK_PG_ADMIN_PASSWORD" createdb \
    -h 127.0.0.1 -p "$HAEJEOK_DB_PORT" -U postgres \
    -O "$HAEJEOK_DB_USER" "$HAEJEOK_DB_NAME"
  pg_ctl -D "$HAEJEOK_PGDATA" -m fast -w stop >/dev/null
  POSTGRES_STARTED_BY_INSTALLER=0
fi

stop_existing_app() {
  export SVDIR="$PREFIX/var/service"
  export LOGDIR="$PREFIX/var/log"
  if [ -d "$SVDIR/haejeok-risuai" ]; then
    sv down haejeok-risuai >/dev/null 2>&1 || true
  fi
}

stop_existing_app
PREVIOUS_APP="$APP_ROOT/app.previous"
rm -rf "$PREVIOUS_APP"
if [ -d "$HAEJEOK_APP_DIR" ]; then
  mv "$HAEJEOK_APP_DIR" "$PREVIOUS_APP"
fi
mv "$STAGED_APP" "$HAEJEOK_APP_DIR"
chmod -R u+rwX,go-rwx "$HAEJEOK_APP_DIR"
write_config_value HAEJEOK_RELEASE "$TAG"

install_cli() {
  local source="$HAEJEOK_APP_DIR/deploy/termux/haejeok.sh"
  [ -f "$source" ] || fail "Runtime bundle is missing deploy/termux/haejeok.sh."
  cp "$source" "$PREFIX/bin/haejeok"
  chmod 755 "$PREFIX/bin/haejeok"
}

install_service_logger() {
  local service_dir="$1"
  mkdir -p "$service_dir/log"
  if [ -x "$PREFIX/share/termux-services/svlogger" ]; then
    ln -sfn "$PREFIX/share/termux-services/svlogger" "$service_dir/log/run"
  fi
}

install_cli
POSTGRES_SERVICE="$PREFIX/var/service/haejeok-postgres"
RISUAI_SERVICE="$PREFIX/var/service/haejeok-risuai"
mkdir -p "$POSTGRES_SERVICE" "$RISUAI_SERVICE"

cat > "$POSTGRES_SERVICE/run" <<EOF
#!$PREFIX/bin/sh
set -eu
set -a
. "$CONFIG"
set +a
exec postgres -D "\$HAEJEOK_PGDATA" -h 127.0.0.1 -p "\$HAEJEOK_DB_PORT" 2>&1
EOF
chmod 755 "$POSTGRES_SERVICE/run"
install_service_logger "$POSTGRES_SERVICE"

cat > "$RISUAI_SERVICE/run" <<EOF
#!$PREFIX/bin/sh
set -eu
set -a
. "$CONFIG"
set +a
while ! pg_isready -h 127.0.0.1 -p "\$HAEJEOK_DB_PORT" -U "\$HAEJEOK_DB_USER" -d "\$HAEJEOK_DB_NAME" >/dev/null 2>&1; do
  sleep 1
done
cd "\$HAEJEOK_APP_DIR"
exec node server/node/server.cjs 2>&1
EOF
chmod 755 "$RISUAI_SERVICE/run"
install_service_logger "$RISUAI_SERVICE"
rm -f "$POSTGRES_SERVICE/down" "$RISUAI_SERVICE/down"
export SVDIR="$PREFIX/var/service"
export LOGDIR="$PREFIX/var/log"

SERVICE_PIDFILE="$PREFIX/var/run/service-daemon.pid"
if [ ! -r "$SERVICE_PIDFILE" ] || ! kill -0 "$(cat "$SERVICE_PIDFILE" 2>/dev/null)" 2>/dev/null; then
  service-daemon start >/dev/null 2>&1 || true
  sleep 0.5
fi

info "Starting PostgreSQL and Haejeok RisuAI"
if ! "$PREFIX/bin/haejeok" start; then
  printf '\nRecent Node log:\n' >&2
  tail -n 80 "$PREFIX/var/log/sv/haejeok-risuai/current" 2>/dev/null >&2 || true
  fail "Haejeok RisuAI did not become healthy. The previous runtime was kept at $PREVIOUS_APP if this was an update."
fi
mkdir -p "$HOME/.shortcuts"
cat > "$HOME/.shortcuts/Haejeok-RisuAI" <<EOF
#!$PREFIX/bin/sh
exec "$PREFIX/bin/haejeok" open
EOF
chmod 700 "$HOME/.shortcuts/Haejeok-RisuAI"

rm -rf "$PREVIOUS_APP"

printf '\nHaejeok RisuAI %s is ready.\n' "$TAG"
printf 'Local URL: http://127.0.0.1:%s\n' "$PORT"
printf 'Data directory: %s\n' "$APP_ROOT"
printf '\nUseful commands:\n'
printf '  haejeok open\n'
printf '  haejeok status\n'
printf '  haejeok logs\n'
printf '  haejeok lan on\n'
printf '  haejeok update\n'
printf '  haejeok stop\n'
printf '\nTermux:Widget users can add the Haejeok-RisuAI shortcut to the home screen.\n'

if command -v termux-open-url >/dev/null 2>&1; then
  termux-open-url "http://127.0.0.1:${PORT}" >/dev/null 2>&1 || true
fi
