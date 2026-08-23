#!/bin/sh
set -eu

script_path=$0
case "$script_path" in
  /*) ;;
  *) script_path=$PWD/$script_path ;;
esac
script_dir=${script_path%/*}
cd "$script_dir"

if [ ! -f .env ] || [ ! -f docker-compose.yml ]; then
  printf 'Error: run this script from a Haejeok RisuAI quick installation.\n' >&2
  exit 1
fi

command -v docker >/dev/null 2>&1 || {
  printf 'Error: Docker is not installed.\n' >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  printf 'Error: Docker Compose v2 is required.\n' >&2
  exit 1
}

compose() {
  docker compose --env-file .env "$@"
}

service_running() {
  compose ps --status running --services 2>/dev/null | grep -Fx "$1" >/dev/null 2>&1
}
mkdir -p backup/staging backup/restic
chmod 700 backup backup/staging backup/restic 2>/dev/null || true

app_was_running=false
rustfs_was_running=false
service_running risuai && app_was_running=true
service_running rustfs && rustfs_was_running=true

resume_services() {
  resume_status=0
  if [ "$rustfs_was_running" = true ]; then
    compose up -d rustfs >/dev/null 2>&1 || resume_status=1
  fi
  if [ "$app_was_running" = true ]; then
    compose up -d risuai >/dev/null 2>&1 || resume_status=1
  fi
  return "$resume_status"
}

clear_staging() {
  rm -f \
    backup/staging/postgres.dump.tmp \
    backup/staging/postgres.dump \
    backup/staging/deployment.env
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  resume_services || printf 'Warning: some services could not be restarted automatically.\n' >&2
  clear_staging
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

printf 'Checking restic repository...\n'
if ! compose --profile backup run --rm restic snapshots >/dev/null 2>&1; then
  printf 'Initializing restic repository...\n'
  compose --profile backup run --rm restic init
fi
if [ "$app_was_running" = true ]; then
  printf 'Stopping Haejeok RisuAI to quiesce writes...\n'
  compose stop risuai >/dev/null
fi

printf 'Creating PostgreSQL dump...\n'
compose exec -T postgres pg_dump -U risuai -d risuai -Fc > backup/staging/postgres.dump.tmp
mv -f backup/staging/postgres.dump.tmp backup/staging/postgres.dump

if [ "$rustfs_was_running" = true ]; then
  printf 'Stopping RustFS for a consistent volume snapshot...\n'
  compose stop rustfs >/dev/null
fi

{
  printf 'BACKUP_CREATED_AT=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  grep -E '^(POSTGRES_PASSWORD|RUSTFS_ACCESS_KEY|RUSTFS_SECRET_KEY|RISUAI_PORT|RUSTFS_API_PORT|RUSTFS_CONSOLE_PORT)=' .env || true
} > backup/staging/deployment.env
chmod 600 backup/staging/deployment.env

printf 'Writing encrypted restic snapshot...\n'
compose --profile backup run --rm restic backup \
  /source/save \
  /source/rustfs \
  /source/staging/postgres.dump \
  /source/staging/deployment.env \
  --tag haejeok-risuai
clear_staging
printf 'Restarting previously running services...\n'
resume_services
trap - EXIT HUP INT TERM

printf '\nBackup completed successfully.\n'
compose --profile backup run --rm restic snapshots
printf '\nKeep the RESTIC_PASSWORD from .env somewhere outside this machine.\n'
