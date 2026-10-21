#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
umask 077

REPO="nevaeh5379/HaejeokRisuAI"
APP_ROOT="${HAEJEOK_TERMUX_HOME:-$HOME/.local/share/haejeok-risuai}"
APP_DIR="$APP_ROOT/app"
SAVE_DIR="$APP_ROOT/save"
PGDATA="$APP_ROOT/postgres"
CONFIG="$APP_ROOT/config.env"
TMP_DIR=""
PG_INIT_DIR=""
POSTGRES_STARTED_BY_INSTALLER=0

info() { printf '\n==> %s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }

cleanup() {
  if [ "$POSTGRES_STARTED_BY_INSTALLER" = 1 ] && [ -n "${HAEJEOK_DB_PORT:-}" ]; then
    pg_ctl -D "$HAEJEOK_PGDATA" -m fast -w stop >/dev/null 2>&1 || true
  fi
  [ -z "$PG_INIT_DIR" ] || rm -rf "$PG_INIT_DIR"
  [ -z "$TMP_DIR" ] || rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[ -n "${PREFIX:-}" ] || fail "This installer must run inside Termux."
command -v pkg >/dev/null 2>&1 || fail "The Termux pkg command is unavailable."

# Stop our services with the old binaries before upgrading shared libraries or PostgreSQL.
export SVDIR="$PREFIX/var/service"
export LOGDIR="$PREFIX/var/log"
for service in haejeok-risuai haejeok-postgres; do
  if [ -d "$SVDIR/$service" ] && sv status "$service" >/dev/null 2>&1; then
    sv -w 30 down "$service" || fail "Could not stop $service before the Termux package upgrade."
  elif [ -d "$SVDIR/$service" ]; then
    touch "$SVDIR/$service/down"
  fi
done

# Keep existing config files without prompting, including when stdin is a pipe.
export DEBIAN_FRONTEND=noninteractive
APT_OPTIONS=(-y -o Dpkg::Options::=--force-confold)
info "Finishing interrupted Termux package configuration"
dpkg --force-confold --configure -a </dev/null || \
  fail "Could not finish interrupted package configuration. Resolve the package errors above and rerun this installer."

# Termux does not support partial upgrades: a new node with an old libc++ can fail to link.
info "Updating Termux package lists and upgrading all installed packages"
pkg update -y </dev/null || fail "Could not update Termux packages. Check your connection or run termux-change-repo, then rerun this installer."
pkg upgrade "${APT_OPTIONS[@]}" </dev/null || fail "Termux package upgrade failed. Run dpkg --force-confold --configure -a and apt --fix-broken install, then pkg upgrade before retrying."

info "Installing Termux runtime prerequisites"
pkg install "${APT_OPTIONS[@]}" postgresql termux-services curl tar openssl-tool coreutils gawk </dev/null || \
  fail "Termux prerequisite installation failed. Resolve the package errors above and rerun this installer."
if ! command -v node >/dev/null 2>&1; then
  pkg install "${APT_OPTIONS[@]}" nodejs-lts </dev/null || fail "Could not install the Termux Node.js LTS package."
fi

node --version || fail "Node.js cannot run after pkg upgrade. Reinstall your Node package (nodejs or nodejs-lts) and libc++ with pkg reinstall, then retry."
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  process.exit((major === 24 && minor >= 12) || major > 24 ? 0 : 1);
' || fail "Node.js 24.12+ is required. Upgrade the Termux Node package first."
npm --version || fail "npm cannot run. Reinstall your Termux Node package and retry."

check_postgres_commands() {
  local cmd
  for cmd in postgres initdb pg_ctl psql createdb pg_isready; do
    command -v "$cmd" >/dev/null 2>&1 && "$cmd" --version >/dev/null || return 1
  done
}
if ! check_postgres_commands; then
  info "Repairing the incomplete PostgreSQL package installation"
  pkg reinstall "${APT_OPTIONS[@]}" postgresql </dev/null || fail "Could not reinstall PostgreSQL. Resolve the package errors above and retry."
  check_postgres_commands || fail "PostgreSQL commands still cannot run. Run pkg upgrade and pkg reinstall postgresql, then retry."
fi

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
[ -f "$STAGED_APP/server/node/server.ts" ] || fail "Runtime bundle is missing the TypeScript Node server."
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
  local installed_major cluster_major
  installed_major=$(postgres --version)
  installed_major=${installed_major##* }
  installed_major=${installed_major%%.*}
  if [ -f "$HAEJEOK_PGDATA/PG_VERSION" ]; then
    cluster_major=$(cat "$HAEJEOK_PGDATA/PG_VERSION")
    [ "$cluster_major" = "$installed_major" ] || \
      fail "Existing PostgreSQL data uses version $cluster_major, but the installed server is $installed_major. Migrate with pg_upgrade or dump/restore before retrying. Data was preserved at $HAEJEOK_PGDATA."
    return 0
  fi

  # Never mistake a partial initdb for a usable cluster, or delete unknown existing data.
  if [ -e "$HAEJEOK_PGDATA" ]; then
    rmdir "$HAEJEOK_PGDATA" 2>/dev/null || \
      fail "PostgreSQL directory has data but no PG_VERSION: $HAEJEOK_PGDATA. Inspect and move it aside before retrying; it was not deleted."
  fi
  info "Initializing private PostgreSQL cluster"
  mkdir -p "$(dirname "$HAEJEOK_PGDATA")"
  PG_INIT_DIR=$(mktemp -d "${HAEJEOK_PGDATA}.init.XXXXXX")

  local pwfile="$TMP_DIR/postgres-admin-password"
  printf '%s\n' "$HAEJEOK_PG_ADMIN_PASSWORD" > "$pwfile"
  chmod 600 "$pwfile"
  if ! initdb -D "$PG_INIT_DIR" --username=postgres --pwfile="$pwfile" \
    --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 --no-locale \
    > "$APP_ROOT/logs/postgres-initdb.log" 2>&1; then
    tail -n 40 "$APP_ROOT/logs/postgres-initdb.log" >&2
    fail "PostgreSQL initialization failed. See $APP_ROOT/logs/postgres-initdb.log, resolve the error, and rerun this installer."
  fi
  mv "$PG_INIT_DIR" "$HAEJEOK_PGDATA"
  PG_INIT_DIR=""
}
initialize_postgres

# Check the actual role/database on every run, including retries after interrupted setup.
if ! pg_ctl -D "$HAEJEOK_PGDATA" status >/dev/null 2>&1; then
  POSTGRES_STARTED_BY_INSTALLER=1
  if ! pg_ctl -D "$HAEJEOK_PGDATA" -l "$APP_ROOT/logs/postgres-bootstrap.log" \
    -o "-h 127.0.0.1 -p $HAEJEOK_DB_PORT" -t 60 -w start; then
    tail -n 40 "$APP_ROOT/logs/postgres-bootstrap.log" >&2 || true
    fail "PostgreSQL could not start. See $APP_ROOT/logs/postgres-bootstrap.log."
  fi
fi

info "Ensuring the Haejeok RisuAI database and login are ready"
if ! PGPASSWORD="$HAEJEOK_PG_ADMIN_PASSWORD" PGCONNECT_TIMEOUT=10 psql -X --no-password \
  -h 127.0.0.1 -p "$HAEJEOK_DB_PORT" -U postgres -d postgres \
  -v ON_ERROR_STOP=1 -v db_user="$HAEJEOK_DB_USER" -v db_password="$HAEJEOK_DB_PASSWORD" \
  -v db_name="$HAEJEOK_DB_NAME" > "$APP_ROOT/logs/postgres-setup.log" 2>&1 <<'SQL'
SELECT format('CREATE ROLE %I WITH LOGIN PASSWORD %L', :'db_user', :'db_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'db_user')
\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = :'db_name')
\gexec
SQL
then
  fail "PostgreSQL database setup failed. See $APP_ROOT/logs/postgres-setup.log, resolve the error, and rerun this installer."
fi
PGPASSWORD="$HAEJEOK_DB_PASSWORD" PGCONNECT_TIMEOUT=10 psql -X --no-password \
  -h 127.0.0.1 -p "$HAEJEOK_DB_PORT" -U "$HAEJEOK_DB_USER" -d "$HAEJEOK_DB_NAME" \
  -v ON_ERROR_STOP=1 -c 'SELECT 1' >/dev/null || \
  fail "Cannot connect to the app database with the saved credentials. Check $CONFIG and rerun this installer."
if [ "$POSTGRES_STARTED_BY_INSTALLER" = 1 ]; then
  pg_ctl -D "$HAEJEOK_PGDATA" -m fast -w stop >/dev/null
  POSTGRES_STARTED_BY_INSTALLER=0
fi

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
touch "$POSTGRES_SERVICE/down" "$RISUAI_SERVICE/down"

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
NODE_ENV=production exec node server/node/server.ts 2>&1
EOF
chmod 755 "$RISUAI_SERVICE/run"
install_service_logger "$RISUAI_SERVICE"
rm -f "$POSTGRES_SERVICE/down" "$RISUAI_SERVICE/down"
export SVDIR="$PREFIX/var/service"
export LOGDIR="$PREFIX/var/log"

SERVICE_PIDFILE="$PREFIX/var/run/service-daemon.pid"
if [ ! -r "$SERVICE_PIDFILE" ] || ! kill -0 "$(cat "$SERVICE_PIDFILE" 2>/dev/null)" 2>/dev/null; then
  service-daemon start || fail "Could not start the Termux service daemon."
fi

# runsvdir can take several seconds to discover newly installed services.
# Wait here too, since the release bundle may contain an older haejeok CLI.
for service in haejeok-postgres haejeok-risuai; do
  for ((attempt = 0; attempt < 60; attempt++)); do
    if sv status "$service" >/dev/null 2>&1; then
      break
    fi
    sleep 0.25
  done
  if ! sv status "$service"; then
    fail "Termux service supervision is not ready for $service after 15 seconds. Check service-daemon and $SVDIR/$service."
  fi
done

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
