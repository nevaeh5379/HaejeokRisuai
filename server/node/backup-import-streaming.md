# Streaming local-backup import

## Previous byte flow

The resumable client sends 4 MiB requests to `BackupImportUploadStore`. Each
request is persisted as an upload segment. `finalize()` reads those segments in
order and deletes each segment after it has been consumed.

`BackupImportStagingStore` then parses the container and writes every supported
entry to a per-job `.part` file. `LocalBackupImportService` builds an in-memory
entry plan, rereads all database fragments into an aggregate SQL NDJSON file,
validates every other staged entry, and finally mutates cold storage and active
asset storage before applying the prepared database.

For an object-store asset the effective path was therefore:

```
client -> upload segment -> entry .part -> S3/RustFS PutObject -> active key
```

PR #146 removed simultaneous retention of the complete upload segments and the
complete entry staging set, but the entry staging set and the prepared database
file were still proportional to the backup size. Active asset keys were also
changed before the database transaction was known to succeed.

## Streaming pipeline

The import job now owns one long-lived container parser and a prepared restore
session.

```
resumable request (bounded spool)
  -> container parser
     -> native database fragment (one current-entry spool)
        -> vendor SQL restore-record table
     -> cold-storage value (one current-entry spool)
        -> vendor SQL restore-record table
     -> asset/inlay
        -> inactive asset generation writer
  -> manifest and whole-container validation
  -> finalize gate
     -> SQL replacement transaction
     -> generation activation journal
  -> committed database + generation become observable
```

An upload request is durably spooled before it is accepted by the parser. The
spool is deleted as soon as the parser and destination have accepted it. This
keeps retry semantics without retaining every request. A repeated request at
the last accepted offset is idempotent only when its size and SHA-256 digest
match the accepted request. The server caps a request spool at 8 MiB (the
shipped client sends 4 MiB requests). Resume state remains process-local, as it
was before this change; a server restart requires a new import job. An upload
may pause between accepted request boundaries for up to one hour. After that
idle window, the parser, current destination writer, inactive generation, and
vendor restore records are aborted and removed.

Native database fragments are decoded one at a time. Encoded SQL records are
stored in the configured PostgreSQL, Oracle, or Azure SQL database and replayed
in bounded batches inside the existing replacement transaction. Cold-storage
records share that transaction. The old single-entry compatibility database
format remains a compatibility path capped at a 256 MiB encoded entry and a
512 MiB decompressed payload; native backups do not create a full
database-sized local NDJSON file. Native database and cold-storage entries are
capped at 64 MiB each (native compressed output is capped at 128 MiB), so a
malicious header or compression bomb cannot turn "current entry" into an
unbounded resource commitment.

Assets and inlays are written once to
`__restore_generations/<restore-id>/<logical-key>`. The generation wrapper maps
normal reads and writes through the active generation pointer. S3/RustFS uses a
streaming multipart writer and does not copy temporary objects at activation.
Local filesystem activation likewise changes only the pointer; it does not
copy every asset. Inlay metadata validation retains at most 1 MiB while its
payload streams to the inactive generation.

## Safety invariants

1. A generation is invisible until every container entry and the final native
   manifest have been validated.
2. Prepared SQL records never mutate active application tables before the
   final replacement transaction.
3. The activation journal records the previous generation and the database
   identity/revision expected after commit. A failed finalize rolls the pointer
   back. Startup recovery with an unavailable database preserves both
   generations and keeps serving the previous one; reconciliation keeps the
   new generation only when the same database reports the committed revision.
4. Cancellation and failure abort the current writer, delete the inactive
   generation, and remove vendor restore records.
5. Parser writes await destination backpressure. Only one container entry is
   open, destination concurrency is bounded to one for this sequential
   container format, and the server admits only one active whole-save import.
6. Duplicate names, database format mixing, fragment gaps, duplicate/final
   manifests, invalid inlays, invalid cold storage, and trailing or incomplete
   container bytes fail before activation.

## Resource bounds

Native import local disk use is bounded by one 8 MiB upload request plus one
current database/cold-storage entry. Asset and inlay bodies are never staged
locally by the importer. Memory is bounded by the upload/parser buffers, one
decoded native database fragment (at most 256 records and 128 MiB decoded),
the 1 MiB inlay metadata limit, compact SHA-256 duplicate-name digests (up to
the one-million-entry container limit), and SQL apply batches. The legacy aggregate
database compatibility path may use up to its explicit 256 MiB entry / 512 MiB
decoded limits because its gzip/MessagePack representation has no independently
resumable record framing.
