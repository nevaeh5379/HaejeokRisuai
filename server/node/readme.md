# Risuai Node Server

> Warning: Node server may be deprecated in future versions, replaced with [Hono](https://hono.dev/) based server which could run in multiple environments including nodejs, deno, and serverless platforms such as Cloudflare Workers, Vercel Edge Functions, etc.

This is the Node.js server for Risuai, for self-hosting purposes, who want to run Risuai on their own server remotely, without using official server for privacy or other reasons.

## PostgreSQL storage

PostgreSQL can be configured from **Advanced Settings → PostgreSQL Storage** when using the Node server. Configuration changes are accepted only over HTTPS or a localhost connection. The authenticated settings page stores the connection string only on the server in `save/__postgres_config.json` with owner-only file permissions; it is never written into the Risuai application database.

Alternatively, set `DATABASE_URL` to manage the connection entirely through the server environment:

```bash
DATABASE_URL=postgresql://risuai:password@127.0.0.1:5432/risuai pnpm runserver
```

`RISU_POSTGRES_POOL_MAX` optionally controls the connection pool size and defaults to `10`. TLS and other connection settings can be supplied through the PostgreSQL connection string. When `DATABASE_URL` is present, the settings UI is read-only so a browser cannot override deployment-managed credentials.

Server startup reports each database phase separately (connect/ping, metadata inspection, schema version validation, schema loading, schema application, and final verification), including elapsed-time heartbeats. Connection targets are logged without usernames, passwords, tokens, or unrelated URL query parameters. These environment variables control failure detection:

| Variable | Default | Description |
| :--- | ---: | :--- |
| `RISU_STORAGE_CONNECT_TIMEOUT_MS` | `30000` | Maximum initial database connection wait. |
| `RISU_STORAGE_STARTUP_TIMEOUT_MS` | `180000` | Hard limit for the complete structured-storage startup step. |
| `RISU_STORAGE_STARTUP_HEARTBEAT_MS` | `10000` | Interval for “still running” progress logs. |

If startup exceeds the hard limit or the connection fails, the HTTP server continues in SQL recovery mode instead of remaining indefinitely at `Step 1`. The last numbered database phase identifies whether the delay is network/DNS/authentication, a schema query, or schema DDL (which can also indicate a database lock or heavy load). Application data endpoints return `503 storage_unavailable` until the configured SQL database is ready; static UI, authentication, health, and database configuration endpoints remain available. RisuAI never falls back to `database.bin` while SQL is configured. `SIGTERM` and `SIGINT` are logged explicitly during graceful shutdown, so a container stop can be distinguished from a startup failure.

Large initial migrations and cold-storage writes use an authenticated PostgreSQL-only JSON parser with a `1gb` decompressed-body limit. Set `RISU_POSTGRES_JSON_BODY_LIMIT` (for example, `512mb` or `2gb`) to tune this for the available server memory. Other Node API routes retain the existing `100mb` limit.

Large relational mutations are serialized before body parsing so concurrent clients cannot hold multiple migration payloads in the Node heap. SQL inserts use bounded batches (`RISUAI_SQL_BATCH_ROWS`, default `1000`), and plugin/custom-storage objects are not retained in a process-wide cache by default. Set `RISUAI_SQL_OBJECT_CACHE=1` only when lower database latency matters more than minimum resident memory.

`RISU_POSTGRES_BOOTSTRAP_URL` can seed an editable server-side configuration on the first start. The provided Docker Compose example uses this mode. `RISU_SAVE_PATH` optionally changes the Node server save directory and defaults to `<working directory>/save`.

If SQL storage has not been configured, the Node server exposes the same configuration-only recovery surface. Legacy files in `save/` are retained for an explicit import, but they are not activated as an automatic application database.

PostgreSQL mode is a relational replacement for `database/database.bin`. After the initial migration, the browser sends only changed records instead of uploading the whole database after every save. Character and chat scalars are columns; tags, greetings, group members, folders, scripts, lore, assets references, bookmarks, memory, messages, generation metadata, and prompt metadata use child or link tables. JSONB is limited to values whose shape is intentionally dynamic, such as extension properties, memory payloads, and provider-specific prompt items. Individually addressable binary asset files remain in `save/`.

Cold storage uses native UUID keys rather than opaque compressed blobs. Archived character metadata, asset references, chats, messages, generation metadata, prompt metadata, lore, scripts, and memory are decomposed into the corresponding `cold.*` relational tables. Ordered primary keys preserve order, foreign keys protect ownership, full-text and ordinary indexes support SQL queries, PostgreSQL TOAST handles large values, and cleanup runs as one set-based `DELETE` operation.

PostgreSQL text and JSONB cannot represent the NUL character (`U+0000`). Message bodies containing NUL are stored losslessly in `BYTEA`; dynamic JSON strings or object keys containing NUL use a lossless wrapper. Ordinary text and JSON remain directly queryable.

Every database and cold-storage transaction creates a row in `system.revisions`. Row-level before/after images are appended to `system.audit_log` by PostgreSQL triggers. Advanced Settings shows the recent history. Restoring a revision reverses later audited changes inside one transaction and records the result as a new `restore` revision, so restore never rewrites or deletes history. This application history complements rather than replaces `pg_dump`, WAL archiving, or managed point-in-time recovery.

Changing an active connection validates and initializes the replacement SQL database before changing the stored configuration or closing the current connection. A failed candidate leaves the existing SQL configuration untouched. Configuration changes never create, export, or import `database.bin`, and the server configuration APIs do not allow SQL storage to be disabled. Legacy migration remains a separate, explicit user action.

### Existing data migration

Migration requires explicit user confirmation and is non-destructive. Server startup never imports `database.bin` automatically:

1. Start the Node server and enable PostgreSQL in Advanced Settings, or configure `DATABASE_URL`.
2. Sign in through the existing Node server login.
3. If the SQL database is empty and a legacy `database.bin` exists, the client shows a migration confirmation prompt.
4. Only after the user confirms does the client copy the legacy data to SQL. Cancelling the prompt leaves both SQL and `database.bin` unchanged.
5. `DataSession` writes only changed settings or entity rows to PostgreSQL in a transaction; normal saves never rebuild a full database snapshot.
6. Legacy cold-storage migration is likewise triggered only by an explicit configuration/migration action.
7. Subsequent loads and saves use SQL exclusively. Legacy BIN and cold-storage files are retained as recovery copies and are never used as an automatic fallback.

Imported cold-storage IDs are recorded separately so that a retained rollback file cannot resurrect an item after PostgreSQL cleanup. Invalid legacy payloads are skipped and reported in the server log.

The earlier unreleased PostgreSQL prototype used `data JSONB` document columns and is intentionally not migrated. If that development layout is detected, startup stops with an explicit error. Back up anything needed and recreate only the development PostgreSQL volume before restarting; Risuai never deletes the volume automatically.

The server uses a revision check to reject writes from a stale browser session. Reload the application if a `revision_conflict` response is returned.

### Backups

Back up every storage location that is enabled for the deployment:

- PostgreSQL with `pg_dump` or your managed database backup facility.
- The complete `save/` directory for authentication state, local assets,
  server-side configuration, and retained legacy migration copies.
- The S3 bucket when object storage is enabled. Assets migrated to RustFS, R2,
  MinIO, or AWS S3 are not covered by a `save/` backup.
- For the guided RustFS stack, the protected `.risuai/` directory containing
  the deployment identity and credentials. Back it up with owner-only
  permissions or stronger encryption. Caddy named volumes are optional but
  retain ACME account and certificate state.

Quiesce writes when PostgreSQL, S3, and `save/` must represent one consistent
recovery point, and test restoration separately. The application revision log
is not a replacement for `pg_dump`, an S3 export, or a volume snapshot. The
current `risuai.sh` has no automated `backup` or `restore` command.

An example deployment is provided in `docker-compose.postgres.yml`. Set `POSTGRES_PASSWORD` in the environment before starting it.

### CloudBeaver in the PostgreSQL-only example

`docker-compose.postgres.yml` includes the CloudBeaver Community web database
manager. It listens on `http://127.0.0.1:8978` by default and keeps its workspace
in the `cloudbeaver-workspace` volume. In the first-run wizard, connect with
host `postgres`, port `5432`, database/user `risuai`, and the configured
`POSTGRES_PASSWORD`.

Set `CLOUDBEAVER_PORT` to change the host port, `CLOUDBEAVER_VERSION` to pin an image tag, or `CLOUDBEAVER_BIND_ADDRESS=0.0.0.0` to allow remote access. Remote access should be protected with HTTPS, a firewall, and CloudBeaver authentication because this UI can directly modify the database.

CloudBeaver is **not** included in `docker-compose.rustfs.yml`, its networking
overlays, or the `risuai.sh` guided deployment.

## S3 / RustFS Object Storage for Assets

RisuAI supports offloading media assets (character avatars, emotion sprites, audio, attachments) to **S3-compatible Object Storage** such as [RustFS](https://github.com/rustfs/rustfs), MinIO, Cloudflare R2, or AWS S3. This eliminates file system bottlenecks and inode exhaustion when managing tens of thousands of assets across multiple characters.

### Configuration

Configure S3 storage from **Advanced Settings → S3 / Object Storage**, or via environment variables:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `RISU_STORAGE_TYPE` | `fs` | Set to `s3` to enable S3 storage by default. |
| `RISU_S3_ENDPOINT` | *(empty)* | S3 endpoint URL (e.g., `http://127.0.0.1:9000` for RustFS/MinIO). |
| `RISU_S3_BUCKET` | `risuai-assets` | Target bucket name. |
| `RISU_S3_ACCESS_KEY_ID` | *(empty)* | S3 Access Key ID. |
| `RISU_S3_SECRET_ACCESS_KEY` | *(empty)* | S3 Secret Access Key. |
| `RISU_S3_REGION` | `us-east-1` | S3 Region. |
| `RISU_S3_FORCE_PATH_STYLE` | `true` | Path-style addressing (required for RustFS and MinIO). |
| `RISU_S3_AUTO_CREATE_BUCKET` | `true` | Automatically create the bucket if it does not exist. |

### RustFS + PostgreSQL All-in-One Deployment

A complete Docker Compose stack is provided in `docker-compose.rustfs.yml`:

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

Retain the generated values securely and export the same values for later
direct Compose operations. The base file intentionally requires a stable
`RISUAI_INSTALLATION_ID`, `POSTGRES_PASSWORD`, `RUSTFS_ACCESS_KEY`, and
`RUSTFS_SECRET_KEY`; it no longer falls back to the public RustFS administrator
credentials. Direct Compose use bypasses the installer's state permissions,
environment isolation, ownership checks, transaction, and port validation.

This stack starts:
- **RustFS**: High-performance Rust-based S3 object storage (S3 API on port 9000, Web Console on port 9001).
- **PostgreSQL 17**: Relational database for chats, characters, and revisions.
- **RisuAI Server**: Pre-configured to communicate with both PostgreSQL and RustFS.

PostgreSQL is private, while the default local overlay binds RisuAI, the RustFS
API, and the RustFS console to IPv4 loopback. CloudBeaver is not part of this
stack.

For a guided deployment, run:

```bash
chmod +x risuai.sh
./risuai.sh install
```

The menu supports loopback HTTP, HTTP on every IPv4 interface, a domain with
manual DNS or Cloudflare DDNS, dynv6 with automatic HTTPS, and an existing host
or Docker reverse proxy. Localhost is the default for a new interactive
installation. PostgreSQL remains private and the installer forces RustFS to
loopback in every mode.

The guided installer supports custom app, RustFS, HTTP, and HTTPS host ports;
provider token files; configurable DDNS and readiness intervals; and
`--dry-run`, `--no-start`, `--skip-ddns-check`, `--skip-port-check`, and
best-effort `--configure-firewall` workflows. Use `./risuai.sh help` for the
complete option list. Token-file options are preferred because argument values
can be exposed through process listings and shell history.

Management commands include `start`, `stop`, `restart`, `rebuild`, `down`,
`status`, `logs`, `doctor`, and `config`. `down` removes containers and private
networks while retaining named volumes, `save/`, protected state, Caddy data,
and an external proxy network. There is no automated update, backup, restore,
uninstall, or purge command; `rebuild` recreates only the RisuAI application.

The Compose services use `restart: unless-stopped`. PostgreSQL and RisuAI have
healthchecks and Caddy waits for RisuAI health, but RustFS and the DDNS sidecars
currently have no Compose health status. Installer readiness therefore proves
the internal RisuAI HTTP response and running container set, not a signed S3
operation, current DDNS, public DNS propagation, router reachability, or
external TLS.

Install/reinstall activation snapshots and restores the protected env/token
generation if startup fails, and attempts to restart the previous deployment.
It does not roll back persistent data, database migrations, built images, or an
already-completed DNS update. `--no-start` saves validated configuration without
building, starting, reconciling, or performing the one-shot DDNS check; existing
containers remain unchanged until a later reconciliation.

For automatic certificates, public TCP 80 and TCP 443 must ultimately reach
Caddy; UDP 443 is optional HTTP/3. Custom `--http-port`/`--https-port` values are
host-side mappings, so a router must still translate public TCP 80/443 (and
optional UDP 443) to those host ports. Firewall and router policy remain the
operator's responsibility. UFW is changed only when
`--configure-firewall` is explicitly supplied, on a best-effort basis, and
Docker-published ports may need separate Docker-aware firewall rules.

See [the deployment guide](../../deploy/rustfs/README.md) for complete mode and
option examples, token handling, DNS/router mappings, transaction and health
boundaries, reverse-proxy setup, backups, and direct Compose requirements.

### Asset Migration & Tools

When S3 is enabled:
- **Migrate Local Assets to S3**: Copies all existing local asset files in `save/` to the S3 bucket.
- **Download S3 Assets to Local**: Exports all objects from the S3 bucket back to the local `save/` directory.
- During migration, read requests automatically fall back to local disk if an asset hasn't been uploaded yet, ensuring zero broken images.

When structured SQL storage and S3 are both active, RisuAI maintains an `asset_catalog` mirroring **every object** in the S3 bucket (assets, thumbnails, database.bin). The first use performs one full bucket listing to initialize it; later uploads and deletes update it incrementally, so subsequent backups and the Storage Explorer query SQL instead of running `ListObjectsV2`. The catalog is scoped to the configured endpoint and bucket. Use `POST /api/asset-catalog/resync` (or the Storage Explorer's Resync button) after modifying the bucket outside RisuAI, or because lazily generated thumbnails are only tracked after a resync.

Migration and rollback use a memory-first bounded concurrency. `RISUAI_MIGRATE_CONCURRENCY` controls the worker count (default `4`; raise it only when more throughput is worth the extra memory). Files larger than 512 KiB stream to/from S3 instead of buffering in memory. Progress updates are time-throttled (~200 ms) to avoid flooding the client.

To keep migration fast on large sets (tens of thousands of files):

- Eager thumbnail generation is **skipped** during migration; thumbnails are still produced lazily on first read or via the dedicated **Generate Thumbnails** tool. Generating thumbnails inline would roughly double S3 PUT count and add sharp CPU contention.
- The S3 client uses HTTP keep-alive agents (`keepAlive`, `maxSockets`). `RISUAI_S3_MAX_SOCKETS` (default `2 × concurrency`, min `16`) tunes the per-host socket cap. Socket-level errors (EPIPE, ECONNRESET) are swallowed on the agent and via a process-level `uncaughtException` guard so an abrupt peer close during large migrations does not crash the server.
- Bulk write (`/api/write-bulk`) streams packet payloads with writable backpressure and finalizes each object before accepting more body data. `RISUAI_RESTORE_MAX_OPEN_FILES` (default `64`) bounds intentionally interleaved files; ordinary sequential backups keep only one writer open.
- When the bucket is empty (first migration) the exists-check is skipped automatically. For non-empty buckets, `RISUAI_MIGRATE_SKIP_EXISTS_CHECK=1` forces skipping it — S3 `PutObject` is idempotent so re-uploading existing keys is safe and avoids the full `ListObjectsV2` round-trips (100k keys = 100 paginated calls) plus the in-memory key set.
- The `database/database.bin` is always re-uploaded during migration (never skipped) so the S3 copy tracks the latest local state.

### database.bin conflict resolution

When S3 storage is active, the server reports SHA-256 hashes of both the local and S3 `database/database.bin` via `GET /api/db-hash`. On boot, if the two copies exist but their hashes differ, the client prompts the user to choose which copy to keep. `POST /api/db-resolve?keep=local|s3` then overwrites the non-chosen side so both locations agree, after which the database loads normally.
