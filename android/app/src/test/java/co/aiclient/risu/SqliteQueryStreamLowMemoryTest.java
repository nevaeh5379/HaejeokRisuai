package co.aiclient.risu;

import static org.junit.Assert.*;

import java.io.BufferedWriter;
import java.util.Arrays;
import java.util.concurrent.*;
import org.junit.Test;

public class SqliteQueryStreamLowMemoryTest {
    @Test
    public void transfers140477RowsAndAnOversizedCellThroughBoundedChunks() throws Exception {
        assertTrue("run in the low-memory task", Runtime.getRuntime().maxMemory() <= 40L * 1024 * 1024);
        SqliteQueryStream stream = new SqliteQueryStream();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        try {
            Future<?> producer = executor.submit(() -> {
                Exception failure = null;
                try {
                    BufferedWriter output = stream.writer();
                    SqliteQueryJsonWriter writer = new SqliteQueryJsonWriter(output);
                    char[] chars = new char[1024];
                    Arrays.fill(chars, 'x');
                    String text = new String(chars);
                    for (int index = 0; index < 140477; index++) {
                        writer.beginRow(0);
                        writer.column("id");
                        writer.scalar(index);
                        writer.column("text");
                        writer.string(text);
                        if (index == 0) {
                            // A 64 MiB cell also has to stream without reassembly.
                            writer.column("largeText");
                            writer.beginString();
                            for (int part = 0; part < 65536; part++) writer.stringChunk(text);
                            writer.endString();
                        }
                        writer.endRow();
                    }
                    writer.endQuery(0);
                } catch (Exception error) {
                    failure = error;
                } finally {
                    stream.finish(failure);
                }
            });
            long bytes = 0;
            int lines = 0;
            byte[] chunk;
            while ((chunk = stream.read()) != null) {
                assertTrue(chunk.length <= 192 * 1024);
                bytes += chunk.length;
                for (byte value : chunk) if (value == '\n') lines++;
            }
            producer.get(10, TimeUnit.SECONDS);
            assertEquals(140478, lines);
            assertTrue(bytes > 192L * 1024 * 1024);
        } finally {
            stream.cancel();
            executor.shutdownNow();
        }
    }
}
