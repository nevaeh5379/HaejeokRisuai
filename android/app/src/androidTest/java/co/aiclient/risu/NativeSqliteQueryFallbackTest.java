package co.aiclient.risu;

import static org.junit.Assert.assertEquals;

import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.stream.JsonReader;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.io.OutputStreamWriter;
import java.io.BufferedWriter;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Exercises real CursorWindow limits; local JVM SQLite mocks cannot do this. */
@RunWith(AndroidJUnit4.class)
public class NativeSqliteQueryFallbackTest {
    @Test
    public void pagedFallbackPreservesRowsAroundMultipleOversizedValues() throws Exception {
        try (SQLiteDatabase database = SQLiteDatabase.create(null)) {
            database.execSQL("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
            String largeValue = new String(new char[4 * 1024 * 1024]).replace('\0', 'x');
            database.beginTransaction();
            try {
                for (int id = 0; id < 1025; id++) {
                    database.execSQL("INSERT INTO probe VALUES (?, ?)", new Object[] {
                        id, id == 127 || id == 128 || id == 1024 ? largeValue : "row-" + id
                    });
                }
                database.setTransactionSuccessful();
            } finally {
                database.endTransaction();
            }

            checkRows(database, "SELECT id, value FROM probe ORDER BY id", 1025, false, (index, row) -> {
                assertEquals(index, row.get("id").getAsInt());
                assertEquals(index == 127 || index == 128 || index == 1024 ? largeValue : "row-" + index,
                    row.get("value").getAsString());
            });
        }
    }

    @Test
    public void fallbackTraversesManyPagesWithoutGrowingTheCallStack() throws Exception {
        try (SQLiteDatabase database = SQLiteDatabase.create(null)) {
            database.execSQL("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)");
            database.execSQL(
                "WITH RECURSIVE ids(id) AS (SELECT 0 UNION ALL SELECT id + 1 FROM ids WHERE id < 65536) " +
                "INSERT INTO probe SELECT id, 'row-' || id FROM ids"
            );
            checkRows(database, "SELECT id, value FROM probe ORDER BY id", 65537, true,
                (index, row) -> assertEquals(index, row.get("id").getAsInt()));
        }
    }

    @Test
    public void streamsOversizedBlobsAndUnicodeWithoutTruncation() throws Exception {
        try (SQLiteDatabase database = SQLiteDatabase.create(null)) {
            database.execSQL("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT, data BLOB)");
            String text = new String(new char[700000]).replace("\0", "한😀\\\"\n");
            byte[] bytes = new byte[3 * 1024 * 1024];
            for (int index = 0; index < bytes.length; index++) bytes[index] = (byte) index;
            database.execSQL("INSERT INTO probe VALUES (?, ?, ?)", new Object[] {0, text, bytes});
            checkQuery(database, "SELECT id, value, data FROM probe ORDER BY id", 1, false, source -> {
                try (JsonReader reader = new JsonReader(source)) {
                    reader.beginObject();
                    assertEquals("type", reader.nextName());
                    assertEquals("row", reader.nextString());
                    assertEquals("queryIndex", reader.nextName());
                    assertEquals(0, reader.nextInt());
                    assertEquals("row", reader.nextName());
                    reader.beginObject();
                    assertEquals("id", reader.nextName());
                    assertEquals(0, reader.nextInt());
                    assertEquals("value", reader.nextName());
                    assertEquals(text, reader.nextString());
                    assertEquals("data", reader.nextName());
                    reader.beginArray();
                    int offset = 0;
                    while (reader.hasNext()) {
                        assertEquals(bytes[offset++] & 255, reader.nextInt());
                    }
                    assertEquals(bytes.length, offset);
                    reader.endArray();
                    reader.endObject();
                    reader.endObject();
                }
            });
        }
    }

    private interface RowCheck { void check(int index, JsonObject row); }
    private interface StreamCheck { void check(BufferedReader reader) throws java.io.IOException; }

    private void checkRows(SQLiteDatabase database, String sql, long count, boolean forceFallback, RowCheck check)
        throws Exception {
        checkQuery(database, sql, count, forceFallback, reader -> {
            String line;
            int index = 0;
            while ((line = reader.readLine()) != null) {
                JsonObject record = JsonParser.parseString(line).getAsJsonObject();
                check.check(index++, record.getAsJsonObject("row"));
            }
            assertEquals(count, index);
        });
    }

    private void checkQuery(SQLiteDatabase database, String sql, long count, boolean forceFallback, StreamCheck check)
        throws Exception {
        NativeSqlitePlugin plugin = new NativeSqlitePlugin();
        Field dbField = NativeSqlitePlugin.class.getDeclaredField("db");
        dbField.setAccessible(true);
        dbField.set(plugin, database);
        Method query = NativeSqlitePlugin.class.getDeclaredMethod(
            "writeQuery", SqliteQueryJsonWriter.class, int.class, String.class, List.class);
        Method fallback = NativeSqlitePlugin.class.getDeclaredMethod(
            "writeQueryRange", SqliteQueryJsonWriter.class, int.class, String.class, List.class,
            String[].class, long.class, long.class, long[].class);
        query.setAccessible(true);
        fallback.setAccessible(true);
        // Consume on another thread while SQLite stays on this thread. The test
        // must not collect a native JSArray or the complete serialized response.
        PipedInputStream input = new PipedInputStream(512 * 1024);
        PipedOutputStream output = new PipedOutputStream(input);
        ExecutorService consumer = Executors.newSingleThreadExecutor();
        Future<?> received = consumer.submit(() -> {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
                check.check(reader);
            } catch (java.io.IOException error) { throw new RuntimeException(error); }
        });
        try (BufferedWriter sink = new BufferedWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8))) {
            SqliteQueryJsonWriter writer = new SqliteQueryJsonWriter(sink);
            if (forceFallback) {
                fallback.invoke(plugin, writer, 0, sql, new ArrayList<>(), new String[] { "id", "value" },
                    0L, count, new long[] { 0 });
            } else query.invoke(plugin, writer, 0, sql, new ArrayList<>());
        } finally {
            try { received.get(60, TimeUnit.SECONDS); }
            finally { input.close(); consumer.shutdownNow(); }
        }
    }
}
