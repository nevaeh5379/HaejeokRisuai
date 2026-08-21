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

Large initial migrations and cold-storage writes use an authenticated PostgreSQL-only JSON parser with a `1gb` decompressed-body limit. Set `RISU_POSTGRES_JSON_BODY_LIMIT` (for example, `512mb` or `2gb`) to tune this for the available server memory. Other Node API routes retain the existing `100mb` limit.

Large relational mutations are serialized before body parsing so concurrent clients cannot hold multiple migration payloads in the Node heap. SQL inserts use bounded batches (`RISUAI_SQL_BATCH_ROWS`, default `1000`), and plugin/custom-storage objects are not retained in a process-wide cache by default. Set `RISUAI_SQL_OBJECT_CACHE=1` only when lower database latency matters more than minimum resident memory.

`RISU_POSTGRES_BOOTSTRAP_URL` can seed an editable server-side configuration on the first start. The provided Docker Compose example uses this mode. `RISU_SAVE_PATH` optionally changes the Node server save directory and defaults to `<working directory>/save`.

If PostgreSQL is disabled, the Node server continues to use the legacy files in `save/`.

PostgreSQL mode is a relational replacement for `database/database.bin`. After the initial migration, the browser sends only changed records instead of uploading the whole database after every save. Character and chat scalars are columns; tags, greetings, group members, folders, scripts, lore, assets references, bookmarks, memory, messages, generation metadata, and prompt metadata use child or link tables. JSONB is limited to values whose shape is intentionally dynamic, such as extension properties, memory payloads, and provider-specific prompt items. Individually addressable binary asset files remain in `save/`.

Cold storage uses native UUID keys rather than opaque compressed blobs. Archived character metadata, asset references, chats, messages, generation metadata, prompt metadata, lore, scripts, and memory are decomposed into the corresponding `cold.*` relational tables. Ordered primary keys preserve order, foreign keys protect ownership, full-text and ordinary indexes support SQL queries, PostgreSQL TOAST handles large values, and cleanup runs as one set-based `DELETE` operation.

PostgreSQL text and JSONB cannot represent the NUL character (`U+0000`). Message bodies containing NUL are stored losslessly in `BYTEA`; dynamic JSON strings or object keys containing NUL use a lossless wrapper. Ordinary text and JSON remain directly queryable.

Every database and cold-storage transaction creates a row in `system.revisions`. Row-level before/after images are appended to `system.audit_log` by PostgreSQL triggers. Advanced Settings shows the recent history. Restoring a revision reverses later audited changes inside one transaction and records the result as a new `restore` revision, so restore never rewrites or deletes history. This application history complements rather than replaces `pg_dump`, WAL archiving, or managed point-in-time recovery.

Changing or disabling an active connection from the settings page first writes a current `database.bin` rollback snapshot and exports PostgreSQL cold storage back to the legacy file format. Legacy cold-storage files that are no longer present in SQL are moved to `save/__postgres_cold_storage_rollback/` instead of being deleted, so pruned entries do not reappear in file mode while the old copy remains recoverable. The server then validates and swaps the connection and the browser reloads, avoiding a split between stale BIN data and PostgreSQL.

### Existing data migration

Migration is automatic and non-destructive:

1. Start the Node server and enable PostgreSQL in Advanced Settings, or configure `DATABASE_URL`.
2. Sign in through the existing Node server login.
3. The client loads the existing `save/database/database.bin` once.
4. `DataSession` writes only changed settings or entity rows to PostgreSQL in a transaction; normal saves never rebuild a full database snapshot.
5. On server startup, legacy `coldstorage/` files are decompressed locally and imported into relational cold-storage tables without browser traffic.
6. Subsequent loads and saves use PostgreSQL. Legacy BIN and cold-storage files are retained as rollback copies and are not overwritten by PostgreSQL saves.

Imported cold-storage IDs are recorded separately so that a retained rollback file cannot resurrect an item after PostgreSQL cleanup. Invalid legacy payloads are skipped and reported in the server log.

The earlier unreleased PostgreSQL prototype used `data JSONB` document columns and is intentionally not migrated. If that development layout is detected, startup stops with an explicit error. Back up anything needed and recreate only the development PostgreSQL volume before restarting; Risuai never deletes the volume automatically.

The server uses a revision check to reject writes from a stale browser session. Reload the application if a `revision_conflict` response is returned.

### Backups

Back up both storage locations:

- PostgreSQL with `pg_dump` or your managed database backup facility.
- The `save/` directory for assets, authentication state, and retained legacy migration copies.

An example deployment is provided in `docker-compose.postgres.yml`. Set `POSTGRES_PASSWORD` in the environment before starting it.

### CloudBeaver

The PostgreSQL Compose example also includes the CloudBeaver Community web database manager. It listens on `http://127.0.0.1:8978` by default and keeps its workspace in the `cloudbeaver-workspace` volume. In the first-run wizard, connect with host `postgres`, port `5432`, database/user `risuai`, and the configured `POSTGRES_PASSWORD`.

Set `CLOUDBEAVER_PORT` to change the host port, `CLOUDBEAVER_VERSION` to pin an image tag, or `CLOUDBEAVER_BIND_ADDRESS=0.0.0.0` to allow remote access. Remote access should be protected with HTTPS, a firewall, and CloudBeaver authentication because this UI can directly modify the database.

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

```bash
POSTGRES_PASSWORD=your_password docker compose -f docker-compose.rustfs.yml up -d
```

This stack starts:
- **RustFS**: High-performance Rust-based S3 object storage (S3 API on port 9000, Web Console on port 9001).
- **PostgreSQL 17**: Relational database for chats, characters, and revisions.
- **RisuAI Server**: Pre-configured to communicate with both PostgreSQL and RustFS.
- **CloudBeaver**: Database explorer on port 8978.

For a public installation using a dynv6 hostname and automatic HTTPS, create the
hostname and HTTP token at dynv6 first, then run:

```bash
chmod +x risuai.sh
./risuai.sh install
```

The installer securely prompts for the hostname and token, generates database and
storage credentials, starts a dynv6 updater, and puts Caddy in front of RisuAI.
Ports 80 and 443 must be forwarded to the server. PostgreSQL is kept inside the
Compose network, while RisuAI and the RustFS API/console bind only to localhost.
Before building, the installer reports and stops for processes or containers that
already listen on TCP 80/443 or UDP 443.
Use `./risuai.sh --help` for non-interactive and IPv6 options. After installation,
manage the stack with `./risuai.sh start|stop|restart|rebuild|status|logs`. The
`stop` command keeps all PostgreSQL, RustFS, Caddy, and local save data intact.
After updating the source, `./risuai.sh rebuild` rebuilds and recreates only the
RisuAI application while leaving PostgreSQL and RustFS running.

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
