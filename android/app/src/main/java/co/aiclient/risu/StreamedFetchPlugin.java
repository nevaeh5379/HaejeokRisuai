package co.aiclient.risu;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "StreamedFetch")
public class StreamedFetchPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Map<String, RequestState> requests = new ConcurrentHashMap<>();

    static final class RequestState {
        private volatile boolean cancelled;
        private volatile HttpURLConnection connection;

        void attach(HttpURLConnection connection) throws IOException {
            this.connection = connection;
            if (cancelled) {
                connection.disconnect();
                throwIfCancelled();
            }
        }

        void throwIfCancelled() throws IOException {
            if (cancelled) throw new IOException("Request aborted");
        }

        void cancel() {
            cancelled = true;
            HttpURLConnection current = connection;
            if (current != null) current.disconnect();
        }
    }

    @PluginMethod
    public void cancelStreamedFetch(PluginCall call) {
        String id = call.getString("id");
        RequestState request = id == null ? null : requests.get(id);
        if (request != null) request.cancel();
        call.resolve();
    }

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
        RequestState request = new RequestState();
        if (requests.putIfAbsent(id, request) != null) {
            call.reject("Request id is already active");
            return;
        }
        executor.execute(() -> runRequest(
            call,
            request,
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
        RequestState request,
        String id,
        String url,
        String body,
        String method,
        JSObject headers,
        int timeoutMs
    ) {
        HttpURLConnection connection = null;
        try {
            request.throwIfCancelled();
            connection = (HttpURLConnection) new URL(url).openConnection();
            request.attach(connection);
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
                request.throwIfCancelled();
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(requestBody);
                }
            }

            request.throwIfCancelled();
            int status = connection.getResponseCode();
            request.throwIfCancelled();
            emitHeaders(id, status, connection.getHeaderFields());
            InputStream input = status >= 400
                ? connection.getErrorStream()
                : connection.getInputStream();
            if (input != null) {
                try (InputStream stream = input) {
                    byte[] buffer = new byte[16 * 1024];
                    int read;
                    while ((read = stream.read(buffer)) != -1) {
                        request.throwIfCancelled();
                        if (read == 0) continue;
                        byte[] chunk = new byte[read];
                        System.arraycopy(buffer, 0, chunk, 0, read);
                        emitChunk(id, chunk);
                    }
                }
            }
            request.throwIfCancelled();
            emitEnd(id, true, "");

            JSObject result = new JSObject();
            result.put("success", true);
            result.put("error", "");
            call.resolve(result);
        } catch (Exception error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            emitEnd(id, false, message);
            JSObject result = new JSObject();
            result.put("success", false);
            result.put("error", message);
            call.resolve(result);
        } finally {
            if (connection != null) connection.disconnect();
            requests.remove(id, request);
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

    private void emitEnd(String id, boolean success, String error) {
        JSObject event = new JSObject();
        event.put("type", "end");
        event.put("id", id);
        event.put("success", success);
        event.put("error", error);
        notifyListeners("streamed_fetch", event);
    }

    @Override
    protected void handleOnDestroy() {
        for (RequestState request : requests.values()) request.cancel();
        executor.shutdownNow();
        super.handleOnDestroy();
    }
}
