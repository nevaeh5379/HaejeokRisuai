# Quick Docker installation

This deployment is the minimal supported path for users who want Haejeok RisuAI with PostgreSQL, RustFS, and encrypted restic backups without cloning the source repository.

Install with:

```sh
curl -fsSL https://raw.githubusercontent.com/nevaeh5379/HaejeokRisuAI/main/install.sh | sh
```

The installer writes its files to `~/haejeok-risuai` by default, generates random service credentials, pulls the prebuilt `ubfaole9/risuai:latest` image, and starts the stack.

The default endpoints are loopback-only:

- Haejeok RisuAI: `http://localhost:6001`
- RustFS S3 API: `http://127.0.0.1:9000`
- RustFS console: `http://127.0.0.1:9001`

PostgreSQL has no published host port.

## Files and persistent data

The installation directory contains:

- `.env`: generated PostgreSQL, RustFS, and restic credentials
- `docker-compose.yml`: the quick deployment definition
- `backup.sh`: coordinated restic backup helper
- `save/`: application filesystem state
- `backup/restic/`: default local encrypted restic repository
- `backup/staging/`: temporary PostgreSQL dump and recovery metadata

PostgreSQL and RustFS use Docker named volumes.
## Backups

Run:

```sh
cd ~/haejeok-risuai
./backup.sh
```

The backup helper:

1. initializes the restic repository when necessary;
2. stops the application to prevent new cross-store writes;
3. creates a consistent PostgreSQL `pg_dump` archive;
4. stops RustFS before reading its data volume;
5. backs up `save/`, the RustFS volume, the database dump, and recovery metadata with restic;
6. restarts services that were running before the backup.

The PostgreSQL data directory itself is deliberately not copied. The logical dump is the supported database backup artifact.

The default restic repository is local at `backup/restic`. It protects snapshots with encryption but does **not** protect against loss of the host or disk. Copy the repository elsewhere or configure an off-host restic backend before treating it as disaster recovery.

The `RESTIC_PASSWORD` in `.env` is required to decrypt every snapshot. Store that password separately from the server.

## Remote restic repositories

Edit `.env` and change `RESTIC_REPOSITORY`. For an S3-compatible backend, the quick stack also passes these optional variables to restic:

```text
RESTIC_AWS_ACCESS_KEY_ID=
RESTIC_AWS_SECRET_ACCESS_KEY=
RESTIC_AWS_DEFAULT_REGION=
RESTIC_AWS_SESSION_TOKEN=
```
The repository string itself determines the backend. Add only the credentials required by that backend.

Automated destructive restore is intentionally not included yet. Inspect snapshots with the restic service and test recovery on a separate installation before relying on a backup policy.

## Management

```sh
cd ~/haejeok-risuai
docker compose ps
docker compose logs -f risuai
docker compose pull && docker compose up -d
docker compose stop
docker compose up -d
```

For domain, DDNS, external reverse-proxy, or source-build deployment modes, use the full `risuai.sh` installer from a source checkout instead.
