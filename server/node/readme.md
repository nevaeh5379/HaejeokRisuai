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

`RISU_POSTGRES_BOOTSTRAP_URL` can seed an editable server-side configuration on the first start. The provided Docker Compose example uses this mode. `RISU_SAVE_PATH` optionally changes the Node server save directory and defaults to `<working directory>/save`.

If PostgreSQL is disabled, the Node server continues to use the legacy files in `save/`.

PostgreSQL mode is a relational replacement for `database/database.bin`. After the initial migration, the browser sends only changed records instead of uploading the whole database after every save. Character and chat scalars are columns; tags, greetings, group members, folders, scripts, lore, assets references, bookmarks, memory, messages, generation metadata, and prompt metadata use child or link tables. JSONB is limited to values whose shape is intentionally dynamic, such as extension properties, memory payloads, and provider-specific prompt items. Individually addressable binary asset files remain in `save/`.

Cold storage uses native UUID keys rather than opaque compressed blobs. Archived character metadata, asset references, chats, messages, generation metadata, prompt metadata, lore, scripts, and memory are decomposed into the corresponding `risu_cold_*` relational tables. Ordered primary keys preserve order, foreign keys protect ownership, full-text and ordinary indexes support SQL queries, PostgreSQL TOAST handles large values, and cleanup runs as one set-based `DELETE` operation.

PostgreSQL text and JSONB cannot represent the NUL character (`U+0000`). Message bodies containing NUL are stored losslessly in `BYTEA`; dynamic JSON strings or object keys containing NUL use a lossless wrapper. Ordinary text and JSON remain directly queryable.

Every database and cold-storage transaction creates a row in `risu_revisions`. Row-level before/after images are appended to `risu_audit_log` by PostgreSQL triggers. Advanced Settings shows the recent history. Restoring a revision reverses later audited changes inside one transaction and records the result as a new `restore` revision, so restore never rewrites or deletes history. This application history complements rather than replaces `pg_dump`, WAL archiving, or managed point-in-time recovery.

Changing or disabling an active connection from the settings page first writes a current `database.bin` rollback snapshot and exports PostgreSQL cold storage back to the legacy file format. Legacy cold-storage files that are no longer present in SQL are moved to `save/__postgres_cold_storage_rollback/` instead of being deleted, so pruned entries do not reappear in file mode while the old copy remains recoverable. The server then validates and swaps the connection and the browser reloads, avoiding a split between stale BIN data and PostgreSQL.

### Existing data migration

Migration is automatic and non-destructive:

1. Start the Node server and enable PostgreSQL in Advanced Settings, or configure `DATABASE_URL`.
2. Sign in through the existing Node server login.
3. The client loads the existing `save/database/database.bin` once.
4. The first autosave writes a normalized snapshot to PostgreSQL in one transaction.
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
