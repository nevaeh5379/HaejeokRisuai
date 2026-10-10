package co.aiclient.risu;

import static org.junit.Assert.*;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.StringWriter;
import java.util.concurrent.*;
import org.junit.Test;

public class SqliteQueryStreamTest {
    @Test
    public void escapesStringAndBlobChunksWithoutChangingValues() throws Exception {
        StringWriter output = new StringWriter();
        SqliteQueryJsonWriter writer = new SqliteQueryJsonWriter(output);
        writer.beginRow(0);
        writer.column("key\n");
        writer.beginString();
        writer.stringChunk("한글\n\"\\\0\ud83d");
        writer.stringChunk("\ude00\ud800");
        writer.endString();
        writer.column("blob");
        writer.beginBlob();
        writer.blobChunk(new byte[] {0, (byte) 128});
        writer.blobChunk(new byte[] {(byte) 255});
        writer.endBlob();
        writer.column("empty");
        writer.scalar(null);
        writer.endRow();
        writer.endQuery(0);
        String[] records = output.toString().split("\n");
        JsonObject row = JsonParser.parseString(records[0]).getAsJsonObject().getAsJsonObject("row");
        assertEquals("한글\n\"\\\0😀\ud800", row.get("key\n").getAsString());
        assertEquals("[0,128,255]", row.get("blob").toString());
        assertTrue(row.get("empty").isJsonNull());
        assertEquals("end", JsonParser.parseString(records[1]).getAsJsonObject().get("type").getAsString());
    }

    @Test
    public void producerFailureCannotBecomeSuccessfulEof() throws Exception {
        SqliteQueryStream stream = new SqliteQueryStream();
        BufferedWriter writer = stream.writer();
        writer.write("partial\n");
        writer.flush();
        stream.finish(new IOException("SQL failure"));
        assertNotNull(stream.read());
        IOException error = assertThrows(IOException.class, stream::read);
        assertEquals("SQL failure", error.getCause().getMessage());
        stream.cancel();
    }

    @Test
    public void cancellationUnblocksAProducerWaitingForTheConsumer() throws Exception {
        SqliteQueryStream stream = new SqliteQueryStream();
        ExecutorService executor = Executors.newSingleThreadExecutor();
        CountDownLatch started = new CountDownLatch(1);
        try {
            Future<?> producer = executor.submit(() -> {
                try {
                    BufferedWriter writer = stream.writer();
                    started.countDown();
                    char[] chunk = new char[16 * 1024];
                    for (int index = 0; index < 100; index++) writer.write(chunk);
                    fail("pipe must block or fail when its consumer closes");
                } catch (IOException expected) {
                    stream.finish(expected);
                }
            });
            assertTrue(started.await(5, TimeUnit.SECONDS));
            stream.cancel();
            producer.get(5, TimeUnit.SECONDS);
        } finally {
            stream.cancel();
            executor.shutdownNow();
        }
    }

    @Test
    public void timeoutOnlyStartsWhenTheDatabaseProducerStarts() throws Exception {
        SqliteQueryStream stream = new SqliteQueryStream();
        assertFalse(stream.expire(System.nanoTime() + TimeUnit.SECONDS.toNanos(61)));
        stream.writer();
        assertTrue(stream.expire(System.nanoTime() + TimeUnit.SECONDS.toNanos(61)));
        assertThrows(IOException.class, stream::read);
    }
}
