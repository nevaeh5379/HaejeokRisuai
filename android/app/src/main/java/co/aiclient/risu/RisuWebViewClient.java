package co.aiclient.risu;

import android.content.Context;
import android.net.Uri;
import android.util.Base64;
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
    private final File assetRoot;

    public RisuWebViewClient(Bridge bridge, Context context) {
        super(bridge);
        assetRoot = new File(context.getFilesDir(), "risuai-assets");
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse asset = openRisuAsset(request);
        return asset != null ? asset : super.shouldInterceptRequest(view, request);
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
