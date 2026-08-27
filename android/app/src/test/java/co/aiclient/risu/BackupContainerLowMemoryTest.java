package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.CRC32;
import org.junit.Test;

public class BackupContainerLowMemoryTest {
    private static final long LARGE_ENTRY_SIZE = 128L * 1024L * 1024L;

    @Test
    public void streamsLargeBackupWithinSmallHeap() throws Exception {
        long maxHeap = Runtime.getRuntime().maxMemory();
        assertTrue("low-memory test must run with <= 40 MiB heap, got " + maxHeap,
            maxHeap <= 40L * 1024L * 1024L);

        Path backup = Files.createTempFile("risu-backup-low-memory-", ".bin");
        try {
            long expectedLargeCrc = writeLargeBackup(backup);
            assertTrue(Files.size(backup) > LARGE_ENTRY_SIZE);
            verifyLargeBackup(backup, expectedLargeCrc);
        } finally {
            Files.deleteIfExists(backup);
        }
    }

    private static long writeLargeBackup(Path backup) throws IOException {
        PatternInputStream largeInput = new PatternInputStream(LARGE_ENTRY_SIZE, 0x41);
        try (OutputStream output = new BufferedOutputStream(Files.newOutputStream(backup))) {
            BackupContainerCodec.writeEntry(
                output,
                largeInput,
                LARGE_ENTRY_SIZE,
                "large-asset.bin"
            );
            BackupContainerCodec.writeEntry(
                output,
                new PatternInputStream(64 * 1024L, 0x23),
                64 * 1024L,
                "database.risudat"
            );
        }
        return largeInput.crcValue();
    }

    private static void verifyLargeBackup(Path backup, long expectedLargeCrc) throws IOException {
        long[] largeBytes = { 0L };
        long[] databaseBytes = { 0L };
        long[] largeCrc = { -1L };
        try (InputStream input = new BufferedInputStream(Files.newInputStream(backup))) {
            BackupContainerCodec.ParseResult result = BackupContainerCodec.parse(
                input,
                Files.size(backup),
                (name, length, data) -> {
                    CRC32 crc = new CRC32();
                    long read = drain(data, crc);
                    assertEquals(length, read);
                    if ("large-asset.bin".equals(name)) {
                        largeBytes[0] = read;
                        largeCrc[0] = crc.getValue();
                    } else if ("database.risudat".equals(name)) {
                        databaseBytes[0] = read;
                    }
                }
            );
            assertEquals(2, result.entryCount);
        }

        assertEquals(LARGE_ENTRY_SIZE, largeBytes[0]);
        assertEquals(64 * 1024L, databaseBytes[0]);
        assertEquals(expectedLargeCrc, largeCrc[0]);
    }

    private static long drain(InputStream input, CRC32 crc) throws IOException {
        byte[] buffer = new byte[16 * 1024];
        long total = 0L;
        int read;
        while ((read = input.read(buffer)) != -1) {
            crc.update(buffer, 0, read);
            total += read;
        }
        return total;
    }

    private static final class PatternInputStream extends InputStream {
        private long remaining;
        private long position;
        private final int seed;
        private final CRC32 crc = new CRC32();

        PatternInputStream(long length, int seed) {
            this.remaining = length;
            this.seed = seed;
        }

        long crcValue() {
            return crc.getValue();
        }

        @Override
        public int read() {
            if (remaining == 0L) return -1;
            int value = pattern(position++);
            remaining--;
            crc.update(value);
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) {
            if (remaining == 0L) return -1;
            int count = (int) Math.min((long) length, remaining);
            for (int index = 0; index < count; index++) {
                buffer[offset + index] = (byte) pattern(position + index);
            }
            crc.update(buffer, offset, count);
            position += count;
            remaining -= count;
            return count;
        }

        private int pattern(long index) {
            return (int) ((seed + index * 31L + (index >>> 7)) & 0xffL);
        }
    }
}
