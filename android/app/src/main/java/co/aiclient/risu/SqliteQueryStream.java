package co.aiclient.risu;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** Bounded, pull-driven transport shared by the plugin and low-heap tests. */
final class SqliteQueryStream {
    static final int CHUNK_BYTES = 192 * 1024;
    private static final long IDLE_NANOS = TimeUnit.SECONDS.toNanos(60);
    private final PipedInputStream input = new PipedInputStream(512 * 1024);
    private final PipedOutputStream output;
    private final Object readLock = new Object();
    private final Object activityLock = new Object();
    private final LongSupplier nanoTime;
    private volatile boolean cancelled;
    private long lastRead;
    private boolean started;
    private int pendingReads;
    private volatile Throwable failure;

    SqliteQueryStream() throws IOException { this(System::nanoTime); }

    SqliteQueryStream(LongSupplier nanoTime) throws IOException {
        this.nanoTime = nanoTime;
        output = new PipedOutputStream(input);
    }

    BufferedWriter writer() throws IOException {
        synchronized (activityLock) {
            checkCancelled();
            lastRead = nanoTime.getAsLong();
            started = true;
        }
        return new BufferedWriter(new OutputStreamWriter(output, StandardCharsets.UTF_8), 16 * 1024);
    }

    byte[] read() throws IOException {
        synchronized (activityLock) {
            checkCancelled();
            // Count requests waiting for readLock too, not just the pipe reader.
            pendingReads++;
            lastRead = nanoTime.getAsLong();
        }
        try {
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
        } finally {
            synchronized (activityLock) {
                // A slow database query is not an idle consumer. Start the idle
                // deadline only when the outstanding read has actually ended.
                lastRead = nanoTime.getAsLong();
                pendingReads--;
            }
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
        synchronized (activityLock) {
            if (!started || pendingReads > 0 || now - lastRead < IDLE_NANOS) return false;
            // Make the expiration decision atomic with registering a new read.
            cancel();
            return true;
        }
    }

    void checkCancelled() throws IOException {
        if (cancelled) throw new IOException("SQLite query stream was closed or timed out");
    }
}
