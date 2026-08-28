package co.aiclient.risu;

import android.database.Cursor;
import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteQuery;
import android.util.Base64;
import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
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
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeSqlite")
public class NativeSqlitePlugin extends Plugin {
    private static final int PIPE_BUFFER_SIZE = 512 * 1024;
    private static final int PROGRESS_STATEMENT_INTERVAL = 25;
    private static final int QUERY_FALLBACK_PAGE_ROWS = 128;
    private static final int LARGE_TEXT_CHUNK_CHARS = 64 * 1024;
    private static final int LARGE_BLOB_CHUNK_BYTES = 128 * 1024;
    private static final String TAG = "RisuNativeSqlite";

    // Every SQLiteDatabase operation runs on this one thread. Android's
    // transaction state is thread-local, so this also lets a transaction span
    // multiple Capacitor bridge calls without opening another DB connection.
    private final ExecutorService dbExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService ioExecutor = Executors.newCachedThreadPool();
    private final ConcurrentHashMap<String, RestoreSession> restoreSessions = new ConcurrentHashMap<>();
    private final List<Runnable> deferredReads = new ArrayList<>();

    private SQLiteDatabase db;
    private String databaseName;
    private String activeTransactionId;

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
    public void query(PluginCall call) {
        String sql = call.getString("sql");
        if (sql == null) {
            call.reject("sql is required");
            return;
        }
        final List<Object> bind;
        try {
            bind = readBindArray(call.getArray("bind"));
        } catch (Exception error) {
            call.reject("Invalid SQLite query bind values", error);
            return;
        }
        runWhenTransactionIdle(() -> {
            try {
                ensureOpen();
                JSArray rows = queryRows(sql, bind);
                JSObject result = new JSObject();
                result.put("values", rows);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Native SQLite query failed: " + errorMessage(error), error);
            }
        });
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
        if (expectedRevision == null) {
            call.reject("expectedRevision is required");
            return;
        }
        try {
            String id = UUID.randomUUID().toString();
            RestoreSession session = new RestoreSession(id);
            restoreSessions.put(id, session);
            runWhenTransactionIdle(() -> runRestore(session, expectedRevision));
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
                int[] executing = new int[] { 0 };
                statements = SqliteRestoreStreamParser.parse(
                    new InputStreamReader(session.input, StandardCharsets.UTF_8),
                    (sql, bind) -> {
                        String stage = classifyStatement(sql);
                        session.currentStage = stage;
                        long started = android.os.SystemClock.elapsedRealtime();
                        executeStatement(sql, bind);
                        executing[0]++;
                        long elapsed = android.os.SystemClock.elapsedRealtime() - started;
                        if (elapsed >= 1000L) {
                            Log.w(TAG, "Slow restore statement: stage=" + stage +
                                " elapsedMs=" + elapsed + " binds=" + bind.size() +
                                " sqlChars=" + sql.length());
                        }
                    },
                    completed -> reportProgress(
                        session.id,
                        completed,
                        session.currentStage,
                        false
                    )
                );
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

    private JSArray queryRows(String sql, List<Object> bind) {
        try {
            return queryRowsDirect(sql, bind);
        } catch (RuntimeException error) {
            if (!isCursorWindowRowTooLarge(error)) throw error;
            Log.w(TAG, "CursorWindow row overflow; retrying query with chunked row fallback");
            return queryRowsWithLargeRowFallback(sql, bind);
        }
    }

    private JSArray queryRowsDirect(String sql, List<Object> bind) {
        JSArray rows = new JSArray();
        try (Cursor cursor = queryCursor(sql, bind)) {
            while (cursor.moveToNext()) rows.put(readCursorRow(cursor));
        }
        return rows;
    }

    private JSObject readCursorRow(Cursor cursor) {
        JSObject row = new JSObject();
        for (int index = 0; index < cursor.getColumnCount(); index++) {
            row.put(cursor.getColumnName(index), readCursorValue(cursor, index));
        }
        return row;
    }

    private Object readCursorValue(Cursor cursor, int index) {
        switch (cursor.getType(index)) {
            case Cursor.FIELD_TYPE_NULL:
                return JSONObject.NULL;
            case Cursor.FIELD_TYPE_INTEGER:
                return cursor.getLong(index);
            case Cursor.FIELD_TYPE_FLOAT:
                return cursor.getDouble(index);
            case Cursor.FIELD_TYPE_STRING:
                return cursor.getString(index);
            case Cursor.FIELD_TYPE_BLOB:
                return bytesToJsArray(cursor.getBlob(index));
            default:
                return JSONObject.NULL;
        }
    }

    private JSArray queryRowsWithLargeRowFallback(String sql, List<Object> bind) {
        String innerSql = normalizeSubquerySql(sql);
        String[] columns = queryColumnNames(innerSql, bind);
        long total = queryCount(innerSql, bind);
        JSArray rows = new JSArray();
        appendQueryRange(rows, innerSql, bind, columns, 0, total);
        return rows;
    }

    private void appendQueryRange(
        JSArray output,
        String innerSql,
        List<Object> bind,
        String[] columns,
        long offset,
        long count
    ) {
        if (count <= 0) return;
        long pageCount = Math.min(count, QUERY_FALLBACK_PAGE_ROWS);
        String pageSql = wrapQueryRange(innerSql, offset, pageCount);
        try {
            JSArray page = queryRowsDirect(pageSql, bind);
            for (int index = 0; index < page.length(); index++) output.put(page.opt(index));
            if (count > pageCount) {
                appendQueryRange(output, innerSql, bind, columns, offset + pageCount, count - pageCount);
            }
            return;
        } catch (RuntimeException error) {
            if (!isCursorWindowRowTooLarge(error)) throw error;
        }

        if (pageCount == 1) {
            output.put(queryOversizedRow(innerSql, bind, columns, offset));
            if (count > 1) appendQueryRange(output, innerSql, bind, columns, offset + 1, count - 1);
            return;
        }

        long left = pageCount / 2;
        appendQueryRange(output, innerSql, bind, columns, offset, left);
        appendQueryRange(output, innerSql, bind, columns, offset + left, pageCount - left);
        if (count > pageCount) {
            appendQueryRange(output, innerSql, bind, columns, offset + pageCount, count - pageCount);
        }
    }

    private JSObject queryOversizedRow(
        String innerSql,
        List<Object> bind,
        String[] columns,
        long rowOffset
    ) {
        StringBuilder metadataSql = new StringBuilder("SELECT ");
        for (int index = 0; index < columns.length; index++) {
            if (index > 0) metadataSql.append(", ");
            String quoted = quoteIdentifier(columns[index]);
            metadataSql.append("typeof(").append(quoted).append(") AS ").append(quoteIdentifier("t" + index));
            metadataSql.append(", length(").append(quoted).append(") AS ").append(quoteIdentifier("l" + index));
        }
        metadataSql.append(" FROM (").append(innerSql).append(") AS risu_large_row LIMIT 1 OFFSET ").append(rowOffset);
        JSArray metadataRows = queryRowsDirect(metadataSql.toString(), bind);
        if (metadataRows.length() == 0) return new JSObject();
        JSONObject metadata = metadataRows.optJSONObject(0);
        JSObject row = new JSObject();
        for (int index = 0; index < columns.length; index++) {
            String type = metadata == null ? "null" : metadata.optString("t" + index, "null");
            long length = metadata == null ? 0 : metadata.optLong("l" + index, 0);
            row.put(columns[index], readOversizedColumn(innerSql, bind, columns[index], rowOffset, type, length));
        }
        return row;
    }

    private Object readOversizedColumn(
        String innerSql,
        List<Object> bind,
        String column,
        long rowOffset,
        String type,
        long length
    ) {
        if ("null".equals(type)) return JSONObject.NULL;
        String quoted = quoteIdentifier(column);
        if ("text".equals(type)) {
            StringBuilder value = new StringBuilder((int) Math.min(length, 1024L * 1024L));
            for (long start = 1; start <= Math.max(1, length); start += LARGE_TEXT_CHUNK_CHARS) {
                Object chunk = querySingleValue(
                    "SELECT substr(" + quoted + ", " + start + ", " + LARGE_TEXT_CHUNK_CHARS + ") AS v FROM (" +
                        innerSql + ") AS risu_large_value LIMIT 1 OFFSET " + rowOffset,
                    bind
                );
                if (chunk == null || chunk == JSONObject.NULL) break;
                value.append(String.valueOf(chunk));
            }
            return value.toString();
        }
        if ("blob".equals(type)) {
            ByteArrayOutputStream value = new ByteArrayOutputStream((int) Math.min(length, 1024L * 1024L));
            for (long start = 1; start <= Math.max(1, length); start += LARGE_BLOB_CHUNK_BYTES) {
                byte[] chunk = querySingleBlob(
                    "SELECT substr(" + quoted + ", " + start + ", " + LARGE_BLOB_CHUNK_BYTES + ") AS v FROM (" +
                        innerSql + ") AS risu_large_value LIMIT 1 OFFSET " + rowOffset,
                    bind
                );
                if (chunk == null || chunk.length == 0) break;
                value.write(chunk, 0, chunk.length);
            }
            return bytesToJsArray(value.toByteArray());
        }
        Object scalar = querySingleValue(
            "SELECT " + quoted + " AS v FROM (" + innerSql + ") AS risu_large_value LIMIT 1 OFFSET " + rowOffset,
            bind
        );
        return scalar == null ? JSONObject.NULL : scalar;
    }

    private Object querySingleValue(String sql, List<Object> bind) {
        try (Cursor cursor = queryCursor(sql, bind)) {
            if (!cursor.moveToFirst()) return JSONObject.NULL;
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

    private static JSArray bytesToJsArray(byte[] bytes) {
        JSArray result = new JSArray();
        for (byte value : bytes) result.put(value & 0xff);
        return result;
    }

    private static Long nullableLong(Object value) {
        return value instanceof Number ? ((Number) value).longValue() : null;
    }

    private static boolean isValidDatabaseName(String database) {
        return database != null && database.matches("[A-Za-z0-9._-]+");
    }

    private static String classifyStatement(String sql) {
        if (sql.contains("message_extension_nodes")) return "message metadata";
        if (sql.contains("INSERT INTO messages") || sql.contains("UPDATE messages")) return "messages";
        if (sql.contains("chat_extension_nodes")) return "chat metadata";
        if (sql.contains("INSERT INTO chats") || sql.contains("DELETE FROM chats")) return "chats";
        if (sql.contains("character_extension_nodes")) return "character metadata";
        if (sql.contains("INSERT INTO characters") || sql.contains("DELETE FROM characters")) return "characters";
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
