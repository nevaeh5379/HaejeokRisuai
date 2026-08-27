package co.aiclient.risu;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;
import org.junit.Test;

public class BackupContainerCodecTest {
    @Test
    public void writerAndParserRoundTripPreservesEntries() throws Exception {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("avatar.png", patternedBytes(17, 1));
        entries.put("coldstorage_12345678-1234-1234-1234-123456789abc.json", patternedBytes(4097, 2));
        entries.put("database.risudat", patternedBytes(65537, 3));

        byte[] backup = encode(entries);
        Map<String, byte[]> restored = decode(backup, backup.length);

        assertEquals(entries.keySet(), restored.keySet());
        for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
            assertArrayEquals(entry.getValue(), restored.get(entry.getKey()));
        }
    }

    @Test
    public void parsesValidContainerWhenBufferedInputReadsAhead() throws Exception {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("tiny-asset.bin", patternedBytes(31, 4));
        entries.put("buffer-filler.bin", patternedBytes(9001, 5));
        entries.put("database.risudat", patternedBytes(32769, 6));

        byte[] backup = encode(entries);
        CountingInputStream source = new CountingInputStream(new ByteArrayInputStream(backup));
        long databaseDataStart = backup.length - entries.get("database.risudat").length;
        boolean[] observedReadAhead = { false };
        BackupContainerCodec.ParseResult result = BackupContainerCodec.parse(
            source,
            backup.length,
            (name, length, data) -> {
                if ("database.risudat".equals(name)) {
                    observedReadAhead[0] = source.bytesRead > databaseDataStart;
                }
                drain(data);
            }
        );

        assertTrue("test fixture must trigger buffered read-ahead", observedReadAhead[0]);
        assertEquals(3, result.entryCount);
        assertEquals(backup.length, result.bytesConsumed);
    }

    @Test
    public void parsesPayloadsAcrossCommonBufferBoundaries() throws Exception {
        int[] sizes = { 0, 1, 7, 4095, 4096, 4097, 8191, 8192, 8193, 65535 };
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        for (int index = 0; index < sizes.length; index++) {
            entries.put("entry-" + sizes[index] + ".bin", patternedBytes(sizes[index], index + 10));
        }
        entries.put("database.risudat", patternedBytes(16385, 99));

        byte[] backup = encode(entries);
        Map<String, byte[]> restored = decode(backup, backup.length);

        assertEquals(entries.size(), restored.size());
        for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
            assertArrayEquals(entry.getValue(), restored.get(entry.getKey()));
        }
    }

    @Test
    public void rejectsTruncatedEntryUsingKnownContentLength() throws Exception {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("database.risudat", patternedBytes(9000, 20));
        byte[] valid = encode(entries);
        byte[] truncated = Arrays.copyOf(valid, valid.length - 1);

        IOException error = expectIOException(() -> decode(truncated, truncated.length));
        assertTrue(error.getMessage().contains("exceeds the remaining file size"));
    }

    @Test
    public void rejectsTruncatedEntryWhenContentLengthIsUnknown() throws Exception {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("database.risudat", patternedBytes(9000, 21));
        byte[] valid = encode(entries);
        byte[] truncated = Arrays.copyOf(valid, valid.length - 1);

        IOException error = expectIOException(() -> decode(truncated, -1L));
        assertTrue(error.getMessage().contains("ended unexpectedly"));
    }

    @Test
    public void detectsContainerWhenContentLengthIsUnknown() throws Exception {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("database.risudat", patternedBytes(1234, 22));
        byte[] backup = encode(entries);

        assertTrue(BackupContainerCodec.looksLikeContainer(new ByteArrayInputStream(backup), -1L));
    }

    @Test
    public void rejectsObviouslyRawDataAsContainer() throws Exception {
        byte[] raw = patternedBytes(128, 23);
        raw[0] = (byte) 0xff;
        raw[1] = (byte) 0xff;
        raw[2] = (byte) 0xff;
        raw[3] = (byte) 0x7f;

        assertFalse(BackupContainerCodec.looksLikeContainer(new ByteArrayInputStream(raw), raw.length));
    }

    @Test
    public void entryStreamCannotConsumeFollowingEntry() throws Exception {
        LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
        entries.put("first.bin", patternedBytes(5, 24));
        entries.put("database.risudat", patternedBytes(7, 25));
        byte[] backup = encode(entries);
        LinkedHashMap<String, byte[]> restored = new LinkedHashMap<>();

        BackupContainerCodec.parse(
            new ByteArrayInputStream(backup),
            backup.length,
            (name, length, data) -> restored.put(name, drain(data))
        );

        assertArrayEquals(entries.get("first.bin"), restored.get("first.bin"));
        assertArrayEquals(entries.get("database.risudat"), restored.get("database.risudat"));
    }

    @Test
    public void fixedSeedRandomizedRoundTrips() throws Exception {
        Random random = new Random(0x52495355L);
        for (int iteration = 0; iteration < 200; iteration++) {
            LinkedHashMap<String, byte[]> entries = new LinkedHashMap<>();
            int count = 1 + random.nextInt(12);
            for (int index = 0; index < count; index++) {
                int length = random.nextInt(16 * 1024 + 1);
                byte[] data = new byte[length];
                random.nextBytes(data);
                entries.put("asset-" + iteration + "-" + index + ".bin", data);
            }
            byte[] database = new byte[random.nextInt(32 * 1024 + 1)];
            random.nextBytes(database);
            entries.put("database.risudat", database);

            byte[] backup = encode(entries);
            Map<String, byte[]> restored = decode(backup, backup.length);
            assertEquals("iteration " + iteration, entries.keySet(), restored.keySet());
            for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
                assertArrayEquals(
                    "iteration " + iteration + ", entry " + entry.getKey(),
                    entry.getValue(),
                    restored.get(entry.getKey())
                );
            }
        }
    }

    private static byte[] encode(Map<String, byte[]> entries) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        for (Map.Entry<String, byte[]> entry : entries.entrySet()) {
            byte[] data = entry.getValue();
            BackupContainerCodec.writeEntry(
                output,
                new ByteArrayInputStream(data),
                data.length,
                entry.getKey()
            );
        }
        return output.toByteArray();
    }

    private static Map<String, byte[]> decode(byte[] backup, long totalBytes) throws IOException {
        LinkedHashMap<String, byte[]> restored = new LinkedHashMap<>();
        BackupContainerCodec.parse(
            new ByteArrayInputStream(backup),
            totalBytes,
            (name, length, data) -> restored.put(name, drain(data))
        );
        return restored;
    }

    private static byte[] drain(InputStream input) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[1024];
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
        return output.toByteArray();
    }

    private static byte[] patternedBytes(int length, int seed) {
        byte[] data = new byte[length];
        for (int index = 0; index < data.length; index++) {
            data[index] = (byte) (seed * 31 + index * 17);
        }
        return data;
    }

    private static IOException expectIOException(ThrowingRunnable runnable) throws Exception {
        try {
            runnable.run();
            fail("Expected IOException");
            return null;
        } catch (IOException error) {
            return error;
        }
    }

    private static final class CountingInputStream extends FilterInputStream {
        long bytesRead;

        CountingInputStream(InputStream input) {
            super(input);
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value >= 0) bytesRead++;
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int read = super.read(buffer, offset, length);
            if (read > 0) bytesRead += read;
            return read;
        }
    }

    private interface ThrowingRunnable {
        void run() throws Exception;
    }
}
