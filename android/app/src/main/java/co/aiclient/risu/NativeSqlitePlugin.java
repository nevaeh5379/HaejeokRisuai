package co.aiclient.risu;

import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeSqlite")
public class NativeSqlitePlugin extends Plugin {
    private static final int PIPE_BUFFER_SIZE = 512 * 1024;
    private static final int PROGRESS_STATEMENT_INTERVAL = 25;
    private static final int QUERY_FALLBACK_PAGE_ROWS = 128;
    private static final int LARGE_TEXT_CHUNK_CHARS = 256 * 1024;
    private static final int LARGE_BLOB_CHUNK_BYTES = 512 * 1024;
    private static final String TAG = "RisuNativeSqlite";
    private static final Pattern CURSOR_REQUIRED_POS = Pattern.compile("requiredPos=(\\d+)");

    // Every SQLiteDatabase operation runs on this one thread. Android's
    // transaction state is thread-local, so this also lets a transaction span
    // multiple Capacitor bridge calls without opening another DB connection.
    private final ExecutorService dbExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService ioExecutor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, RestoreSession> restoreSessions = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, SqliteQueryStream> queryStreams = new ConcurrentHashMap<>();
    private final ScheduledExecutorService queryWatchdog = Executors.newSingleThreadScheduledExecutor();
    private final List<Runnable> deferredReads = new ArrayList<>();

    private SQLiteDatabase db;
    private String databaseName;
    private String activeTransactionId;

    @Override
    public void load() {
        queryWatchdog.scheduleWithFixedDelay(() -> {
            long now = System.nanoTime();
            queryStreams.forEach((id, stream) -> {
                if (stream.expire(now)) queryStreams.remove(id, stream);
            });
        }, 1, 1, TimeUnit.SECONDS);
    }

    @PluginMethod
    public void open(PluginCall call) {
        String database = call.getString("database", "risuai-local");
        if (!isValidDatabaseName(database)) {
            call.reject("Invalid SQLite database name");
            return;
        }
        dbExecutor.execute(() -> {
            try {
                if (db != null && db.isOpen()) {
                    if (!database.equals(databaseName)) {
                        throw new IOException("A different SQLite database is already open");
                    }
                    call.resolve();
                    return;
                }
                File databaseFile = getContext().getDatabasePath(database + "SQLite.db");
                File parent = databaseFile.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("Unable to create SQLite database directory");
                }
                db = SQLiteDatabase.openOrCreateDatabase(databaseFile, null);
                databaseName = database;
                db.setForeignKeyConstraintsEnabled(true);
                try {
                    db.enableWriteAheadLogging();
                } catch (Exception error) {
                    Log.w(TAG, "Unable to enable WAL; continuing with SQLite default journal mode", error);
                }
                call.resolve();
            } catch (Exception error) {
                closeDatabaseQuietly();
                call.reject("Failed to open native SQLite database: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        cancelQueryStreams();
        dbExecutor.execute(() -> {
            try {
                if (activeTransactionId != null) rollbackActiveTransaction();
                closeDatabaseQuietly();
                call.resolve();
            } catch (Exception error) {
                call.reject("Failed to close native SQLite database: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void queryStreamOpen(PluginCall call) {
        SqliteQueryStream stream = null;
        String id = UUID.randomUUID().toString();
        try {
            List<SqlStatement> queries = readStatements(call.getArray("queries"));
            stream = new SqliteQueryStream();
            queryStreams.put(id, stream);
            SqliteQueryStream pending = stream;
            runWhenTransactionIdle(() -> runQueryStream(pending, queries));
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Exception error) {
            queryStreams.remove(id);
            if (stream != null) stream.cancel();
            call.reject("Failed to open SQLite query stream: " + errorMessage(error), error);
        }
    }

    @PluginMethod
    public void queryStreamRead(PluginCall call) {
        String id = call.getString("id");
        SqliteQueryStream stream = id == null ? null : queryStreams.get(id);
        if (stream == null) {
            call.reject("Unknown SQLite query stream");
            return;
        }
        ioExecutor.execute(() -> {
            try {
                byte[] chunk = stream.read();
                JSObject result = new JSObject();
                result.put("data", chunk == null ? "" : Base64.encodeToString(chunk, Base64.NO_WRAP));
                result.put("done", chunk == null);
                call.resolve(result);
            } catch (Exception error) {
                queryStreams.remove(id, stream);
                stream.cancel();
                call.reject("Failed to read SQLite query stream: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void queryStreamClose(PluginCall call) {
        String id = call.getString("id");
        SqliteQueryStream stream = id == null ? null : queryStreams.remove(id);
        if (stream != null) stream.cancel();
        call.resolve();
    }

    private void runQueryStream(SqliteQueryStream stream, List<SqlStatement> queries) {
        Exception failure = null;
        try {
            stream.checkCancelled();
            ensureOpen();
            BufferedWriter output = stream.writer();
            SqliteQueryJsonWriter writer = new SqliteQueryJsonWriter(output);
            for (int index = 0; index < queries.size(); index++) {
                stream.checkCancelled();
                SqlStatement query = queries.get(index);
                writeQuery(writer, index, query.sql, query.bind);
                writer.endQuery(index);
            }
            output.flush();
        } catch (Exception error) {
            failure = error;
        } finally {
            // Publish failure before closing the pipe, so EOF cannot look successful.
            stream.finish(failure);
        }
    }

    private void cancelQueryStreams() {
        queryStreams.values().forEach(SqliteQueryStream::cancel);
        queryStreams.clear();
    }

    @PluginMethod
    public void beginTransaction(PluginCall call) {
        Long expectedRevision = nullableLong(call.getData().opt("expectedRevision"));
        dbExecutor.execute(() -> {
            try {
                ensureOpen();
                if (activeTransactionId != null) {
                    throw new IllegalStateException("A native SQLite transaction is already active");
                }
                String id = UUID.randomUUID().toString();
                db.beginTransaction();
                try {
                    verifyRevision(expectedRevision);
                    activeTransactionId = id;
                } catch (Exception error) {
                    if (db.inTransaction()) db.endTransaction();
                    throw error;
                }
                JSObject result = new JSObject();
                result.put("id", id);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Failed to begin native SQLite transaction: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void executeBatch(PluginCall call) {
        String id = call.getString("id");
        final List<SqlStatement> statements;
        try {
            statements = readStatements(call.getArray("statements"));
        } catch (Exception error) {
            call.reject("Invalid native SQLite statement batch", error);
            return;
        }
        dbExecutor.execute(() -> {
            try {
                ensureTransaction(id);
                for (SqlStatement statement : statements) {
                    executeStatement(statement.sql, statement.bind);
                }
                JSObject result = new JSObject();
                result.put("statements", statements.size());
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Native SQLite batch failed: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void commitTransaction(PluginCall call) {
        String id = call.getString("id");
        dbExecutor.execute(() -> {
            try {
                ensureTransaction(id);
                db.setTransactionSuccessful();
                db.endTransaction();
                activeTransactionId = null;
                flushDeferredReads();
                call.resolve();
            } catch (Exception error) {
                try {
                    rollbackActiveTransaction();
                } catch (Exception ignored) {}
                call.reject("Failed to commit native SQLite transaction: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void rollbackTransaction(PluginCall call) {
        String id = call.getString("id");
        dbExecutor.execute(() -> {
            try {
                ensureTransaction(id);
                rollbackActiveTransaction();
                call.resolve();
            } catch (Exception error) {
                call.reject("Failed to roll back native SQLite transaction: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void restoreOpen(PluginCall call) {
        Long expectedRevision = nullableLong(call.getData().opt("expectedRevision"));
        String transactionId = call.getString("transactionId");
        if ((expectedRevision == null) == (transactionId == null)) {
            call.reject("Provide either expectedRevision or transactionId");
            return;
        }
        try {
            String id = UUID.randomUUID().toString();
            RestoreSession session = new RestoreSession(id);
            restoreSessions.put(id, session);
            if (transactionId == null) {
                runWhenTransactionIdle(() -> runRestore(session, expectedRevision));
            } else {
                dbExecutor.execute(() -> runTransactionStream(session, transactionId));
            }
            ioExecutor.execute(() -> {
                try {
                    session.started.get();
                    JSObject result = new JSObject();
                    result.put("id", id);
                    call.resolve(result);
                } catch (Exception error) {
                    restoreSessions.remove(id);
                    closeOutput(session);
                    closeInput(session);
                    call.reject("Failed to open native SQLite restore stream: " + errorMessage(error), error);
                }
            });
        } catch (Exception error) {
            call.reject("Failed to create native SQLite restore stream", error);
        }
    }

    @PluginMethod
    public void restoreAppend(PluginCall call) {
        String id = call.getString("id");
        String encoded = call.getString("data");
        RestoreSession session = id == null ? null : restoreSessions.get(id);
        if (session == null || encoded == null) {
            call.reject("Unknown restore session or missing data");
            return;
        }
        if (encoded.length() > 256 * 1024) {
            call.reject("Native SQLite stream chunk exceeds transport limit");
            return;
        }
        ioExecutor.execute(() -> {
            try {
                if (session.cancelled.get()) throw new IOException("Restore session was cancelled");
                byte[] chunk = Base64.decode(encoded, Base64.DEFAULT);
                synchronized (session.output) {
                    session.output.write(chunk);
                    session.output.flush();
                }
                call.resolve();
            } catch (Exception error) {
                call.reject("Failed to append native SQLite restore data: " + errorMessage(error), error);
            }
        });
    }

    @PluginMethod
    public void restoreFinish(PluginCall call) {
        String id = call.getString("id");
        RestoreSession session = id == null ? null : restoreSessions.get(id);
        if (session == null) {
            call.reject("Unknown restore session");
            return;
        }
        ioExecutor.execute(() -> {
            try {
                closeOutput(session);
                int statements = session.result.get();
                JSObject result = new JSObject();
                result.put("statements", statements);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Native SQLite restore failed: " + errorMessage(error), error);
            } finally {
                restoreSessions.remove(id);
                closeInput(session);
            }
        });
    }

    @PluginMethod
    public void restoreAbort(PluginCall call) {
        String id = call.getString("id");
        RestoreSession session = id == null ? null : restoreSessions.remove(id);
        if (session != null) {
            session.cancelled.set(true);
            closeOutput(session);
            closeInput(session);
        }
        call.resolve();
    }

    private void runRestore(RestoreSession session, Long expectedRevision) {
        int statements = 0;
        try {
            ensureOpen();
            if (activeTransactionId != null) {
                throw new IllegalStateException("A native SQLite transaction is already active");
            }
            db.beginTransaction();
            try {
                verifyRevision(expectedRevision);
                session.started.complete(null);
                statements = applyStreamStatements(session);
                if (session.cancelled.get()) {
                    throw new IOException("Restore session was cancelled");
                }
                db.setTransactionSuccessful();
                reportProgress(session.id, statements, "committing", true);
            } finally {
                if (db.inTransaction()) db.endTransaction();
            }
            session.result.complete(statements);
        } catch (Exception error) {
            session.started.completeExceptionally(error);
            session.result.completeExceptionally(error);
        } finally {
            closeInput(session);
        }
    }

    // Runs on the same thread that began the caller's transaction. EOF ends
    // only this statement stream: the caller still owns commit/rollback.
    private void runTransactionStream(RestoreSession session, String transactionId) {
        try {
            ensureTransaction(transactionId);
            session.started.complete(null);
            int statements = applyStreamStatements(session);
            if (session.cancelled.get()) throw new IOException("SQLite statement stream was cancelled");
            session.result.complete(statements);
        } catch (Exception error) {
            if (transactionId.equals(activeTransactionId)) {
                try { rollbackActiveTransaction(); } catch (Exception ignored) {}
            }
            session.started.completeExceptionally(error);
            session.result.completeExceptionally(error);
        } finally {
            closeInput(session);
        }
    }

    private int applyStreamStatements(RestoreSession session) throws Exception {
        return SqliteRestoreStreamParser.parse(
            new InputStreamReader(session.input, StandardCharsets.UTF_8),
            (sql, bind) -> {
                String stage = classifyStatement(sql);
                session.currentStage = stage;
                long started = android.os.SystemClock.elapsedRealtime();
                executeStatement(sql, bind);
                long elapsed = android.os.SystemClock.elapsedRealtime() - started;
                if (elapsed >= 1000L) {
                    Log.w(TAG, "Slow stream statement: stage=" + stage +
                        " elapsedMs=" + elapsed + " binds=" + bind.size() +
                        " sqlChars=" + sql.length());
                }
            },
            completed -> reportProgress(session.id, completed, session.currentStage, false)
        );
    }

    private void runWhenTransactionIdle(Runnable task) {
        dbExecutor.execute(() -> {
            if (activeTransactionId != null) {
                deferredReads.add(task);
                return;
            }
            task.run();
        });
    }

    private void flushDeferredReads() {
        if (deferredReads.isEmpty()) return;
        List<Runnable> pending = new ArrayList<>(deferredReads);
        deferredReads.clear();
        for (Runnable task : pending) dbExecutor.execute(task);
    }

    private void rollbackActiveTransaction() {
        try {
            if (db != null && db.inTransaction()) db.endTransaction();
        } finally {
            activeTransactionId = null;
            flushDeferredReads();
        }
    }

    private void ensureTransaction(String id) {
        ensureOpen();
        if (id == null || activeTransactionId == null || !activeTransactionId.equals(id)) {
            throw new IllegalStateException("Unknown or inactive native SQLite transaction");
        }
    }

    private void ensureOpen() {
        if (db == null || !db.isOpen()) throw new IllegalStateException("Native SQLite database is not open");
    }

    private void verifyRevision(Long expectedRevision) throws IOException {
        if (expectedRevision == null) return;
        try (Cursor cursor = queryCursor(
            "SELECT revision FROM system_storage_meta WHERE singleton = 1",
            new ArrayList<>()
        )) {
            long actual = cursor.moveToFirst() ? cursor.getLong(0) : 0L;
            if (actual != expectedRevision.longValue()) {
                throw new IOException(
                    "SQLite revision conflict: expected " + expectedRevision + ", got " + actual
                );
            }
        }
    }

    private void writeQuery(SqliteQueryJsonWriter writer, int index, String sql, List<Object> bind)
        throws IOException {
        AndroidCrashDiagnostics.checkpoint("sqlite:query-start " + classifyStatement(sql));
        long startedAt = System.nanoTime();
        long[] emitted = { 0 };
        try {
            writeCursorRows(writer, index, sql, bind, emitted);
        } catch (RuntimeException error) {
            if (!isCursorWindowRowTooLarge(error)) throw error;
            String innerSql = normalizeSubquerySql(sql);
            String[] columns = queryColumnNames(innerSql, bind);
            long total = queryCount(innerSql, bind);
            Long badRow = cursorWindowRequiredPos(error);
            if (badRow != null && badRow >= emitted[0] && badRow < total) {
                try {
                    // Retain the direct jump optimization for a late oversized node:
                    // do not replay thousands of prefix rows in LIMIT/OFFSET pages.
                    if (badRow > emitted[0]) {
                        writeCursorRows(writer, index,
                            wrapQueryRange(innerSql, emitted[0], badRow - emitted[0]), bind, emitted);
                    }
                    SqlStatement direct = directRelationalNodeQuery(innerSql, bind, badRow);
                    writeOversizedRow(writer, index, direct == null ? innerSql : direct.sql,
                        direct == null ? bind : direct.bind, columns, direct == null ? badRow : 0);
                    emitted[0]++;
                } catch (RuntimeException retryError) {
                    if (!isCursorWindowRowTooLarge(retryError)) throw retryError;
                }
            }
            // Previously emitted rows remain valid. Resume after them, never replay them.
            writeQueryRange(writer, index, innerSql, bind, columns, emitted[0], total - emitted[0], emitted);
        }
        long elapsedMs = (System.nanoTime() - startedAt) / 1_000_000L;
        AndroidCrashDiagnostics.checkpoint("sqlite:query-end rows=" + emitted[0] + " ms=" + elapsedMs);
        if (elapsedMs >= 100) {
            Log.i(TAG, "Slow " + classifyStatement(sql) + " query" + queryDiagnosticSuffix(sql, bind) +
                ": " + elapsedMs + " ms, " + emitted[0] + " rows");
        }
    }

    private void writeCursorRows(
        SqliteQueryJsonWriter writer, int queryIndex, String sql, List<Object> bind, long[] emitted
    ) throws IOException {
        try (Cursor cursor = queryCursor(sql, bind)) {
            while (cursor.moveToNext()) {
                writer.beginRow(queryIndex);
                for (int column = 0; column < cursor.getColumnCount(); column++) {
                    writer.column(cursor.getColumnName(column));
                    if (cursor.getType(column) == Cursor.FIELD_TYPE_BLOB) {
                        writer.beginBlob();
                        writer.blobChunk(cursor.getBlob(column));
                        writer.endBlob();
                    } else writer.scalar(readCursorValue(cursor, column));
                }
                writer.endRow();
                emitted[0]++;
            }
        }
    }

    private Object readCursorValue(Cursor cursor, int index) {
        switch (cursor.getType(index)) {
            case Cursor.FIELD_TYPE_INTEGER: return cursor.getLong(index);
            case Cursor.FIELD_TYPE_FLOAT: return cursor.getDouble(index);
            case Cursor.FIELD_TYPE_STRING: return cursor.getString(index);
            default: return null;
        }
    }

    private void writeQueryRange(
        SqliteQueryJsonWriter writer, int queryIndex, String innerSql, List<Object> bind,
        String[] columns, long offset, long count, long[] emitted
    ) throws IOException {
        while (count > 0) {
            long pageCount = Math.min(count, QUERY_FALLBACK_PAGE_ROWS);
            writeQueryPage(writer, queryIndex, innerSql, bind, columns, offset, pageCount, emitted);
            offset += pageCount;
            count -= pageCount;
        }
    }

    private void writeQueryPage(
        SqliteQueryJsonWriter writer, int queryIndex, String innerSql, List<Object> bind,
        String[] columns, long offset, long count, long[] emitted
    ) throws IOException {
        long before = emitted[0];
        try {
            writeCursorRows(writer, queryIndex, wrapQueryRange(innerSql, offset, count), bind, emitted);
            return;
        } catch (RuntimeException error) {
            if (!isCursorWindowRowTooLarge(error)) throw error;
        }
        long completed = emitted[0] - before;
        offset += completed;
        count -= completed;
        if (count == 1) {
            SqlStatement direct = directRelationalNodeQuery(innerSql, bind, offset);
            writeOversizedRow(writer, queryIndex, direct == null ? innerSql : direct.sql,
                direct == null ? bind : direct.bind, columns, direct == null ? offset : 0);
            emitted[0]++;
        } else if (count > 1) {
            long left = count / 2;
            writeQueryPage(writer, queryIndex, innerSql, bind, columns, offset, left, emitted);
            writeQueryPage(writer, queryIndex, innerSql, bind, columns, offset + left, count - left, emitted);
        }
    }

    /**
     * loadNodeValue() reads one relational-node table ordered by node_id. When
     * one TEXT/BLOB cell is larger than CursorWindow, resolving it again through
     * the original subquery + OFFSET repeats the same ordered scan for every
     * chunk. Relational nodes already have a composite primary key, so resolve
     * the offending node_id once and chunk that exact row by PK instead.
     */
    private SqlStatement directRelationalNodeQuery(
        String innerSql,
        List<Object> bind,
        long rowOffset
    ) {
        if (bind == null || bind.size() != 1) return null;
        String table = null;
        String ownerColumn = null;
        if (innerSql.contains("FROM setting_extension_nodes") && innerSql.contains("WHERE setting_key = ?")) {
            table = "setting_extension_nodes";
            ownerColumn = "setting_key";
        } else if (innerSql.contains("FROM character_extension_nodes") && innerSql.contains("WHERE character_id = ?")) {
            table = "character_extension_nodes";
            ownerColumn = "character_id";
        } else if (innerSql.contains("FROM chat_extension_nodes") && innerSql.contains("WHERE chat_id = ?")) {
            table = "chat_extension_nodes";
            ownerColumn = "chat_id";
        } else if (innerSql.contains("FROM cold_extension_nodes") && innerSql.contains("WHERE archive_id = ?")) {
            table = "cold_extension_nodes";
            ownerColumn = "archive_id";
        }
        if (table == null || !innerSql.contains("ORDER BY node_id")) return null;

        Object nodeId = querySingleValue(
            "SELECT node_id AS v FROM " + table + " WHERE " + ownerColumn +
                " = ? ORDER BY node_id LIMIT 1 OFFSET " + rowOffset,
            bind
        );
        if (!(nodeId instanceof Number)) return null;

        List<Object> directBind = new ArrayList<>();
        directBind.add(bind.get(0));
        directBind.add(((Number) nodeId).longValue());
        String directSql =
            "SELECT node_id, parent_node_id, node_order, object_key, object_key_encoded, " +
            "value_type, text_value, encoded_text_value, number_value, boolean_value FROM " +
            table + " WHERE " + ownerColumn + " = ? AND node_id = ?";
        return new SqlStatement(directSql, directBind);
    }

    private void writeOversizedRow(
        SqliteQueryJsonWriter writer, int queryIndex, String innerSql,
        List<Object> bind, String[] columns, long rowOffset
    ) throws IOException {
        StringBuilder metadataSql = new StringBuilder("SELECT ");
        for (int index = 0; index < columns.length; index++) {
            if (index > 0) metadataSql.append(", ");
            String quoted = quoteIdentifier(columns[index]);
            metadataSql.append("typeof(").append(quoted).append(") AS ").append(quoteIdentifier("t" + index));
            metadataSql.append(", length(").append(quoted).append(") AS ").append(quoteIdentifier("l" + index));
        }
        metadataSql.append(" FROM (").append(innerSql).append(") AS risu_large_row LIMIT 1 OFFSET ").append(rowOffset);
        try (Cursor metadata = queryCursor(metadataSql.toString(), bind)) {
            if (!metadata.moveToFirst()) throw new IOException("Oversized SQLite row disappeared");
            writer.beginRow(queryIndex);
            for (int index = 0; index < columns.length; index++) {
                writer.column(columns[index]);
                writeOversizedColumn(writer, innerSql, bind, columns[index], rowOffset,
                    metadata.getString(index * 2), metadata.getLong(index * 2 + 1));
            }
            writer.endRow();
        }
    }

    private void writeOversizedColumn(
        SqliteQueryJsonWriter writer, String innerSql, List<Object> bind,
        String column, long rowOffset, String type, long length
    ) throws IOException {
        String quoted = quoteIdentifier(column);
        if ("text".equals(type)) {
            writer.beginString();
            for (long start = 1; start <= length; start += LARGE_TEXT_CHUNK_CHARS) {
                Object chunk = querySingleValue(
                    "SELECT substr(" + quoted + ", " + start + ", " + LARGE_TEXT_CHUNK_CHARS + ") AS v FROM (" +
                        innerSql + ") AS risu_large_value LIMIT 1 OFFSET " + rowOffset, bind);
                if (chunk == null) throw new IOException("Oversized SQLite text disappeared");
                writer.stringChunk(chunk.toString());
            }
            writer.endString();
        } else if ("blob".equals(type)) {
            writer.beginBlob();
            for (long start = 1; start <= length; start += LARGE_BLOB_CHUNK_BYTES) {
                byte[] chunk = querySingleBlob(
                    "SELECT substr(" + quoted + ", " + start + ", " + LARGE_BLOB_CHUNK_BYTES + ") AS v FROM (" +
                        innerSql + ") AS risu_large_value LIMIT 1 OFFSET " + rowOffset, bind);
                if (chunk == null || chunk.length == 0) throw new IOException("Oversized SQLite blob disappeared");
                writer.blobChunk(chunk);
            }
            writer.endBlob();
        } else {
            writer.scalar(querySingleValue(
                "SELECT " + quoted + " AS v FROM (" + innerSql + ") AS risu_large_value LIMIT 1 OFFSET " + rowOffset, bind));
        }
    }

    private Object querySingleValue(String sql, List<Object> bind) {
        try (Cursor cursor = queryCursor(sql, bind)) {
            if (!cursor.moveToFirst()) return null;
            return readCursorValue(cursor, 0);
        }
    }

    private byte[] querySingleBlob(String sql, List<Object> bind) {
        try (Cursor cursor = queryCursor(sql, bind)) {
            if (!cursor.moveToFirst() || cursor.isNull(0)) return null;
            return cursor.getBlob(0);
        }
    }

    private String[] queryColumnNames(String innerSql, List<Object> bind) {
        try (Cursor cursor = queryCursor("SELECT * FROM (" + innerSql + ") AS risu_columns LIMIT 0", bind)) {
            return cursor.getColumnNames();
        }
    }

    private long queryCount(String innerSql, List<Object> bind) {
        Object value = querySingleValue("SELECT COUNT(*) FROM (" + innerSql + ") AS risu_count", bind);
        return value instanceof Number ? ((Number) value).longValue() : 0L;
    }

    private static String wrapQueryRange(String innerSql, long offset, long count) {
        return "SELECT * FROM (" + innerSql + ") AS risu_page LIMIT " + count + " OFFSET " + offset;
    }

    private static String normalizeSubquerySql(String sql) {
        String normalized = sql.trim();
        while (normalized.endsWith(";")) normalized = normalized.substring(0, normalized.length() - 1).trim();
        return normalized;
    }

    private static String quoteIdentifier(String identifier) {
        return "\"" + identifier.replace("\"", "\"\"") + "\"";
    }

    private static boolean isCursorWindowRowTooLarge(Throwable error) {
        Throwable current = error;
        while (current != null) {
            String message = current.getMessage();
            if (message != null && (
                message.contains("Row too big to fit into CursorWindow") ||
                message.contains("SQLiteBlobTooBigException") ||
                message.contains("CursorWindow") && message.contains("too big")
            )) return true;
            current = current.getCause();
        }
        return false;
    }

    private static Long cursorWindowRequiredPos(Throwable error) {
        while (error != null) {
            String message = error.getMessage();
            if (message != null) {
                Matcher matcher = CURSOR_REQUIRED_POS.matcher(message);
                if (matcher.find()) {
                    try { return Long.parseLong(matcher.group(1)); }
                    catch (NumberFormatException ignored) {}
                }
            }
            error = error.getCause();
        }
        return null;
    }

    private Cursor queryCursor(String sql, List<Object> bind) {
        return db.rawQueryWithFactory(
            (database, driver, editTable, query) -> {
                for (int index = 0; index < bind.size(); index++) {
                    DatabaseUtils.bindObjectToProgram(query, index + 1, bind.get(index));
                }
                return new SQLiteCursor(driver, editTable, query);
            },
            sql,
            new String[0],
            null
        );
    }

    private void executeStatement(String sql, List<Object> bind) {
        if (bind == null || bind.isEmpty()) db.execSQL(sql);
        else db.execSQL(sql, bind.toArray(new Object[0]));
    }

    private static List<SqlStatement> readStatements(JSArray array) throws JSONException {
        if (array == null) throw new JSONException("statements is required");
        List<SqlStatement> statements = new ArrayList<>();
        for (int index = 0; index < array.length(); index++) {
            JSONObject item = array.getJSONObject(index);
            String sql = item.getString("sql");
            statements.add(new SqlStatement(sql, readBindArray(item.optJSONArray("bind"))));
        }
        return statements;
    }

    private static List<Object> readBindArray(JSONArray array) throws JSONException {
        List<Object> values = new ArrayList<>();
        if (array == null) return values;
        for (int index = 0; index < array.length(); index++) {
            if (array.isNull(index)) {
                values.add(null);
                continue;
            }
            Object value = array.get(index);
            if (value instanceof Boolean) {
                values.add(Boolean.TRUE.equals(value) ? 1L : 0L);
            } else if (value instanceof JSONObject && "Buffer".equals(((JSONObject) value).optString("type"))) {
                JSONArray data = ((JSONObject) value).optJSONArray("data");
                if (data == null) throw new JSONException("Invalid Buffer bind value");
                byte[] bytes = new byte[data.length()];
                for (int byteIndex = 0; byteIndex < data.length(); byteIndex++) {
                    bytes[byteIndex] = (byte) (data.getInt(byteIndex) & 0xff);
                }
                values.add(bytes);
            } else {
                values.add(value);
            }
        }
        return values;
    }

    private static Long nullableLong(Object value) {
        return value instanceof Number ? ((Number) value).longValue() : null;
    }

    private static boolean isValidDatabaseName(String database) {
        return database != null && database.matches("[A-Za-z0-9._-]+");
    }

    private static String queryDiagnosticSuffix(String sql, List<Object> bind) {
        if (
            sql.contains("setting_extension_nodes") &&
            bind != null &&
            !bind.isEmpty() &&
            bind.get(0) instanceof String
        ) {
            String key = ((String) bind.get(0)).replace("\n", "").replace("\r", "");
            if (key.length() > 80) key = key.substring(0, 80);
            return " [key=" + key + "]";
        }
        return "";
    }

    private static String classifyStatement(String sql) {
        if (sql.contains("message_extension_nodes")) return "message metadata";
        if (sql.contains("INSERT INTO messages") || sql.contains("UPDATE messages")) return "messages";
        if (sql.contains("chat_extension_nodes")) return "chat metadata";
        if (sql.contains("INSERT INTO chats") || sql.contains("DELETE FROM chats")) return "chats";
        if (sql.contains("character_extension_nodes")) return "character metadata";
        if (sql.contains("INSERT INTO characters") || sql.contains("DELETE FROM characters")) return "characters";
        if (sql.contains("module_extension_nodes") || sql.contains("module_records")) return "modules";
        if (sql.contains("plugin_extension_nodes") || sql.contains("plugin_records")) return "plugin metadata";
        if (sql.contains("bot_presets")) return "presets";
        if (sql.contains("plugin_custom_storage")) return "plugin storage";
        if (sql.contains("system_settings") || sql.contains("setting_extension_nodes")) return "settings";
        return "finalizing";
    }

    private void reportProgress(String id, int completed, String stage, boolean force) {
        if (!force && completed != 1 && completed % PROGRESS_STATEMENT_INTERVAL != 0) return;
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("completed", completed);
        event.put("stage", stage);
        notifyListeners("restoreProgress", event);
    }

    private static String errorMessage(Throwable error) {
        Throwable current = error;
        while ((current instanceof ExecutionException) && current.getCause() != null) {
            current = current.getCause();
        }
        String message = current.getMessage();
        return message == null || message.trim().isEmpty()
            ? current.getClass().getSimpleName()
            : message;
    }

    private void closeDatabaseQuietly() {
        cancelQueryStreams();
        SQLiteDatabase current = db;
        db = null;
        databaseName = null;
        activeTransactionId = null;
        deferredReads.clear();
        if (current != null) {
            try {
                current.close();
            } catch (Exception ignored) {}
        }
    }

    private static void closeOutput(RestoreSession session) {
        try {
            synchronized (session.output) {
                session.output.close();
            }
        } catch (IOException ignored) {}
    }

    private static void closeInput(RestoreSession session) {
        try {
            session.input.close();
        } catch (IOException ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        cancelQueryStreams();
        queryWatchdog.shutdownNow();
        for (RestoreSession session : restoreSessions.values()) {
            session.cancelled.set(true);
            closeOutput(session);
            closeInput(session);
        }
        restoreSessions.clear();
        dbExecutor.execute(this::closeDatabaseQuietly);
        dbExecutor.shutdown();
        ioExecutor.shutdownNow();
        super.handleOnDestroy();
    }

    private static final class SqlStatement {
        final String sql;
        final List<Object> bind;

        SqlStatement(String sql, List<Object> bind) {
            this.sql = sql;
            this.bind = bind;
        }
    }

    private static final class RestoreSession {
        final String id;
        final PipedInputStream input;
        final PipedOutputStream output;
        final CompletableFuture<Void> started = new CompletableFuture<>();
        final CompletableFuture<Integer> result = new CompletableFuture<>();
        final AtomicBoolean cancelled = new AtomicBoolean(false);
        volatile String currentStage = "preparing";

        RestoreSession(String id) throws IOException {
            this.id = id;
            this.input = new PipedInputStream(PIPE_BUFFER_SIZE);
            this.output = new PipedOutputStream(input);
        }
    }
}
