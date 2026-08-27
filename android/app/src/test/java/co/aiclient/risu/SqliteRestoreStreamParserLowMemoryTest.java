package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public class SqliteRestoreStreamParserLowMemoryTest {
    private static final int STATEMENT_COUNT = 2048;
    private static final int TEXT_SIZE = 64 * 1024;

    @Test
    public void parsesHundredMegabyteRestoreStreamWithSmallHeap() throws Exception {
        long maxHeap = Runtime.getRuntime().maxMemory();
        assertTrue("low-memory test must run with <= 40 MiB heap, got " + maxHeap,
            maxHeap <= 40L * 1024L * 1024L);

        Path stream = Files.createTempFile("risu-sql-restore-", ".json");
        String payload = repeat('x', TEXT_SIZE);
        try {
            try (BufferedWriter writer = Files.newBufferedWriter(stream, StandardCharsets.UTF_8)) {
                writer.write('[');
                for (int index = 0; index < STATEMENT_COUNT; index++) {
                    if (index > 0) writer.write(',');
                    writer.write("{\"sql\":\"INSERT INTO t VALUES (?)\",\"bind\":[\"");
                    writer.write(payload);
                    writer.write("\"]}");
                }
                writer.write(']');
            }
            assertTrue(Files.size(stream) > 128L * 1024L * 1024L);
            int[] seen = { 0 };
            try (BufferedReader reader = Files.newBufferedReader(stream, StandardCharsets.UTF_8)) {
                int parsed = SqliteRestoreStreamParser.parse(
                    reader,
                    (sql, bind) -> {
                        assertEquals("INSERT INTO t VALUES (?)", sql);
                        assertEquals(1, bind.size());
                        assertEquals(TEXT_SIZE, ((String) bind.get(0)).length());
                        seen[0]++;
                    },
                    null
                );
                assertEquals(STATEMENT_COUNT, parsed);
            }
            assertEquals(STATEMENT_COUNT, seen[0]);
        } finally {
            Files.deleteIfExists(stream);
        }
    }

    private static String repeat(char value, int count) {
        char[] chars = new char[count];
        java.util.Arrays.fill(chars, value);
        return new String(chars);
    }
}
