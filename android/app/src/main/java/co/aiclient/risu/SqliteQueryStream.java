package co.aiclient.risu;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;

/** Bounded, pull-driven transport shared by the plugin and low-heap tests. */
final class SqliteQueryStream {
    static final int CHUNK_BYTES = 192 * 1024;
    private static final long IDLE_NANOS = TimeUnit.SECONDS.toNanos(60);
    private final PipedInputStream input = new PipedInputStream(512 * 1024);
    private final PipedOutputStream output;
    private final Object readLock = new Object();
    private volatile boolean cancelled;
    private volatile long lastRead;
    private volatile boolean started;
    private volatile Throwable failure;

    SqliteQueryStream() throws IOException { output = new PipedOutputStream(input); }

    BufferedWriter writer() throws IOException {
        checkCancelled();
        lastRead = System.nanoTime();
        started = true;
        return new BufferedWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8), 16 * 1024);
    }

    byte[] read() throws IOException {
        lastRead = System.nanoTime();
        synchronized (readLock) {
            checkCancelled();
            byte[] buffer = new byte[CHUNK_BYTES];
            int count = input.read(buffer);
            checkCancelled();
            if (count < 0) {
                if (failure != null) throw new IOException("Native SQLite query failed", failure);
                return null;
            }
            return count == buffer.length ? buffer : Arrays.copyOf(buffer, count);
        }
    }

    void finish(Throwable error) {
        failure = error;
        try { output.close(); } catch (IOException ignored) {}
    }

    void cancel() {
        cancelled = true;
        finish(failure);
        try { input.close(); } catch (IOException ignored) {}
    }

    boolean expire(long now) {
        if (!started || now - lastRead < IDLE_NANOS) return false;
        cancel();
        return true;
    }

    void checkCancelled() throws IOException {
        if (cancelled) throw new IOException("SQLite query stream was closed or timed out");
    }
}
