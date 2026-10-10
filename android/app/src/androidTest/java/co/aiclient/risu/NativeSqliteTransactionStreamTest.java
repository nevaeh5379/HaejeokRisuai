package co.aiclient.risu;

import static org.junit.Assert.*;

import android.database.DatabaseUtils;
import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.google.gson.stream.JsonWriter;
import java.io.OutputStreamWriter;
import java.io.PipedOutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Verifies Android's thread-local transaction ownership across stream EOF. */
@RunWith(AndroidJUnit4.class)
public class NativeSqliteTransactionStreamTest {
    @Test
    public void finishingAttachedStreamLeavesCommitAndRollbackToCaller() throws Exception {
        try (SQLiteDatabase db = SQLiteDatabase.create(null)) {
            db.execSQL("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
            NativeSqlitePlugin plugin = plugin(db);
            String large = new String(new char[174762]).replace("\0", "한\n\"");
            db.beginTransaction();
            try {
                db.execSQL("INSERT INTO probe VALUES (1, 'before')");
                assertEquals(1, runStream(plugin, large, false).get().intValue());
                assertTrue(db.inTransaction());
                assertEquals("tx-probe", field(NativeSqlitePlugin.class, "activeTransactionId").get(plugin));
                assertEquals(large, DatabaseUtils.stringForQuery(db, "SELECT value FROM probe WHERE id = 2", null));
                db.execSQL("INSERT INTO probe VALUES (3, 'after')");
                // No success marker: the caller rolls back the complete save.
            } finally {
                if (db.inTransaction()) db.endTransaction();
            }
            assertEquals(0, DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM probe", null));

            db.beginTransaction();
            try {
                assertEquals(1, runStream(plugin, large, false).get().intValue());
                assertTrue(db.inTransaction());
                db.setTransactionSuccessful();
            } finally {
                if (db.inTransaction()) db.endTransaction();
            }
            assertEquals(1, DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM probe", null));
        }
    }

    @Test
    public void failedAttachedStreamRollsBackEarlierWritesAndReleasesTransaction() throws Exception {
        try (SQLiteDatabase db = SQLiteDatabase.create(null)) {
            db.execSQL("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
            NativeSqlitePlugin plugin = plugin(db);
            db.beginTransaction();
            try {
                db.execSQL("INSERT INTO probe VALUES (1, 'before')");
                CompletableFuture<Integer> result = runStream(plugin, "streamed", true);
                assertTrue(result.isCompletedExceptionally());
                assertFalse(db.inTransaction());
                assertNull(field(NativeSqlitePlugin.class, "activeTransactionId").get(plugin));
                assertEquals(0, DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM probe", null));
                db.beginTransaction();
                db.execSQL("INSERT INTO probe VALUES (3, 'next')");
                db.setTransactionSuccessful();
            } finally {
                if (db.inTransaction()) db.endTransaction();
            }
            assertEquals(1, DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM probe", null));
        }
    }

    private static NativeSqlitePlugin plugin(SQLiteDatabase db) throws Exception {
        NativeSqlitePlugin plugin = new NativeSqlitePlugin();
        field(NativeSqlitePlugin.class, "db").set(plugin, db);
        field(NativeSqlitePlugin.class, "activeTransactionId").set(plugin, "tx-probe");
        return plugin;
    }

    private static CompletableFuture<Integer> runStream(NativeSqlitePlugin plugin, String value, boolean fail)
        throws Exception {
        Class<?> sessionType = Class.forName("co.aiclient.risu.NativeSqlitePlugin$RestoreSession");
        Constructor<?> constructor = sessionType.getDeclaredConstructor(String.class);
        constructor.setAccessible(true);
        Object session = constructor.newInstance("stream-probe");
        PipedOutputStream output = (PipedOutputStream) field(sessionType, "output").get(session);
        ExecutorService producer = Executors.newSingleThreadExecutor();
        Future<?> sent = producer.submit(() -> {
            try (JsonWriter writer = new JsonWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8))) {
                writer.beginArray();
                writer.beginObject().name("sql").value("INSERT INTO probe VALUES (?, ?)").name("bind")
                    .beginArray().value(2).value(value).endArray().endObject();
                if (fail) writer.beginObject().name("sql").value("INSERT INTO missing_table VALUES (?)")
                    .name("bind").beginArray().value(3).endArray().endObject();
                writer.endArray();
            } catch (Exception error) { throw new RuntimeException(error); }
        });
        try {
            Method run = NativeSqlitePlugin.class.getDeclaredMethod("runTransactionStream", sessionType, String.class);
            run.setAccessible(true);
            run.invoke(plugin, session, "tx-probe");
            sent.get(10, TimeUnit.SECONDS);
            @SuppressWarnings("unchecked")
            CompletableFuture<Integer> result = (CompletableFuture<Integer>) field(sessionType, "result").get(session);
            return result;
        } finally {
            output.close();
            producer.shutdownNow();
        }
    }

    private static Field field(Class<?> type, String name) throws Exception {
        Field field = type.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }
}
