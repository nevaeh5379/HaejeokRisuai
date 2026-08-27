package co.aiclient.risu;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashSet;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

@CapacitorPlugin(name = "NativeImage")
public class NativeImagePlugin extends Plugin {
    private static final int DEFAULT_THUMB_SIZE = 128;
    private static final int MAX_DIMENSION = 2048;
    private static final int WEBP_QUALITY = 82;
    private static final long CACHE_BYTE_LIMIT = 128L * 1024 * 1024;
    private static final long CACHE_BYTE_TARGET = 96L * 1024 * 1024;
    private static final int CACHE_PRUNE_INTERVAL = 16;
    private static final long CACHE_TOUCH_INTERVAL_MS = 5 * 60 * 1000L;

    // Two decodes are enough to keep modern devices busy without allowing a
    // scrolling image grid to exhaust the shared Android/WebView memory budget.
    private final ExecutorService executor = Executors.newFixedThreadPool(2);
    private final AtomicInteger thumbnailsSincePrune = new AtomicInteger();

    @PluginMethod
    public void readThumbnail(PluginCall call) {
        String key = call.getString("key");
        int maxWidth = clampDimension(call.getInt("maxWidth", DEFAULT_THUMB_SIZE));
        int maxHeight = clampDimension(call.getInt("maxHeight", DEFAULT_THUMB_SIZE));
        if (key == null || key.isEmpty()) {
            call.reject("Missing native image key");
            return;
        }

        executor.execute(() -> {
            try {
                File source = assetFile(key);
                if (!source.isFile()) {
                    call.reject("Native image does not exist");
                    return;
                }
                File cached = cachedFile(key, maxWidth, maxHeight, source);
                if (!cached.isFile()) {
                    createThumbnail(source, cached, maxWidth, maxHeight);
                    if (thumbnailsSincePrune.incrementAndGet() >= CACHE_PRUNE_INTERVAL) {
                        thumbnailsSincePrune.set(0);
                        pruneCache(cached.getParentFile());
                    }
                }
                long now = System.currentTimeMillis();
                if (now - cached.lastModified() >= CACHE_TOUCH_INTERVAL_MS) {
                    cached.setLastModified(now);
                }
                JSObject result = new JSObject();
                // Return a local path instead of Base64. Capacitor.convertFileSrc
                // maps this to its WebViewLocalServer, which streams the WebP
                // directly from disk without Java String or JS buffer copies.
                result.put("path", cached.getAbsolutePath());
                result.put("bytes", cached.length());
                result.put("mimeType", "image/webp");
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Failed to create native image thumbnail", error);
            }
        });
    }

    @PluginMethod
    public void prepareThumbnails(PluginCall call) {
        JSArray keys = call.getArray("keys");
        int maxWidth = clampDimension(call.getInt("maxWidth", DEFAULT_THUMB_SIZE));
        int maxHeight = clampDimension(call.getInt("maxHeight", DEFAULT_THUMB_SIZE));
        if (keys == null) {
            call.reject("Missing native image keys");
            return;
        }

        ArrayList<String> uniqueKeys = new ArrayList<>();
        HashSet<String> seen = new HashSet<>();
        for (int index = 0; index < keys.length(); index++) {
            String key = keys.optString(index, null);
            if (key != null && !key.isEmpty() && seen.add(key)) uniqueKeys.add(key);
        }

        int total = uniqueKeys.size();
        if (total == 0) {
            JSObject result = new JSObject();
            result.put("total", 0);
            result.put("created", 0);
            result.put("cached", 0);
            result.put("missing", 0);
            result.put("failed", 0);
            result.put("ready", new JSArray());
            call.resolve(result);
            return;
        }

        AtomicInteger remaining = new AtomicInteger(total);
        AtomicInteger created = new AtomicInteger();
        AtomicInteger cached = new AtomicInteger();
        AtomicInteger missing = new AtomicInteger();
        AtomicInteger failed = new AtomicInteger();
        ConcurrentLinkedQueue<String> readyKeys = new ConcurrentLinkedQueue<>();

        for (String key : uniqueKeys) {
            executor.execute(() -> {
                try {
                    File source = assetFile(key);
                    if (!source.isFile()) {
                        missing.incrementAndGet();
                    } else {
                        File target = cachedFile(key, maxWidth, maxHeight, source);
                        if (target.isFile()) {
                            cached.incrementAndGet();
                            readyKeys.add(key);
                        } else {
                            createThumbnail(source, target, maxWidth, maxHeight);
                            created.incrementAndGet();
                            readyKeys.add(key);
                            if (thumbnailsSincePrune.incrementAndGet() >= CACHE_PRUNE_INTERVAL) {
                                thumbnailsSincePrune.set(0);
                                pruneCache(target.getParentFile());
                            }
                        }
                    }
                } catch (Exception error) {
                    failed.incrementAndGet();
                } finally {
                    if (remaining.decrementAndGet() == 0) {
                        JSObject result = new JSObject();
                        result.put("total", total);
                        result.put("created", created.get());
                        result.put("cached", cached.get());
                        result.put("missing", missing.get());
                        result.put("failed", failed.get());
                        JSArray ready = new JSArray();
                        for (String readyKey : readyKeys) ready.put(readyKey);
                        result.put("ready", ready);
                        call.resolve(result);
                    }
                }
            });
        }
    }

    private int clampDimension(Integer value) {
        if (value == null) return DEFAULT_THUMB_SIZE;
        return Math.max(32, Math.min(value, MAX_DIMENSION));
    }

    private File assetFile(String key) {
        String encoded = Base64.encodeToString(
            key.getBytes(StandardCharsets.UTF_8),
            Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
        );
        return new File(new File(getContext().getFilesDir(), "risuai-assets"), encoded + ".bin");
    }

    private File cachedFile(
        String key,
        int maxWidth,
        int maxHeight,
        File source
    ) throws IOException {
        File root = new File(getContext().getCacheDir(), "risu-image-thumbnails");
        if (!root.mkdirs() && !root.isDirectory()) {
            throw new IOException("Failed to create native image cache");
        }
        String cacheKey = key + "\n" + maxWidth + "x" + maxHeight +
            "\n" + source.lastModified() + ":" + source.length();
        String encoded = Base64.encodeToString(
            cacheKey.getBytes(StandardCharsets.UTF_8),
            Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
        );
        return new File(root, encoded + ".webp");
    }

    private void createThumbnail(
        File source,
        File destination,
        int maxWidth,
        int maxHeight
    ) throws IOException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeFile(source.getAbsolutePath(), bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new IOException("Unsupported native image format");
        }

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inPreferredConfig = Bitmap.Config.ARGB_8888;
        options.inSampleSize = calculateSampleSize(
            bounds.outWidth,
            bounds.outHeight,
            maxWidth,
            maxHeight
        );
        Bitmap decoded = BitmapFactory.decodeFile(source.getAbsolutePath(), options);
        if (decoded == null) throw new IOException("Failed to decode native image");

        Bitmap scaled = decoded;
        try {
            float scale = Math.min(
                1f,
                Math.min((float) maxWidth / decoded.getWidth(), (float) maxHeight / decoded.getHeight())
            );
            int width = Math.max(1, Math.round(decoded.getWidth() * scale));
            int height = Math.max(1, Math.round(decoded.getHeight() * scale));
            if (width != decoded.getWidth() || height != decoded.getHeight()) {
                scaled = Bitmap.createScaledBitmap(decoded, width, height, true);
            }

            File temporary = new File(destination.getParentFile(), destination.getName() + ".tmp");
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                Bitmap.CompressFormat format = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    ? Bitmap.CompressFormat.WEBP_LOSSY
                    : Bitmap.CompressFormat.WEBP;
                if (!scaled.compress(format, WEBP_QUALITY, output)) {
                    throw new IOException("Failed to encode native thumbnail");
                }
            }
            if (destination.exists() && !destination.delete()) {
                throw new IOException("Failed to replace cached native thumbnail");
            }
            if (!temporary.renameTo(destination)) {
                throw new IOException("Failed to publish cached native thumbnail");
            }
        } finally {
            if (scaled != decoded) scaled.recycle();
            decoded.recycle();
        }
    }

    private int calculateSampleSize(
        int width,
        int height,
        int maxWidth,
        int maxHeight
    ) {
        int sample = 1;
        while (width / (sample * 2) >= maxWidth || height / (sample * 2) >= maxHeight) {
            sample *= 2;
        }
        return sample;
    }

    private void pruneCache(File root) {
        File[] files = root == null ? null : root.listFiles((dir, name) -> name.endsWith(".webp"));
        if (files == null || files.length == 0) return;
        long totalBytes = 0;
        for (File file : files) totalBytes += file.length();
        if (totalBytes <= CACHE_BYTE_LIMIT) return;

        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        for (File file : files) {
            long length = file.length();
            if (file.delete()) totalBytes -= length;
            if (totalBytes <= CACHE_BYTE_TARGET) break;
        }
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
    }
}
