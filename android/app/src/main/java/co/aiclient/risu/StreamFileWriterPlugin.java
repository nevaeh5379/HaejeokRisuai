package co.aiclient.risu;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "StreamFileWriter")
public class StreamFileWriterPlugin extends Plugin {
    private static final String TAG = "RisuBackupWriter";

    private final Map<String, OutputStream> streams = new ConcurrentHashMap<>();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private long openLaunchedAtElapsed = 0L;

    @PluginMethod
    public void open(PluginCall call) {
        String fileName = call.getString("fileName", "backup.bin");
        String mimeType = call.getString("mimeType", "application/octet-stream");

        Log.i(TAG, "open: requesting destination, fileName=" + fileName + ", mimeType=" + mimeType);
        openLaunchedAtElapsed = SystemClock.elapsedRealtime();

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mimeType);
        intent.putExtra(Intent.EXTRA_TITLE, fileName);
        startActivityForResult(call, intent, "openResult");
    }

    @ActivityCallback
    private void openResult(PluginCall call, ActivityResult result) {
        long elapsedMs = SystemClock.elapsedRealtime() - openLaunchedAtElapsed;
        if (call == null) {
            Log.w(TAG, "openResult: saved call was lost (elapsed=" + elapsedMs + "ms)");
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            Log.w(
                TAG,
                "openResult: cancelled, resultCode=" + result.getResultCode()
                    + ", dataNull=" + (result.getData() == null)
                    + ", elapsed=" + elapsedMs + "ms"
            );
            JSObject ret = new JSObject();
            ret.put("cancelled", true);
            call.resolve(ret);
            return;
        }

        Uri uri = result.getData().getData();
        if (uri == null) {
            Log.e(TAG, "openResult: RESULT_OK but no uri, elapsed=" + elapsedMs + "ms");
            call.reject("No destination was selected");
            return;
        }

        try {
            ContentResolver resolver = getContext().getContentResolver();
            OutputStream stream = resolver.openOutputStream(uri, "w");
            if (stream == null) {
                Log.e(TAG, "openResult: openOutputStream returned null, uri=" + uri);
                call.reject("Failed to open the selected destination");
                return;
            }
            String id = UUID.randomUUID().toString();
            streams.put(id, stream);
            Log.i(TAG, "openResult: destination opened, id=" + id + ", elapsed=" + elapsedMs + "ms");
            JSObject ret = new JSObject();
            ret.put("id", id);
            ret.put("cancelled", false);
            call.resolve(ret);
        } catch (Exception error) {
            Log.e(TAG, "openResult: failed to open destination, uri=" + uri, error);
            call.reject("Failed to open the selected destination", error);
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        String id = call.getString("id");
        String encoded = call.getString("data");
        if (id == null || encoded == null) {
            Log.w(TAG, "write: missing id or data, idNull=" + (id == null));
            call.reject("Missing stream id or data");
            return;
        }

        OutputStream stream = streams.get(id);
        if (stream == null) {
            Log.w(TAG, "write: unknown or closed stream id=" + id + ", chunkBytes=" + encoded.length());
            call.reject("Unknown or closed stream");
            return;
        }

        executor.execute(() -> {
            try {
                byte[] data = Base64.decode(encoded, Base64.DEFAULT);
                stream.write(data);
                call.resolve();
            } catch (Exception error) {
                Log.e(TAG, "write: failed to write " + encoded.length() + " base64 chars to stream id=" + id, error);
                call.reject("Failed to write backup data", error);
            }
        });
    }

    @PluginMethod
    public void writeText(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        if (id == null || data == null) {
            Log.w(TAG, "writeText: missing id or data, idNull=" + (id == null));
            call.reject("Missing stream id or text data");
            return;
        }

        OutputStream stream = streams.get(id);
        if (stream == null) {
            Log.w(TAG, "writeText: unknown or closed stream id=" + id + ", textBytes~" + data.length());
            call.reject("Unknown or closed stream");
            return;
        }

        executor.execute(() -> {
            try {
                stream.write(data.getBytes(StandardCharsets.UTF_8));
                call.resolve();
            } catch (Exception error) {
                Log.e(TAG, "writeText: failed to write text to stream id=" + id, error);
                call.reject("Failed to write text data", error);
            }
        });
    }


    @PluginMethod
    public void writeAssets(PluginCall call) {
        String id = call.getString("id");
        JSArray keys = call.getArray("keys");
        if (id == null || keys == null) {
            Log.w(TAG, "writeAssets: missing id or keys, idNull=" + (id == null));
            call.reject("Missing stream id or asset keys");
            return;
        }

        OutputStream stream = streams.get(id);
        if (stream == null) {
            Log.w(TAG, "writeAssets: unknown or closed stream id=" + id + ", keys=" + keys.length());
            call.reject("Unknown or closed stream");
            return;
        }

        executor.execute(() -> {
            JSArray missing = new JSArray();
            int written = 0;
            byte[] copyBuffer = new byte[256 * 1024];
            File assetRoot = new File(getContext().getFilesDir(), "risuai-assets");
            try {
                for (int index = 0; index < keys.length(); index++) {
                    String key = keys.optString(index, null);
                    if (key == null || key.isEmpty()) continue;
                    String encodedKey = Base64.encodeToString(
                        key.getBytes(StandardCharsets.UTF_8),
                        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
                    );
                    File source = new File(assetRoot, encodedKey + ".bin");
                    if (!source.isFile()) {
                        missing.put(key);
                        continue;
                    }
                    writeBackupEntry(stream, source, backupName(key), copyBuffer);
                    written++;
                }
                Log.i(
                    TAG,
                    "writeAssets: done, written=" + written
                        + ", missing=" + missing.length() + ", stream id=" + id
                );
                JSObject ret = new JSObject();
                ret.put("written", written);
                ret.put("missing", missing);
                call.resolve(ret);
            } catch (Exception error) {
                Log.e(TAG, "writeAssets: failed after " + written + " assets, stream id=" + id, error);
                call.reject("Failed to stream native assets into backup", error);
            }
        });
    }

    private static String backupName(String key) {
        String normalized = key.replace('\\', '/');
        int slash = normalized.lastIndexOf('/');
        return slash >= 0 ? normalized.substring(slash + 1) : normalized;
    }

    private static void writeBackupEntry(
        OutputStream stream,
        File source,
        String name,
        byte[] copyBuffer
    ) throws IOException {
        long length = source.length();
        try (FileInputStream input = new FileInputStream(source)) {
            BackupContainerCodec.writeEntry(stream, input, length, name, copyBuffer);
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            Log.w(TAG, "close: missing stream id");
            call.reject("Missing stream id");
            return;
        }

        OutputStream stream = streams.remove(id);
        if (stream == null) {
            Log.i(TAG, "close: stream already closed or unknown, id=" + id);
            call.resolve();
            return;
        }

        executor.execute(() -> {
            try {
                stream.flush();
                stream.close();
                Log.i(TAG, "close: stream finalized, id=" + id);
                call.resolve();
            } catch (Exception error) {
                Log.e(TAG, "close: failed to finalize stream id=" + id, error);
                call.reject("Failed to finalize backup file", error);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        int pendingStreams = streams.size();
        if (pendingStreams > 0) {
            Log.w(TAG, "onDestroy: closing " + pendingStreams + " unfinished backup stream(s)");
        }
        for (OutputStream stream : streams.values()) {
            try {
                stream.close();
            } catch (IOException ignored) {}
        }
        streams.clear();
        executor.shutdownNow();
    }
}
