#!/bin/sh
set -eu
umask 077

repo="nevaeh5379/HaejeokRisuAI"
ref=${HAEJEOK_INSTALL_REF:-main}
raw_base=${HAEJEOK_RAW_BASE:-"https://raw.githubusercontent.com/${repo}/${ref}"}
install_dir=${HAEJEOK_INSTALL_DIR:-"${HOME:-$PWD}/haejeok-risuai"}
dry_run=${HAEJEOK_INSTALL_DRY_RUN:-0}

info() { printf '\n==> %s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v docker >/dev/null 2>&1 || die "Docker is not installed."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."

case "$install_dir" in
  /) die "Refusing to use / as the installation directory." ;;
esac
if [ -L "$install_dir" ]; then
  die "Installation directory must not be a symbolic link: $install_dir"
fi

mkdir -p "$install_dir" "$install_dir/save" "$install_dir/backup/staging" "$install_dir/backup/restic"
chmod 700 "$install_dir" "$install_dir/backup" "$install_dir/backup/staging" "$install_dir/backup/restic" 2>/dev/null || true

random_hex() {
  bytes=$1
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi
  [ -r /dev/urandom ] || die "openssl or /dev/urandom is required to generate credentials."
  od -An -N"$bytes" -tx1 /dev/urandom | tr -d ' \n'
}
download() {
  source_url=$1
  destination=$2
  tmp_file="${destination}.tmp.$$"
  curl -fsSL "$source_url" -o "$tmp_file" || {
    rm -f "$tmp_file"
    die "Failed to download $source_url"
  }
  mv -f "$tmp_file" "$destination"
}

info "Installing Haejeok RisuAI into $install_dir"
download "$raw_base/docker-compose.yml" "$install_dir/docker-compose.yml"
download "$raw_base/deploy/quick/backup.sh" "$install_dir/backup.sh"
chmod 700 "$install_dir/backup.sh"

if [ ! -f "$install_dir/.env" ]; then
  postgres_password=$(random_hex 32)
  rustfs_access_key="risuai-$(random_hex 12)"
  rustfs_secret_key=$(random_hex 32)
  restic_password=$(random_hex 32)

  cat > "$install_dir/.env" <<EOF
POSTGRES_PASSWORD=$postgres_password
RUSTFS_ACCESS_KEY=$rustfs_access_key
RUSTFS_SECRET_KEY=$rustfs_secret_key
RESTIC_PASSWORD=$restic_password
RISUAI_PORT=${HAEJEOK_RISUAI_PORT:-6001}
RUSTFS_API_PORT=${HAEJEOK_RUSTFS_API_PORT:-9000}
RUSTFS_CONSOLE_PORT=${HAEJEOK_RUSTFS_CONSOLE_PORT:-9001}
RESTIC_REPOSITORY=/repository
EOF
  chmod 600 "$install_dir/.env"
  info "Generated new PostgreSQL, RustFS, and restic credentials"
else
  chmod 600 "$install_dir/.env" 2>/dev/null || true
  info "Keeping the existing protected .env credentials"
fi
for required_key in POSTGRES_PASSWORD RUSTFS_ACCESS_KEY RUSTFS_SECRET_KEY RESTIC_PASSWORD; do
  if ! grep -Eq "^${required_key}=.+" "$install_dir/.env"; then
    die "Existing .env is missing $required_key. Refusing to overwrite it automatically."
  fi
done

cd "$install_dir"
info "Validating Docker Compose configuration"
docker compose --env-file .env config >/dev/null

if [ "$dry_run" = 1 ]; then
  printf '\nDry run complete. Files were prepared in:\n  %s\n' "$install_dir"
  exit 0
fi

docker info >/dev/null 2>&1 || die "Cannot access the Docker daemon."

info "Pulling Docker images"
docker compose --env-file .env pull

info "Starting PostgreSQL, RustFS, and Haejeok RisuAI"
docker compose --env-file .env up -d

info "Waiting for Haejeok RisuAI"
wait_count=0
while [ "$wait_count" -lt 90 ]; do
  if docker compose --env-file .env exec -T risuai \
    node -e "fetch('http://127.0.0.1:6001').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" \
    >/dev/null 2>&1; then
    break
  fi
  wait_count=$((wait_count + 1))
  sleep 2
done

if [ "$wait_count" -ge 90 ]; then
  docker compose --env-file .env ps >&2 || true
  docker compose --env-file .env logs --tail 100 risuai >&2 || true
  die "Haejeok RisuAI did not become ready within 180 seconds."
fi
port=$(sed -n 's/^RISUAI_PORT=//p' .env | tail -n 1)
[ -n "$port" ] || port=6001

printf '\nHaejeok RisuAI is ready.\n'
printf 'Open: http://localhost:%s\n' "$port"
printf 'Installation directory: %s\n' "$install_dir"
printf '\nUseful commands:\n'
printf '  cd %s\n' "$install_dir"
printf '  docker compose ps\n'
printf '  docker compose logs -f risuai\n'
printf '  ./backup.sh\n'
printf '  docker compose pull && docker compose up -d\n'
printf '\nThe restic repository password is stored in %s/.env.\n' "$install_dir"
printf 'Keep a copy of that password outside this machine before relying on backups.\n'
