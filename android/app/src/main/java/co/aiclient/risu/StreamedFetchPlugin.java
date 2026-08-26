package co.aiclient.risu;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "StreamedFetch")
public class StreamedFetchPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();

    @PluginMethod
    public void streamedFetch(PluginCall call) {
        String id = call.getString("id");
        String url = call.getString("url");
        String body = call.getString("body", "");
        String method = call.getString("method", "POST");
        JSObject headers = call.getObject("headers", new JSObject());
        Integer timeoutMs = call.getInt("timeoutMs", 240_000);

        if (id == null || url == null) {
            call.reject("id and url are required");
            return;
        }

        final int requestTimeout = timeoutMs == null ? 240_000 : Math.max(1, timeoutMs);
        executor.execute(() -> runRequest(
            call,
            id,
            url,
            body,
            method == null ? "POST" : method,
            headers,
            requestTimeout
        ));
    }

    private void runRequest(
        PluginCall call,
        String id,
        String url,
        String body,
        String method,
        JSObject headers,
        int timeoutMs
    ) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setRequestMethod(method.toUpperCase());
            connection.setConnectTimeout(timeoutMs);
            connection.setReadTimeout(timeoutMs);
            connection.setDoInput(true);

            java.util.Iterator<String> headerKeys = headers.keys();
            while (headerKeys.hasNext()) {
                String key = headerKeys.next();
                Object value = headers.opt(key);
                if (value != null) {
                    connection.setRequestProperty(key, String.valueOf(value));
                }
            }

            byte[] requestBody = body.isEmpty()
                ? new byte[0]
                : Base64.decode(body, Base64.DEFAULT);
            if (requestBody.length > 0 && !method.equalsIgnoreCase("GET")) {
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(requestBody.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(requestBody);
                }
            }

            int status = connection.getResponseCode();
            emitHeaders(id, status, connection.getHeaderFields());
            InputStream input = status >= 400
                ? connection.getErrorStream()
                : connection.getInputStream();
            if (input != null) {
                try (InputStream stream = input) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = stream.read(buffer)) != -1) {
                        if (read == 0) continue;
                        byte[] chunk = new byte[read];
                        System.arraycopy(buffer, 0, chunk, 0, read);
                        emitChunk(id, chunk);
                    }
                }
            }
            emitEnd(id);

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("error", "");
            call.resolve(result);
        } catch (Exception error) {
            emitEnd(id);
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("error", error.getMessage() == null ? error.toString() : error.getMessage());
            call.resolve(result);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private void emitHeaders(String id, int status, Map<String, List<String>> fields) {
        JSObject headers = new JSObject();
        for (Map.Entry<String, List<String>> entry : fields.entrySet()) {
            if (entry.getKey() == null || entry.getValue() == null) continue;
            headers.put(entry.getKey(), String.join(", ", entry.getValue()));
        }
        JSObject event = new JSObject();
        event.put("type", "headers");
        event.put("body", headers);
        event.put("id", id);
        event.put("status", status);
        notifyListeners("streamed_fetch", event);
    }

    private void emitChunk(String id, byte[] chunk) {
        JSObject event = new JSObject();
        event.put("type", "chunk");
        event.put("body", Base64.encodeToString(chunk, Base64.NO_WRAP));
        event.put("id", id);
        notifyListeners("streamed_fetch", event);
    }

    private void emitEnd(String id) {
        JSObject event = new JSObject();
        event.put("type", "end");
        event.put("id", id);
        notifyListeners("streamed_fetch", event);
    }

    @Override
    protected void handleOnDestroy() {
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
