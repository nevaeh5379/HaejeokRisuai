package co.aiclient.risu;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.graphics.drawable.Icon;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

final class AndroidShortcutManager {
    static final String SHARE_CATEGORY = "co.aiclient.risu.category.SHARE_CHARACTER";
    private static final String PREFS_NAME = "risu_native_shortcuts";
    private static final String TARGET_PREFIX = "target:";
    private static final int DEFAULT_MAX_SHORTCUTS = 4;

    private AndroidShortcutManager() {}

    static int update(Context context, JSArray items) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return 0;
        ShortcutManager manager = context.getSystemService(ShortcutManager.class);
        if (manager == null) return 0;

        int platformMax = Math.max(1, manager.getMaxShortcutCountPerActivity());
        int limit = Math.min(DEFAULT_MAX_SHORTCUTS, platformMax);
        List<ShortcutInfo> shortcuts = new ArrayList<>();
        SharedPreferences.Editor mappings = context
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .clear();

        for (int index = 0; index < items.length() && shortcuts.size() < limit; index++) {
            JSONObject item = items.optJSONObject(index);
            if (item == null) continue;
            String characterId = normalized(item.optString("characterId", null));
            String chatId = normalized(item.optString("chatId", null));
            String label = normalized(item.optString("label", null));
            if (characterId == null || chatId == null || label == null) continue;

            String shortcutId = "chat:" + chatId;
            Intent intent = new Intent(context, MainActivity.class)
                .setAction(NativeIntegrationPlugin.ACTION_OPEN_CHAT)
                .putExtra(NativeIntegrationPlugin.EXTRA_CHARACTER_ID, characterId)
                .putExtra(NativeIntegrationPlugin.EXTRA_CHAT_ID, chatId);
            Set<String> categories = new HashSet<>();
            categories.add(SHARE_CATEGORY);

            ShortcutInfo.Builder builder = new ShortcutInfo.Builder(context, shortcutId)
                .setShortLabel(label)
                .setLongLabel(label)
                .setIcon(Icon.createWithResource(context, R.mipmap.ic_launcher))
                .setCategories(categories)
                .setIntent(intent);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setLongLived(true);
            }
            shortcuts.add(builder.build());
            mappings.putString(TARGET_PREFIX + shortcutId, characterId + "\n" + chatId);
        }

        mappings.apply();
        manager.setDynamicShortcuts(shortcuts);
        return shortcuts.size();
    }

    static void applyShareTarget(Context context, Intent intent, JSObject target) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N_MR1) return;
        String shortcutId = intent.getStringExtra(Intent.EXTRA_SHORTCUT_ID);
        if (shortcutId == null || shortcutId.isEmpty()) return;
        String stored = context
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .getString(TARGET_PREFIX + shortcutId, null);
        if (stored == null) return;
        int separator = stored.indexOf('\n');
        if (separator <= 0 || separator >= stored.length() - 1) return;
        target.put("characterId", stored.substring(0, separator));
        target.put("chatId", stored.substring(separator + 1));
    }

    private static String normalized(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
