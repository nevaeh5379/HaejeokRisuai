package co.aiclient.risu;

import android.content.Context;
import android.content.SharedPreferences;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;

/**
 * Tracks which plugin sandbox was loading when the WebView renderer died so
 * the next boot can skip the culprit and break boot crash loops.
 *
 * The JS layer records "about to load plugin X" right before starting each
 * sandbox and clears the ledger once boot stabilizes. When the renderer
 * dies, {@link #blameLoadingPlugin} moves that ledger entry into a
 * persistent blocklist — no JS bridge is alive at that point, so the
 * write happens natively with a synchronous commit.
 */
@CapacitorPlugin(name = "CrashGuard")
public class CrashGuardPlugin extends Plugin {
    private static final String PREFS = "risu_native";
    private static final String KEY_LOADING = "loading_plugin";
    private static final String KEY_BLOCKED = "blocked_plugins";

    @PluginMethod
    public void checkpoint(PluginCall call) {
        AndroidCrashDiagnostics.checkpoint(call.getString("stage"));
        call.resolve();
    }

    @PluginMethod
    public void shareDiagnostics(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                AndroidCrashDiagnostics.share(getActivity());
                call.resolve();
            } catch (Exception error) {
                call.reject("Could not share Android diagnostics", error);
            }
        });
    }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** JS: record "about to load plugin X" before starting the sandbox. */
    @PluginMethod
    public void setLoadingPlugin(PluginCall call) {
        String name = call.getString("name");
        if (name == null) {
            call.reject("name is required");
            return;
        }
        prefs(getContext()).edit().putString(KEY_LOADING, name).apply();
        AndroidCrashDiagnostics.checkpoint("runtime:plugin-sandbox-loading");
        call.resolve();
    }

    /** JS: boot fully succeeded — clear the ledger (grace elapsed). */
    @PluginMethod
    public void clearLoadingPlugin(PluginCall call) {
        prefs(getContext()).edit().remove(KEY_LOADING).apply();
        call.resolve();
    }

    /** JS boot: which plugins should be skipped? */
    @PluginMethod
    public void getBlockedPlugins(PluginCall call) {
        try {
            JSONArray arr = new JSONArray(
                prefs(getContext()).getString(KEY_BLOCKED, "[]"));
            JSObject data = new JSObject();
            data.put("plugins", arr);
            call.resolve(data);
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /** JS: culprit disabled in the DB — native blocklist entry can go. */
    @PluginMethod
    public void clearBlockedPlugin(PluginCall call) {
        String name = call.getString("name");
        if (name == null) {
            call.reject("name is required");
            return;
        }
        try {
            JSONArray arr = new JSONArray(
                prefs(getContext()).getString(KEY_BLOCKED, "[]"));
            JSONArray out = new JSONArray();
            for (int i = 0; i < arr.length(); i++) {
                if (!name.equals(arr.getString(i))) out.put(arr.getString(i));
            }
            prefs(getContext()).edit().putString(KEY_BLOCKED, out.toString()).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    /**
     * Called from RisuWebViewClient.onRenderProcessGone — no JS is alive.
     * Moves the pending "loading" ledger entry into the persistent
     * blocklist so the next boot skips the culprit plugin.
     *
     * @return true if a NEW culprit was added to the blocklist. The caller
     *         uses this to bypass the restart-loop guard: each blocked
     *         culprit makes the next boot strictly safer, so restarting
     *         is always progress even when deaths come in quick
     *         succession (multi-culprit boot loops).
     */
    static boolean blameLoadingPlugin(Context context) {
        SharedPreferences p = prefs(context);
        String loading = p.getString(KEY_LOADING, null);
        if (loading == null || loading.isEmpty()) return false; // no culprit — plain restart
        try {
            JSONArray arr = new JSONArray(p.getString(KEY_BLOCKED, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                if (loading.equals(arr.getString(i))) return false; // already blocked
            }
            arr.put(loading);
            // Synchronous commit: the activity is about to be restarted.
            p.edit().putString(KEY_BLOCKED, arr.toString())
                .remove(KEY_LOADING) // consumed
                .commit();
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }
}
