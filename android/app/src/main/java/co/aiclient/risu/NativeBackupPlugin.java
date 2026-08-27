package co.aiclient.risu;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
@CapacitorPlugin(name = "NativeBackup")
public class NativeBackupPlugin extends Plugin {
    private static final int COPY_BUFFER_SIZE = 256 * 1024;
    private static final int MAX_CHUNK_SIZE = 4 * 1024 * 1024;
    private static final long MAX_RAW_DATABASE_SIZE = 512L * 1024L * 1024L;
    private static final long PROGRESS_BYTE_INTERVAL = 512 * 1024;
    private static final long PROGRESS_TIME_INTERVAL_MS = 150;

    private final ConcurrentHashMap<String, File> sessions = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void openImport(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "openImportResult");
    }

    @ActivityCallback
    private void openImportResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) {
            call.reject("No backup file was selected");
            return;
        }

        executor.execute(() -> {
            try {
                ImportResult imported = extractImport(uri);
                JSObject ret = new JSObject();
                ret.put("cancelled", false);
                ret.put("id", imported.id);
                ret.put("size", imported.specialFile.length());
                ret.put("assetsWritten", imported.assetsWritten);
                ret.put("ignoredEntries", imported.ignoredEntries);
                ret.put("raw", imported.raw);
                call.resolve(ret);
            } catch (Exception error) {
                String detail = error.getMessage();
                String message = detail == null || detail.trim().isEmpty()
                    ? "Failed to extract local backup"
                    : "Failed to extract local backup: " + detail;
                call.reject(message, error);
            }
        });
    }

    @PluginMethod
    public void readImportChunk(PluginCall call) {
        String id = call.getString("id");
        Object offsetRaw = call.getData().opt("offset");
        Object lengthRaw = call.getData().opt("length");
        if (id == null || !(offsetRaw instanceof Number)) {
            call.reject("Missing import session or offset");
            return;
        }
        long offsetValue = ((Number) offsetRaw).longValue();
        Integer lengthValue = lengthRaw instanceof Number
            ? ((Number) lengthRaw).intValue()
            : null;
        File specialFile = sessions.get(id);
        if (specialFile == null || !specialFile.isFile()) {
            call.reject("Unknown import session");
            return;
        }
        int requested = lengthValue == null ? MAX_CHUNK_SIZE : lengthValue;
        int length = Math.max(1, Math.min(requested, MAX_CHUNK_SIZE));
        long offset = Math.max(0L, offsetValue);

        executor.execute(() -> {
            try (RandomAccessFile file = new RandomAccessFile(specialFile, "r")) {
                if (offset >= file.length()) {
                    JSObject ret = new JSObject();
                    ret.put("data", "");
                    ret.put("bytesRead", 0);
                    ret.put("eof", true);
                    call.resolve(ret);
                    return;
                }
                int readLength = (int) Math.min((long) length, file.length() - offset);
                byte[] data = new byte[readLength];
                file.seek(offset);
                file.readFully(data);
                JSObject ret = new JSObject();
                ret.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
                ret.put("bytesRead", readLength);
                ret.put("eof", offset + readLength >= file.length());
                call.resolve(ret);
            } catch (Exception error) {
                call.reject("Failed to read extracted backup data", error);
            }
        });
    }

    @PluginMethod
    public void closeImport(PluginCall call) {
        String id = call.getString("id");
        File file = id == null ? null : sessions.remove(id);
        if (file != null) {
            File parent = file.getParentFile();
            deleteTree(parent);
        }
        call.resolve();
    }
    private ImportResult extractImport(Uri uri) throws IOException {
        String id = UUID.randomUUID().toString();
        File sessionDir = new File(getContext().getCacheDir(), "risu-backup-import/" + id);
        File stagingDir = new File(sessionDir, "assets");
        File specialFile = new File(sessionDir, "special.risubackup");
        if (!stagingDir.mkdirs() && !stagingDir.isDirectory()) {
            throw new IOException("Failed to create backup staging directory");
        }

        long totalBytes = contentLength(uri);
        ImportProgressReporter progress = new ImportProgressReporter(totalBytes);
        boolean container = looksLikeContainer(uri, totalBytes);
        try {
            if (!container) {
                if (totalBytes > MAX_RAW_DATABASE_SIZE) {
                    throw new IOException(
                        "This is a raw database backup larger than Android can safely decode. " +
                        "Import it on desktop and create a current local backup before restoring it on Android."
                    );
                }
                copyRawImport(uri, specialFile, progress);
                sessions.put(id, specialFile);
                progress.report("complete", specialFile.length(), 0, 0, true);
                return new ImportResult(id, specialFile, 0, 0, true);
            }

            ContainerExtractionState extracted = parseContainer(
                uri,
                stagingDir,
                specialFile,
                progress,
                totalBytes
            );
            commitAssets(stagingDir, progress, extracted.assetsWritten);
            sessions.put(id, specialFile);
            progress.report(
                "complete",
                totalBytes,
                extracted.assetsWritten,
                extracted.assetsWritten,
                true
            );
            return new ImportResult(
                id,
                specialFile,
                extracted.assetsWritten,
                extracted.ignoredEntries,
                false
            );
        } catch (Exception error) {
            deleteTree(sessionDir);
            if (error instanceof IOException) throw (IOException) error;
            throw new IOException("Failed to extract local backup", error);
        }
    }

    /**
     * Distinguish a container from a raw database before extraction starts.
     * Previously every container I/O error (including full storage or a
     * truncated multi-gigabyte backup) retried by copying the whole file as a
     * raw database and then handed it to the WebView, where it could exhaust
     * memory. Once the first entry is structurally valid, later errors must be
     * reported as container errors instead of changing formats.
     */
    private boolean looksLikeContainer(Uri uri, long totalBytes) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        try (InputStream input = requireInput(resolver.openInputStream(uri))) {
            return BackupContainerCodec.looksLikeContainer(input, totalBytes);
        }
    }

    private ContainerExtractionState parseContainer(
        Uri uri,
        File stagingDir,
        File specialFile,
        ImportProgressReporter progress,
        long totalBytes
    ) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        byte[] copyBuffer = new byte[COPY_BUFFER_SIZE];
        ContainerExtractionState state = new ContainerExtractionState();
        try (
            ProgressInputStream tracked = new ProgressInputStream(
                requireInput(resolver.openInputStream(uri)),
                progress,
                "extracting"
            );
            BufferedOutputStream special = new BufferedOutputStream(new FileOutputStream(specialFile))
        ) {
            BackupContainerCodec.parse(tracked, totalBytes, (name, dataLength, data) -> {
                BackupEntryPolicy.Kind kind = BackupEntryPolicy.classify(name);
                if (kind == BackupEntryPolicy.Kind.INVALID) {
                    throw new IOException("Invalid backup entry path: " + name);
                }
                if (kind == BackupEntryPolicy.Kind.EXTENSION) {
                    drainUntilEof(data, copyBuffer);
                    state.ignoredEntries++;
                    return;
                }
                if (
                    kind == BackupEntryPolicy.Kind.DATABASE ||
                    kind == BackupEntryPolicy.Kind.ENCRYPTION ||
                    kind == BackupEntryPolicy.Kind.COLD_STORAGE
                ) {
                    if (kind == BackupEntryPolicy.Kind.DATABASE) state.hasDatabase = true;
                    BackupContainerCodec.writeEntry(
                        special,
                        data,
                        dataLength,
                        name,
                        copyBuffer
                    );
                    return;
                }

                String key = normalizeAssetKey(name);
                String encodedKey = Base64.encodeToString(
                    key.getBytes(StandardCharsets.UTF_8),
                    Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
                );
                File staged = new File(stagingDir, encodedKey + ".bin");
                try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(staged))) {
                    copyUntilEof(data, output, copyBuffer);
                }
                state.assetsWritten++;
                progress.report("extracting", tracked.getBytesRead(), state.assetsWritten, 0, false);
            });
        }
        if (!state.hasDatabase) {
            throw new IOException("Backup does not contain a database entry");
        }
        return state;
    }

    private String normalizeAssetKey(String name) throws IOException {
        String normalized = name.replace('\\', '/');
        String[] rawParts = normalized.split("/", -1);
        int start = 0;
        while (start < rawParts.length && "assets".equals(rawParts[start])) start++;
        if (start >= rawParts.length) throw new IOException("Invalid backup asset path: " + name);
        StringBuilder path = new StringBuilder("assets");
        for (int index = start; index < rawParts.length; index++) {
            String part = rawParts[index];
            if (part.isEmpty() || ".".equals(part) || "..".equals(part)) {
                throw new IOException("Invalid backup asset path: " + name);
            }
            path.append('/').append(part);
        }
        return path.toString();
    }
    private void commitAssets(
        File stagingDir,
        ImportProgressReporter progress,
        int totalAssets
    ) throws IOException {
        File assetRoot = new File(getContext().getFilesDir(), "risuai-assets");
        if (!assetRoot.mkdirs() && !assetRoot.isDirectory()) {
            throw new IOException("Failed to create native asset directory");
        }
        File[] files = stagingDir.listFiles();
        if (files == null) return;
        byte[] buffer = new byte[COPY_BUFFER_SIZE];
        int committed = 0;
        progress.report("committing", progress.totalBytes, 0, totalAssets, true);
        for (File source : files) {
            File destination = new File(assetRoot, source.getName());
            if (destination.exists() && !destination.delete()) {
                throw new IOException("Failed to replace restored asset");
            }
            if (!source.renameTo(destination)) {
                try (
                    InputStream input = new FileInputStream(source);
                    OutputStream output = new FileOutputStream(destination)
                ) {
                    copyUntilEof(input, output, buffer);
                }
                if (!source.delete()) {
                    throw new IOException("Failed to finalize restored asset");
                }
            }
            committed++;
            progress.report("committing", progress.totalBytes, committed, totalAssets, false);
        }
        deleteTree(stagingDir);
    }

    private void copyRawImport(
        Uri uri,
        File destination,
        ImportProgressReporter progress
    ) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        try (
            InputStream input = new ProgressInputStream(
                requireInput(resolver.openInputStream(uri)),
                progress,
                "fallback"
            );
            OutputStream output = new BufferedOutputStream(new FileOutputStream(destination))
        ) {
            byte[] buffer = new byte[COPY_BUFFER_SIZE];
            long copied = 0L;
            int read;
            while ((read = input.read(buffer)) != -1) {
                copied += read;
                if (copied > MAX_RAW_DATABASE_SIZE) {
                    throw new IOException(
                        "This raw database backup is larger than Android can safely decode"
                    );
                }
                output.write(buffer, 0, read);
            }
        }
    }

    private long contentLength(Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        try (AssetFileDescriptor descriptor = resolver.openAssetFileDescriptor(uri, "r")) {
            if (descriptor == null) return -1L;
            long length = descriptor.getLength();
            return length >= 0 ? length : descriptor.getParcelFileDescriptor().getStatSize();
        } catch (Exception ignored) {
            return -1L;
        }
    }

    private final class ImportProgressReporter {
        final long totalBytes;
        private long lastBytes = -1L;
        private long lastReportedAt = 0L;
        private String lastStage = "";
        private int lastAssetsProcessed = 0;

        ImportProgressReporter(long totalBytes) {
            this.totalBytes = Math.max(-1L, totalBytes);
        }

        synchronized void report(
            String stage,
            long bytesRead,
            int assetsProcessed,
            int totalAssets,
            boolean force
        ) {
            long now = android.os.SystemClock.elapsedRealtime();
            boolean stageChanged = !stage.equals(lastStage);
            if (stageChanged) lastAssetsProcessed = 0;
            lastAssetsProcessed = Math.max(lastAssetsProcessed, assetsProcessed);
            if (
                !force &&
                !stageChanged &&
                bytesRead - lastBytes < PROGRESS_BYTE_INTERVAL &&
                now - lastReportedAt < PROGRESS_TIME_INTERVAL_MS
            ) return;

            lastStage = stage;
            lastBytes = bytesRead;
            lastReportedAt = now;
            JSObject event = new JSObject();
            event.put("stage", stage);
            event.put("bytesRead", Math.max(0L, bytesRead));
            event.put("totalBytes", Math.max(0L, totalBytes));
            event.put("assetsProcessed", Math.max(0, lastAssetsProcessed));
            event.put("totalAssets", Math.max(0, totalAssets));
            notifyListeners("importProgress", event);
        }
    }

    private final class ProgressInputStream extends FilterInputStream {
        private final ImportProgressReporter progress;
        private final String stage;
        private long bytesRead = 0L;

        ProgressInputStream(
            InputStream input,
            ImportProgressReporter progress,
            String stage
        ) {
            super(input);
            this.progress = progress;
            this.stage = stage;
            progress.report(stage, 0L, 0, 0, true);
        }

        long getBytesRead() {
            return bytesRead;
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value >= 0) track(1);
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int count = super.read(buffer, offset, length);
            if (count > 0) track(count);
            return count;
        }

        private void track(int count) {
            bytesRead += count;
            progress.report(stage, bytesRead, 0, 0, false);
        }
    }

    private static InputStream requireInput(InputStream input) throws IOException {
        if (input == null) throw new IOException("Failed to open selected backup");
        return input;
    }

    private static void copyUntilEof(
        InputStream input,
        OutputStream output,
        byte[] buffer
    ) throws IOException {
        int read;
        while ((read = input.read(buffer)) != -1) {
            output.write(buffer, 0, read);
        }
    }

    private static void drainUntilEof(InputStream input, byte[] buffer) throws IOException {
        while (input.read(buffer) != -1) {
            // Unsupported fork extension: consume without allocating or persisting it.
        }
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) deleteTree(child);
        }
        file.delete();
    }

    @Override
    protected void handleOnDestroy() {
        for (File file : sessions.values()) {
            deleteTree(file.getParentFile());
        }
        sessions.clear();
        executor.shutdownNow();
    }

    private static final class ContainerExtractionState {
        int assetsWritten;
        int ignoredEntries;
        boolean hasDatabase;
    }

    private static final class ImportResult {
        final String id;
        final File specialFile;
        final int assetsWritten;
        final int ignoredEntries;
        final boolean raw;

        ImportResult(
            String id,
            File specialFile,
            int assetsWritten,
            int ignoredEntries,
            boolean raw
        ) {
            this.id = id;
            this.specialFile = specialFile;
            this.assetsWritten = assetsWritten;
            this.ignoredEntries = ignoredEntries;
            this.raw = raw;
        }
    }
}
