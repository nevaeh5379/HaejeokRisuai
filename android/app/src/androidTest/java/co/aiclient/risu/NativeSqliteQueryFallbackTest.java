package co.aiclient.risu;

import static org.junit.Assert.assertEquals;

import android.database.sqlite.SQLiteDatabase;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSArray;
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

            JSArray rows = readFallback(database, 1025);
            assertEquals(1025, rows.length());
            for (int index = 0; index < rows.length(); index++) {
                assertEquals(index, rows.getJSONObject(index).getInt("id"));
                assertEquals(
                    index == 127 || index == 128 || index == 1024 ? largeValue : "row-" + index,
                    rows.getJSONObject(index).getString("value")
                );
            }
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
            JSArray rows = readFallback(database, 65537);
            assertEquals(65537, rows.length());
            for (int index = 0; index < rows.length(); index++) {
                assertEquals(index, rows.getJSONObject(index).getInt("id"));
            }
        }
    }

    private JSArray readFallback(SQLiteDatabase database, long count) throws Exception {
        NativeSqlitePlugin plugin = new NativeSqlitePlugin();
        Field dbField = NativeSqlitePlugin.class.getDeclaredField("db");
        dbField.setAccessible(true);
        dbField.set(plugin, database);
        Method append = NativeSqlitePlugin.class.getDeclaredMethod(
            "appendQueryRange", JSArray.class, String.class, List.class, String[].class,
            long.class, long.class
        );
        append.setAccessible(true);
        JSArray rows = new JSArray();
        append.invoke(plugin, rows, "SELECT id, value FROM probe ORDER BY id",
            new ArrayList<>(), new String[] { "id", "value" }, 0L, count);
        return rows;
    }
}
