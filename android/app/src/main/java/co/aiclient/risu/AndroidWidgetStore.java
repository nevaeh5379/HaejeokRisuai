package co.aiclient.risu;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import com.getcapacitor.JSArray;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

final class AndroidWidgetStore {
    static final String PREFS_NAME = "risu_recent_chat_widget";
    static final int MAX_ITEMS = 8;
    private static final String KEY_COUNT = "item_count";

    static final class Item {
        final String characterId;
        final String chatId;
        final String characterName;
        final String chatName;
        final String lastMessage;
        final String iconData;

        Item(
            String characterId,
            String chatId,
            String characterName,
            String chatName,
            String lastMessage,
            String iconData
        ) {
            this.characterId = characterId;
            this.chatId = chatId;
            this.characterName = characterName;
            this.chatName = chatName;
            this.lastMessage = lastMessage;
            this.iconData = iconData;
        }
    }

    private AndroidWidgetStore() {}

    static void save(Context context, JSArray items) {
        SharedPreferences.Editor editor = context
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .clear();
        int stored = 0;
        for (int index = 0; index < items.length() && stored < MAX_ITEMS; index++) {
            JSONObject item = items.optJSONObject(index);
            if (item == null) continue;
            String characterId = normalized(item.optString("characterId", null));
            String chatId = normalized(item.optString("chatId", null));
            if (characterId == null || chatId == null) continue;
            String prefix = prefix(stored);
            editor.putString(prefix + "character_id", characterId);
            editor.putString(prefix + "chat_id", chatId);
            editor.putString(prefix + "character_name", item.optString("characterName", "RisuAI"));
            editor.putString(prefix + "chat_name", item.optString("chatName", ""));
            editor.putString(prefix + "last_message", trimMessage(item.optString("lastMessage", "")));
            String iconData = item.isNull("iconData")
                ? null
                : normalized(item.optString("iconData", null));
            if (iconData != null) editor.putString(prefix + "icon_data", iconData);
            stored++;
        }
        editor.putInt(KEY_COUNT, stored).apply();
        updateAll(context);
    }

    static List<Item> load(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int count = Math.min(MAX_ITEMS, Math.max(0, prefs.getInt(KEY_COUNT, 0)));
        List<Item> items = new ArrayList<>(count);
        for (int index = 0; index < count; index++) {
            String prefix = prefix(index);
            String characterId = normalized(prefs.getString(prefix + "character_id", null));
            String chatId = normalized(prefs.getString(prefix + "chat_id", null));
            if (characterId == null || chatId == null) continue;
            items.add(new Item(
                characterId,
                chatId,
                prefs.getString(prefix + "character_name", "RisuAI"),
                prefs.getString(prefix + "chat_name", ""),
                prefs.getString(prefix + "last_message", ""),
                prefs.getString(prefix + "icon_data", null)
            ));
        }
        return items;
    }

    static Item first(Context context) {
        List<Item> items = load(context);
        return items.isEmpty() ? null : items.get(0);
    }

    static Bitmap decodeIcon(Item item) {
        if (item == null || item.iconData == null) return null;
        try {
            int comma = item.iconData.indexOf(',');
            String encoded = comma >= 0 ? item.iconData.substring(comma + 1) : item.iconData;
            byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException ignored) {
            return null;
        }
    }

    static PendingIntent openChatIntent(Context context, Item item, int requestCode) {
        Intent intent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (item != null) {
            intent.setAction(NativeIntegrationPlugin.ACTION_OPEN_CHAT)
                .putExtra(NativeIntegrationPlugin.EXTRA_CHARACTER_ID, item.characterId)
                .putExtra(NativeIntegrationPlugin.EXTRA_CHAT_ID, item.chatId);
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    static void updateAll(Context context) {
        RecentChatWidgetProvider.updateAll(context);
        CompactChatWidgetProvider.updateAll(context);
        BotGridWidgetProvider.updateAll(context);
        BotStripWidgetProvider.updateAll(context);
    }

    private static String prefix(int index) {
        return "item_" + index + "_";
    }

    private static String trimMessage(String value) {
        if (value == null) return "";
        return value.length() > 500 ? value.substring(0, 500) : value;
    }

    private static String normalized(String value) {
        if (value == null) return null;
        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
