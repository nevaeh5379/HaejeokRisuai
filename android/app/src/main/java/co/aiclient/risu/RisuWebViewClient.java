package co.aiclient.risu;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/** Serves immutable hashed RisuAI assets directly to WebView. */
public final class RisuWebViewClient extends BridgeWebViewClient {
    public static final String ASSET_PREFIX = "/_risu_asset_/";
    public static final String THUMB_PREFIX = "/_risu_thumb_/";
    private static final String TAG = "RisuWebViewClient";
    /** Suppresses restarts when the renderer dies again shortly after one. */
    private static final long RESTART_LOOP_GUARD_MS = 30_000;
    private static long lastRendererRestartAt = 0L;

    private final File assetRoot;
    private final File thumbnailRoot;
    private final Context context;
    private final Runnable pageFinishedCallback;
    private final Bridge risuBridge;

    public RisuWebViewClient(
        Bridge bridge, Context context, Runnable pageFinishedCallback
    ) {
        super(bridge);
        risuBridge = bridge;
        assetRoot = new File(context.getFilesDir(), "risuai-assets");
        thumbnailRoot = new File(context.getCacheDir(), "risu-image-thumbnails");
        this.context = context;
        this.pageFinishedCallback = pageFinishedCallback;
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        super.onPageFinished(view, url);
        pageFinishedCallback.run();
    }

    /**
     * The renderer process died (e.g. a plugin sandbox exhausted the JS
     * heap). The WebView is already unusable and Capacitor's Bridge owns
     * it, so re-creating only the WebView is unsafe — restarting the
     * Activity is the verified path. The app process survives, so
     * persisted state is intact. Before restarting, blame the plugin
     * that was mid-load when the renderer died so the next boot skips it.
     */
    @Override
    public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return false; // API 26- only; default behavior below min
        }
        Log.e(TAG, "Renderer gone (crashed=" + detail.didCrash() + ")");
        boolean blamedNewCulprit = CrashGuardPlugin.blameLoadingPlugin(context);
        restartActivity(blamedNewCulprit);
        return true; // true = the app handled the crash
    }

    private void restartActivity(boolean bypassLoopGuard) {
        // Loop guard: if we restarted less than 30s ago and the renderer
        // died again, the cause is likely the main bundle — stop
        // restarting. Exception: when this death blamed a NEW culprit
        // plugin, the next boot loads strictly fewer plugins, so each
        // restart is guaranteed progress toward a clean boot. Multi-
        // culprit crashes on slow devices routinely die within the
        // guard window; suppressing the restart there would leave a dead
        // WebView instead of converging.
        long now = SystemClock.elapsedRealtime();
        if (!bypassLoopGuard && now - lastRendererRestartAt < RESTART_LOOP_GUARD_MS) {
            Log.e(TAG, "Renderer died again within the restart guard window; not restarting.");
            return;
        }
        lastRendererRestartAt = now;

        Intent intent = context.getPackageManager()
            .getLaunchIntentForPackage(context.getPackageName());
        if (intent != null) {
            if (risuBridge.getActivity() instanceof MainActivity
                && ((MainActivity) risuBridge.getActivity()).isSafeMode()) {
                intent.setAction(MainActivity.ACTION_SAFE_MODE);
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
            context.startActivity(intent);
        }
        if (context instanceof Activity) {
            ((Activity) context).finish();
        }
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse thumbnail = openRisuThumbnail(request);
        if (thumbnail != null) return thumbnail;
        WebResourceResponse asset = openRisuAsset(request);
        return asset != null ? asset : super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse openRisuThumbnail(WebResourceRequest request) {
        String path = request.getUrl().getPath();
        if (path == null || !path.startsWith(THUMB_PREFIX)) return null;

        String remainder = path.substring(THUMB_PREFIX.length());
        int slash = remainder.indexOf('/');
        if (slash <= 0 || slash == remainder.length() - 1) {
            return response(400, "Bad Request", "text/plain", null, 0);
        }
        String[] dimensions = remainder.substring(0, slash).split("x", 2);
        String encoded = remainder.substring(slash + 1);
        if (dimensions.length != 2 || !encoded.matches("[A-Za-z0-9_-]+")) {
            return response(400, "Bad Request", "text/plain", null, 0);
        }

        try {
            int width = Integer.parseInt(dimensions[0]);
            int height = Integer.parseInt(dimensions[1]);
            if (width < 32 || width > 2048 || height < 32 || height > 2048) {
                return response(400, "Bad Request", "text/plain", null, 0);
            }
            String key = new String(
                Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING),
                StandardCharsets.UTF_8
            );
            File source = new File(assetRoot, encoded + ".bin");
            if (!source.isFile()) return response(404, "Not Found", "text/plain", null, 0);

            String cacheKey = key + "\n" + width + "x" + height +
                "\n" + source.lastModified() + ":" + source.length();
            String cacheName = Base64.encodeToString(
                cacheKey.getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING
            );
            File thumbnail = new File(thumbnailRoot, cacheName + ".webp");
            if (!thumbnail.isFile()) return response(404, "Not Found", "text/plain", null, 0);

            BufferedInputStream stream = new BufferedInputStream(new FileInputStream(thumbnail), 32 * 1024);
            return response(200, "OK", "image/webp", stream, thumbnail.length());
        } catch (Exception error) {
            return response(500, "Internal Server Error", "text/plain", null, 0);
        }
    }

    private WebResourceResponse openRisuAsset(WebResourceRequest request) {
        Uri uri = request.getUrl();
        String path = uri.getPath();
        if (path == null || !path.startsWith(ASSET_PREFIX)) return null;

        String encoded = path.substring(ASSET_PREFIX.length());
        if (encoded.isEmpty() || !encoded.matches("[A-Za-z0-9_-]+")) {
            return response(400, "Bad Request", "text/plain", null, 0);
        }

        try {
            File source = new File(assetRoot, encoded + ".bin");
            if (!source.isFile()) return response(404, "Not Found", "text/plain", null, 0);

            String key = new String(
                Base64.decode(encoded, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING),
                StandardCharsets.UTF_8
            );
            String mimeType = imageMimeType(key);
            BufferedInputStream stream = new BufferedInputStream(new FileInputStream(source), 64 * 1024);
            return response(200, "OK", mimeType, stream, source.length());
        } catch (Exception error) {
            return response(500, "Internal Server Error", "text/plain", null, 0);
        }
    }

    private WebResourceResponse response(
        int status, String reason, String mimeType, BufferedInputStream stream, long length
    ) {
        Map<String, String> headers = new HashMap<>();
        headers.put(
            "Cache-Control",
            status == 200 ? "public, max-age=31536000, immutable" : "no-store"
        );
        headers.put("X-Content-Type-Options", "nosniff");
        if (length > 0) headers.put("Content-Length", Long.toString(length));
        return new WebResourceResponse(mimeType, null, status, reason, headers, stream);
    }

    private String imageMimeType(String key) {
        String lower = key.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".avif")) return "image/avif";
        if (lower.endsWith(".heic") || lower.endsWith(".heif")) return "image/heif";
        if (lower.endsWith(".bmp")) return "image/bmp";
        return "application/octet-stream";
    }
}
