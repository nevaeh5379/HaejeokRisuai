package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;

public class SqliteRestoreStreamParserTest {
    @Test
    public void parsesStatementsAndPrimitiveBinds() throws Exception {
        String json = "[" +
            "{\"sql\":\"INSERT INTO t VALUES (?, ?, ?, ?)\",\"bind\":[1,2.5,true,null]}," +
            "{\"sql\":\"UPDATE t SET value = ?\",\"bind\":[\"hello\\n😀\"]}" +
            "]";
        List<String> sql = new ArrayList<>();
        List<List<Object>> binds = new ArrayList<>();
        int count = SqliteRestoreStreamParser.parse(
            new StringReader(json),
            (statement, bind) -> {
                sql.add(statement);
                binds.add(new ArrayList<>(bind));
            },
            null
        );

        assertEquals(2, count);
        assertEquals("INSERT INTO t VALUES (?, ?, ?, ?)", sql.get(0));
        assertEquals(1L, binds.get(0).get(0));
        assertEquals(2.5d, (Double) binds.get(0).get(1), 0d);
        assertEquals(1L, binds.get(0).get(2));
        assertNull(binds.get(0).get(3));
        assertTrue(((String) binds.get(1).get(0)).contains("😀"));
    }
}