package co.aiclient.risu;

import java.io.BufferedInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/** Pure-Java reader/writer for the framed local-backup container format. */
final class BackupContainerCodec {
    static final int MAX_NAME_LENGTH = 1024 * 1024;
    static final long MAX_ENTRY_LENGTH = 0xffffffffL;
    private static final int COPY_BUFFER_SIZE = 256 * 1024;

    interface EntryHandler {
        void handle(String name, long dataLength, InputStream data) throws IOException;
    }

    static final class ParseResult {
        final int entryCount;
        final long bytesConsumed;

        ParseResult(int entryCount, long bytesConsumed) {
            this.entryCount = entryCount;
            this.bytesConsumed = bytesConsumed;
        }
    }

    private BackupContainerCodec() {}

    static boolean looksLikeContainer(InputStream source, long totalBytes) throws IOException {
        try (BufferedInputStream input = new BufferedInputStream(source)) {
            Long nameLength = readUint32LEOrEof(input);
            if (nameLength == null || nameLength <= 0 || nameLength > MAX_NAME_LENGTH) {
                return false;
            }
            byte[] nameBytes = readExact(input, nameLength.intValue());
            String name = new String(nameBytes, StandardCharsets.UTF_8);
            if (name.indexOf('\u0000') >= 0 || name.trim().isEmpty()) return false;
            long dataLength = requireUint32LE(input, "backup entry data length");
            long headerLength = 8L + nameLength;
            return totalBytes < 0L || (
                headerLength <= totalBytes && dataLength <= totalBytes - headerLength
            );
        }
    }

    static ParseResult parse(
        InputStream source,
        long totalBytes,
        EntryHandler handler
    ) throws IOException {
        BufferedInputStream input = new BufferedInputStream(source);
        long logicalBytesRead = 0L;
        int entryCount = 0;

        while (true) {
            Long nameLength = readUint32LEOrEof(input);
            if (nameLength == null) break;
            logicalBytesRead += 4L;
            if (nameLength <= 0 || nameLength > MAX_NAME_LENGTH) {
                throw new IOException("Invalid backup entry name length");
            }

            byte[] nameBytes = readExact(input, nameLength.intValue());
            logicalBytesRead += nameLength;
            String name = new String(nameBytes, StandardCharsets.UTF_8);
            if (name.indexOf('\u0000') >= 0 || name.trim().isEmpty()) {
                throw new IOException("Invalid backup entry name");
            }

            long dataLength = requireUint32LE(input, "backup entry data length");
            logicalBytesRead += 4L;
            if (
                totalBytes >= 0L &&
                (logicalBytesRead > totalBytes || dataLength > totalBytes - logicalBytesRead)
            ) {
                throw new IOException("Backup entry exceeds the remaining file size");
            }

            ExactLengthInputStream entry = new ExactLengthInputStream(input, dataLength);
            handler.handle(name, dataLength, entry);
            if (entry.remaining() != 0L) {
                if (entry.sourceEnded()) {
                    throw new IOException("Backup file ended unexpectedly");
                }
                throw new IOException("Backup entry was not fully consumed: " + name);
            }

            logicalBytesRead += dataLength;
            entryCount++;
        }

        return new ParseResult(entryCount, logicalBytesRead);
    }

    static void writeEntry(
        OutputStream output,
        InputStream input,
        long dataLength,
        String name,
        byte[] copyBuffer
    ) throws IOException {
        if (dataLength < 0L || dataLength > MAX_ENTRY_LENGTH) {
            throw new IOException("Backup entry is too large: " + name);
        }
        byte[] encodedName = name.getBytes(StandardCharsets.UTF_8);
        if (encodedName.length == 0 || encodedName.length > MAX_NAME_LENGTH) {
            throw new IOException("Invalid backup entry name length: " + name);
        }
        writeUint32LE(output, encodedName.length);
        output.write(encodedName);
        writeUint32LE(output, dataLength);
        copyExact(input, output, dataLength, copyBuffer);
    }

    static void writeEntry(
        OutputStream output,
        InputStream input,
        long dataLength,
        String name
    ) throws IOException {
        writeEntry(output, input, dataLength, name, new byte[COPY_BUFFER_SIZE]);
    }

    private static byte[] readExact(InputStream input, int length) throws IOException {
        byte[] data = new byte[length];
        int offset = 0;
        while (offset < length) {
            int read = input.read(data, offset, length - offset);
            if (read < 0) throw new IOException("Backup file ended unexpectedly");
            offset += read;
        }
        return data;
    }

    private static Long readUint32LEOrEof(InputStream input) throws IOException {
        int b0 = input.read();
        if (b0 < 0) return null;
        int b1 = input.read();
        int b2 = input.read();
        int b3 = input.read();
        if ((b1 | b2 | b3) < 0) throw new IOException("Backup file ended unexpectedly");
        return ((long) b0)
            | ((long) b1 << 8)
            | ((long) b2 << 16)
            | ((long) b3 << 24);
    }

    private static long requireUint32LE(InputStream input, String field) throws IOException {
        Long value = readUint32LEOrEof(input);
        if (value == null) throw new IOException("Missing " + field);
        return value;
    }

    private static void writeUint32LE(OutputStream output, long value) throws IOException {
        output.write((int) (value & 0xff));
        output.write((int) ((value >>> 8) & 0xff));
        output.write((int) ((value >>> 16) & 0xff));
        output.write((int) ((value >>> 24) & 0xff));
    }

    private static void copyExact(
        InputStream input,
        OutputStream output,
        long length,
        byte[] buffer
    ) throws IOException {
        long remaining = length;
        while (remaining > 0L) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read < 0) throw new IOException("Backup file ended unexpectedly");
            output.write(buffer, 0, read);
            remaining -= read;
        }
    }

    private static final class ExactLengthInputStream extends FilterInputStream {
        private long remaining;
        private boolean sourceEnded;

        ExactLengthInputStream(InputStream input, long length) {
            super(input);
            this.remaining = length;
        }

        long remaining() {
            return remaining;
        }

        boolean sourceEnded() {
            return sourceEnded;
        }

        @Override
        public int read() throws IOException {
            if (remaining == 0L) return -1;
            int value = super.read();
            if (value < 0) {
                sourceEnded = true;
                return -1;
            }
            remaining--;
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            if (remaining == 0L) return -1;
            int requested = (int) Math.min((long) length, remaining);
            int read = super.read(buffer, offset, requested);
            if (read < 0) {
                sourceEnded = true;
                return -1;
            }
            remaining -= read;
            return read;
        }

        @Override
        public void close() {
            // The parent parser owns the underlying stream.
        }
    }
}
