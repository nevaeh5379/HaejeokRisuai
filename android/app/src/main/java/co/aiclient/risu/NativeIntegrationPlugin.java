package co.aiclient.risu;

import android.app.StatusBarManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

@CapacitorPlugin(name = "NativeIntegration")
public class NativeIntegrationPlugin extends Plugin {
    public static final String ACTION_OPEN_CHAT = "co.aiclient.risu.action.OPEN_CHAT";
    public static final String ACTION_OPEN_CHARACTER = "co.aiclient.risu.action.OPEN_CHARACTER";
    public static final String EXTRA_CHARACTER_ID = "co.aiclient.risu.extra.CHARACTER_ID";
    public static final String EXTRA_CHAT_ID = "co.aiclient.risu.extra.CHAT_ID";
    private static final String EXTRA_HANDLED = "co.aiclient.risu.extra.NATIVE_ENTRY_HANDLED";
    private static final int MAX_SHARED_TEXT_LENGTH = 256 * 1024;
    private static final ConcurrentLinkedQueue<JSObject> PENDING_ENTRIES =
        new ConcurrentLinkedQueue<>();

    public static boolean enqueueIntent(Context context, Intent intent) {
        if (intent == null || intent.getBooleanExtra(EXTRA_HANDLED, false)) return false;
        JSObject entry = parseIntent(context, intent);
        if (entry == null) return false;
        intent.putExtra(EXTRA_HANDLED, true);
        PENDING_ENTRIES.add(entry);
        return true;
    }

    @PluginMethod
    public void consumePendingEntries(PluginCall call) {
        JSArray entries = new JSArray();
        JSObject entry;
        while ((entry = PENDING_ENTRIES.poll()) != null) {
            entries.put(entry);
        }
        JSObject result = new JSObject();
        result.put("entries", entries);
        call.resolve(result);
    }

    @PluginMethod
    public void updateShortcuts(PluginCall call) {
        JSArray items = call.getArray("items");
        int updated = AndroidShortcutManager.update(
            getContext(),
            items == null ? new JSArray() : items
        );
        JSObject result = new JSObject();
        result.put("updated", updated);
        call.resolve(result);
    }

    @PluginMethod
    public void updateRecentChatWidget(PluginCall call) {
        JSObject item = call.getObject("item");
        android.content.SharedPreferences.Editor editor = getContext()
            .getSharedPreferences(RecentChatWidgetProvider.PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .clear();
        if (item != null) {
            putPreference(editor, RecentChatWidgetProvider.KEY_CHARACTER_ID, item.getString("characterId"));
            putPreference(editor, RecentChatWidgetProvider.KEY_CHAT_ID, item.getString("chatId"));
            putPreference(editor, RecentChatWidgetProvider.KEY_CHARACTER_NAME, item.getString("characterName"));
            putPreference(editor, RecentChatWidgetProvider.KEY_CHAT_NAME, item.getString("chatName"));
            String lastMessage = item.getString("lastMessage");
            if (lastMessage != null && lastMessage.length() > 500) {
                lastMessage = lastMessage.substring(0, 500);
            }
            putPreference(editor, RecentChatWidgetProvider.KEY_LAST_MESSAGE, lastMessage);
        }
        editor.apply();
        RecentChatWidgetProvider.updateAll(getContext());
        call.resolve();
    }

    @PluginMethod
    public void requestPinRecentChatWidget(PluginCall call) {
        JSObject result = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            result.put("supported", false);
            result.put("accepted", false);
            call.resolve(result);
            return;
        }
        AppWidgetManager manager = AppWidgetManager.getInstance(getContext());
        boolean supported = manager.isRequestPinAppWidgetSupported();
        boolean accepted = supported && manager.requestPinAppWidget(
            new ComponentName(getContext(), RecentChatWidgetProvider.class),
            null,
            null
        );
        result.put("supported", supported);
        result.put("accepted", accepted);
        call.resolve(result);
    }

    @PluginMethod
    public void requestQuickSettingsTile(PluginCall call) {
        JSObject unsupported = new JSObject();
        unsupported.put("supported", false);
        unsupported.put("result", -1);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.resolve(unsupported);
            return;
        }
        StatusBarManager manager = getContext().getSystemService(StatusBarManager.class);
        if (manager == null) {
            call.resolve(unsupported);
            return;
        }
        ComponentName component = new ComponentName(getContext(), RisuQuickSettingsTileService.class);
        Icon icon = Icon.createWithResource(getContext(), R.drawable.ic_stat_risu);
        manager.requestAddTileService(
            component,
            getContext().getString(R.string.quick_settings_tile_label),
            icon,
            getActivity().getMainExecutor(),
            requestResult -> {
                JSObject result = new JSObject();
                result.put("supported", true);
                result.put("result", requestResult);
                call.resolve(result);
            }
        );
    }

    private static void putPreference(
        android.content.SharedPreferences.Editor editor,
        String key,
        String value
    ) {
        if (value != null && !value.trim().isEmpty()) editor.putString(key, value.trim());
    }

    private static JSObject parseIntent(Context context, Intent intent) {
        String action = intent.getAction();
        if (ACTION_OPEN_CHAT.equals(action)) {
            return targetEntry("open-chat", intent);
        }
        if (ACTION_OPEN_CHARACTER.equals(action)) {
            return targetEntry("open-character", intent);
        }
        if (Intent.ACTION_SEND.equals(action)) {
            return sharedTextEntry(context, intent, "share-text", Intent.EXTRA_TEXT);
        }
        if (Intent.ACTION_PROCESS_TEXT.equals(action)) {
            return sharedTextEntry(context, intent, "process-text", Intent.EXTRA_PROCESS_TEXT);
        }
        if (Intent.ACTION_VIEW.equals(action)) {
            return deepLinkEntry(intent.getData());
        }
        return null;
    }

    private static JSObject targetEntry(String type, Intent intent) {
        JSObject entry = new JSObject();
        entry.put("type", type);
        putIfPresent(entry, "characterId", intent.getStringExtra(EXTRA_CHARACTER_ID));
        putIfPresent(entry, "chatId", intent.getStringExtra(EXTRA_CHAT_ID));
        return entry;
    }

    private static JSObject sharedTextEntry(
        Context context,
        Intent intent,
        String type,
        String extraKey
    ) {
        CharSequence raw = intent.getCharSequenceExtra(extraKey);
        if (raw == null) return null;
        String text = limitSharedText(raw.toString());
        if (text.trim().isEmpty()) return null;
        JSObject entry = targetEntry(type, intent);
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            AndroidShortcutManager.applyShareTarget(context, intent, entry);
        }
        entry.put("text", text);
        putIfPresent(entry, "subject", intent.getStringExtra(Intent.EXTRA_SUBJECT));
        putIfPresent(entry, "mimeType", intent.getType());
        return entry;
    }
    private static JSObject deepLinkEntry(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        if (!"risu".equalsIgnoreCase(scheme) && !"co.aiclient.risu".equalsIgnoreCase(scheme)) {
            return null;
        }
        String host = uri.getHost();
        if (host == null) return null;
        List<String> segments = uri.getPathSegments();
        String first = segments.isEmpty() ? null : segments.get(0);
        JSObject entry = new JSObject();
        switch (host) {
            case "chat":
                entry.put("type", "open-chat");
                putIfPresent(entry, "chatId", first);
                putIfPresent(entry, "characterId", uri.getQueryParameter("character"));
                break;
            case "character":
                entry.put("type", "open-character");
                putIfPresent(entry, "characterId", first);
                break;
            case "new-chat":
                entry.put("type", "new-chat");
                putIfPresent(entry, "characterId", uri.getQueryParameter("character"));
                break;
            default:
                return null;
        }
        return entry;
    }
    private static void putIfPresent(JSObject object, String key, String value) {
        if (value == null) return;
        String normalized = value.trim();
        if (!normalized.isEmpty()) object.put(key, normalized);
    }

    private static String limitSharedText(String text) {
        if (text.length() <= MAX_SHARED_TEXT_LENGTH) return text;
        return text.substring(0, MAX_SHARED_TEXT_LENGTH);
    }
}
