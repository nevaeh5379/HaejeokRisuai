package co.aiclient.risu;

import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "NativeSqliteRestore")
public class NativeSqliteRestorePlugin extends Plugin {
    private static final int PIPE_BUFFER_SIZE = 512 * 1024;
    private static final int PROGRESS_STATEMENT_INTERVAL = 25;
    private final ConcurrentHashMap<String, RestoreSession> sessions = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void open(PluginCall call) {
        String database = call.getString("database", "risuai-local");
        if (!database.matches("[A-Za-z0-9._-]+")) {
            call.reject("Invalid SQLite database name");
            return;
        }
        Object expectedRaw = call.getData().opt("expectedRevision");
        Long expectedRevision = expectedRaw instanceof Number
            ? ((Number) expectedRaw).longValue()
            : null;
        try {
            String id = UUID.randomUUID().toString();
            RestoreSession session = new RestoreSession(id);
            sessions.put(id, session);
            executor.execute(() -> runRestore(session, database, expectedRevision));
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Failed to open native SQLite restore stream", error);
        }
    }

    @PluginMethod
    public void append(PluginCall call) {
        String id = call.getString("id");
        String encoded = call.getString("data");
        RestoreSession session = id == null ? null : sessions.get(id);
        if (session == null || encoded == null) {
            call.reject("Unknown restore session or missing data");
            return;
        }        executor.execute(() -> {
            try {
                if (session.cancelled.get()) throw new IOException("Restore session was cancelled");
                byte[] chunk = Base64.decode(encoded, Base64.DEFAULT);
                synchronized (session.output) {
                    session.output.write(chunk);
                    session.output.flush();
                }
                call.resolve();
            } catch (Exception error) {
                call.reject("Failed to append native SQLite restore data", error);
            }
        });
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String id = call.getString("id");
        RestoreSession session = id == null ? null : sessions.get(id);
        if (session == null) {
            call.reject("Unknown restore session");
            return;
        }
        executor.execute(() -> {
            try {
                closeOutput(session);
                int statements = session.result.get();
                JSObject result = new JSObject();
                result.put("statements", statements);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Native SQLite restore failed: " + errorMessage(error), error);
            } finally {
                sessions.remove(id);
                closeInput(session);
            }
        });
    }
    @PluginMethod
    public void abort(PluginCall call) {
        String id = call.getString("id");
        RestoreSession session = id == null ? null : sessions.remove(id);
        if (session != null) {
            session.cancelled.set(true);
            closeOutput(session);
            closeInput(session);
        }
        call.resolve();
    }

    private void runRestore(
        RestoreSession session,
        String database,
        Long expectedRevision
    ) {
        SQLiteDatabase db = null;
        try {
            File databaseFile = getContext().getDatabasePath(database + "SQLite.db");
            if (!databaseFile.isFile()) {
                throw new IOException("SQLite database does not exist: " + databaseFile.getName());
            }
            db = SQLiteDatabase.openDatabase(
                databaseFile.getAbsolutePath(),
                null,
                SQLiteDatabase.OPEN_READWRITE
            );
            db.execSQL("PRAGMA foreign_keys = ON");
            db.beginTransaction();
            verifyRevision(db, expectedRevision);
            SQLiteDatabase activeDb = db;
            int statements = SqliteRestoreStreamParser.parse(
                new InputStreamReader(session.input, StandardCharsets.UTF_8),
                (sql, bind) -> executeStatement(activeDb, sql, bind),
                completed -> reportProgress(session.id, completed)
            );            if (session.cancelled.get()) throw new IOException("Restore session was cancelled");
            db.setTransactionSuccessful();
            session.result.complete(statements);
        } catch (Exception error) {
            session.result.completeExceptionally(error);
        } finally {
            if (db != null) {
                try {
                    if (db.inTransaction()) db.endTransaction();
                } catch (Exception ignored) {}
                try {
                    db.close();
                } catch (Exception ignored) {}
            }
            closeInput(session);
        }
    }

    private static void verifyRevision(SQLiteDatabase db, Long expectedRevision)
        throws IOException {
        if (expectedRevision == null) return;
        try (Cursor cursor = db.rawQuery(
            "SELECT revision FROM system_storage_meta WHERE singleton = 1",
            null
        )) {
            long actual = cursor.moveToFirst() ? cursor.getLong(0) : 0L;
            if (actual != expectedRevision.longValue()) {
                throw new IOException(
                    "SQLite revision conflict: expected " + expectedRevision + ", got " + actual
                );
            }
        }
    }

    private static void executeStatement(
        SQLiteDatabase db,
        String sql,
        List<Object> bind
    ) {
        if (bind.isEmpty()) db.execSQL(sql);
        else db.execSQL(sql, bind.toArray(new Object[0]));
    }
    private void reportProgress(String id, int completed) {
        if (
            completed != 1 &&
            completed % PROGRESS_STATEMENT_INTERVAL != 0
        ) return;
        JSObject event = new JSObject();
        event.put("id", id);
        event.put("completed", completed);
        notifyListeners("restoreProgress", event);
    }

    private static String errorMessage(Throwable error) {
        Throwable current = error;
        if (current instanceof ExecutionException && current.getCause() != null) {
            current = current.getCause();
        }
        String message = current.getMessage();
        return message == null || message.trim().isEmpty()
            ? current.getClass().getSimpleName()
            : message;
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
        for (RestoreSession session : sessions.values()) {
            session.cancelled.set(true);
            closeOutput(session);
            closeInput(session);
        }
        sessions.clear();
        executor.shutdownNow();
    }
    private static final class RestoreSession {
        final String id;
        final PipedInputStream input;
        final PipedOutputStream output;
        final CompletableFuture<Integer> result = new CompletableFuture<>();
        final AtomicBoolean cancelled = new AtomicBoolean(false);

        RestoreSession(String id) throws IOException {
            this.id = id;
            this.input = new PipedInputStream(PIPE_BUFFER_SIZE);
            this.output = new PipedOutputStream(input);
        }
    }
}
