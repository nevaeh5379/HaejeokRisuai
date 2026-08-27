package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.SequenceInputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class BackupContainerLowMemoryTest {
    private static final long MIB = 1024L * 1024L;
    private static final long[] ASSET_SIZES = {
        128L * MIB,
        512L * MIB,
        1024L * MIB,
    };
    private static final long DATABASE_STREAM_SIZE = 8096L * MIB;

    @Test
    public void streams128512And1024MiBAssetsWithinSmallHeap() throws Exception {
        assertLowMemoryHeap();
        for (long assetSize : ASSET_SIZES) {
            verifyVirtualAssetContainer(assetSize);
        }
    }

    @Test
    public void streams8096MiBDatabasePayloadWithinSmallHeap() throws Exception {
        assertLowMemoryHeap();
        assertTrue(
            "8096 MiB intentionally exceeds the legacy uint32 entry limit",
            DATABASE_STREAM_SIZE > BackupContainerCodec.MAX_ENTRY_LENGTH
        );

        VirtualInputStream input = new VirtualInputStream(DATABASE_STREAM_SIZE);
        CountingOutputStream output = new CountingOutputStream();
        BackupContainerCodec.copyExact(
            input,
            output,
            DATABASE_STREAM_SIZE,
            new byte[256 * 1024]
        );

        assertEquals(DATABASE_STREAM_SIZE, output.bytesWritten);
        assertEquals(0L, input.remaining);
    }

    private static void assertLowMemoryHeap() {
        long maxHeap = Runtime.getRuntime().maxMemory();
        assertTrue(
            "low-memory test must run with <= 40 MiB heap, got " + maxHeap,
            maxHeap <= 40L * MIB
        );
    }

    private static void verifyVirtualAssetContainer(long assetSize) throws Exception {
        String name = "assets/large-" + (assetSize / MIB) + "mib.bin";
        byte[] header = entryHeader(name, assetSize);
        InputStream input = new SequenceInputStream(
            new ByteArrayInputStream(header),
            new VirtualInputStream(assetSize)
        );
        long totalBytes = header.length + assetSize;
        long[] restored = { 0L };

        BackupContainerCodec.ParseResult result = BackupContainerCodec.parse(
            input,
            totalBytes,
            (entryName, length, data) -> {
                assertEquals(name, entryName);
                restored[0] = drain(data);
                assertEquals(length, restored[0]);
            }
        );

        assertEquals(1, result.entryCount);
        assertEquals(totalBytes, result.bytesConsumed);
        assertEquals(assetSize, restored[0]);
    }

    private static byte[] entryHeader(String name, long length) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] encodedName = name.getBytes(StandardCharsets.UTF_8);
        writeUint32LE(output, encodedName.length);
        output.write(encodedName);
        writeUint32LE(output, length);
        return output.toByteArray();
    }

    private static void writeUint32LE(OutputStream output, long value) throws IOException {
        output.write((int) (value & 0xff));
        output.write((int) ((value >>> 8) & 0xff));
        output.write((int) ((value >>> 16) & 0xff));
        output.write((int) ((value >>> 24) & 0xff));
    }

    private static long drain(InputStream input) throws IOException {
        byte[] buffer = new byte[16 * 1024];
        long total = 0L;
        int read;
        while ((read = input.read(buffer)) != -1) {
            total += read;
        }
        return total;
    }

    private static final class VirtualInputStream extends InputStream {
        long remaining;

        VirtualInputStream(long length) {
            this.remaining = length;
        }

        @Override
        public int read() {
            if (remaining == 0L) return -1;
            remaining--;
            return 0;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) {
            if (remaining == 0L) return -1;
            int count = (int) Math.min((long) length, remaining);
            remaining -= count;
            return count;
        }
    }

    private static final class CountingOutputStream extends OutputStream {
        long bytesWritten;

        @Override
        public void write(int value) {
            bytesWritten++;
        }

        @Override
        public void write(byte[] buffer, int offset, int length) {
            bytesWritten += length;
        }
    }
}
