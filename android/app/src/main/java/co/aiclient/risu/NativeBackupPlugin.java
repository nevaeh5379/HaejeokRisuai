package co.aiclient.risu;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
@CapacitorPlugin(name = "NativeBackup")
public class NativeBackupPlugin extends Plugin {
    private static final Pattern COLD_STORAGE = Pattern.compile(
        "^(?:coldstorage[/_])?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\.json$"
    );
    private static final int MAX_NAME_LENGTH = 1024 * 1024;
    private static final int COPY_BUFFER_SIZE = 256 * 1024;
    private static final int MAX_CHUNK_SIZE = 4 * 1024 * 1024;

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
                ret.put("raw", imported.raw);
                call.resolve(ret);
            } catch (Exception error) {
                call.reject("Failed to extract local backup", error);
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

        int assetsWritten;
        try {
            assetsWritten = parseContainer(uri, stagingDir, specialFile);
        } catch (Exception containerError) {
            deleteTree(stagingDir);
            if (specialFile.exists() && !specialFile.delete()) {
                throw new IOException("Failed to reset backup staging file", containerError);
            }
            copyRawImport(uri, specialFile);
            sessions.put(id, specialFile);
            return new ImportResult(id, specialFile, 0, true);
        }

        try {
            commitAssets(stagingDir);
        } catch (IOException commitError) {
            deleteTree(sessionDir);
            throw commitError;
        }
        sessions.put(id, specialFile);
        return new ImportResult(id, specialFile, assetsWritten, false);
    }

    private int parseContainer(Uri uri, File stagingDir, File specialFile) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        byte[] copyBuffer = new byte[COPY_BUFFER_SIZE];
        int assetsWritten = 0;
        boolean hasDatabase = false;
        try (
            InputStream raw = resolver.openInputStream(uri);
            BufferedInputStream input = new BufferedInputStream(requireInput(raw));
            BufferedOutputStream special = new BufferedOutputStream(new FileOutputStream(specialFile))
        ) {
            while (true) {
                Long nameLength = readUint32LEOrEof(input);
                if (nameLength == null) break;
                if (nameLength <= 0 || nameLength > MAX_NAME_LENGTH) {
                    throw new IOException("Invalid backup entry name length");
                }
                byte[] nameBytes = readExact(input, nameLength.intValue());
                String name = new String(nameBytes, StandardCharsets.UTF_8);
                long dataLength = requireUint32LE(input, "backup entry data length");
                if (isSpecialEntry(name)) {
                    if ("database.risudat".equals(name)) hasDatabase = true;
                    writeUint32LE(special, nameBytes.length);
                    special.write(nameBytes);
                    writeUint32LE(special, dataLength);
                    copyExact(input, special, dataLength, copyBuffer);
                } else {
                    String key = normalizeAssetKey(name);
                    String encodedKey = Base64.encodeToString(
                        key.getBytes(StandardCharsets.UTF_8),
                        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
                    );
                    File staged = new File(stagingDir, encodedKey + ".bin");
                    try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(staged))) {
                        copyExact(input, output, dataLength, copyBuffer);
                    }
                    assetsWritten++;
                }
            }
        }
        if (!hasDatabase) {
            throw new IOException("Backup does not contain a database entry");
        }
        return assetsWritten;
    }

    private boolean isSpecialEntry(String name) {
        return "database.risudat".equals(name)
            || "encryption.risudat".equals(name)
            || COLD_STORAGE.matcher(name).matches();
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
    private void commitAssets(File stagingDir) throws IOException {
        File assetRoot = new File(getContext().getFilesDir(), "risuai-assets");
        if (!assetRoot.mkdirs() && !assetRoot.isDirectory()) {
            throw new IOException("Failed to create native asset directory");
        }
        File[] files = stagingDir.listFiles();
        if (files == null) return;
        byte[] buffer = new byte[COPY_BUFFER_SIZE];
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
        }
        deleteTree(stagingDir);
    }

    private void copyRawImport(Uri uri, File destination) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        try (
            InputStream input = requireInput(resolver.openInputStream(uri));
            OutputStream output = new BufferedOutputStream(new FileOutputStream(destination))
        ) {
            copyUntilEof(input, output, new byte[COPY_BUFFER_SIZE]);
        }
    }

    private static InputStream requireInput(InputStream input) throws IOException {
        if (input == null) throw new IOException("Failed to open selected backup");
        return input;
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
        while (remaining > 0) {
            int read = input.read(buffer, 0, (int) Math.min(buffer.length, remaining));
            if (read < 0) throw new IOException("Backup file ended unexpectedly");
            output.write(buffer, 0, read);
            remaining -= read;
        }
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

    private static final class ImportResult {
        final String id;
        final File specialFile;
        final int assetsWritten;
        final boolean raw;

        ImportResult(String id, File specialFile, int assetsWritten, boolean raw) {
            this.id = id;
            this.specialFile = specialFile;
            this.assetsWritten = assetsWritten;
            this.raw = raw;
        }
    }
}
