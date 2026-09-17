package co.aiclient.risu;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

public class RisuQuickSettingsTileService extends TileService {
    @Override
    public void onStartListening() {
        super.onStartListening();
        Tile tile = getQsTile();
        if (tile == null) return;

        SharedPreferences prefs = getSharedPreferences(
            RecentChatWidgetProvider.PREFS_NAME,
            MODE_PRIVATE
        );
        String characterName = prefs.getString(
            RecentChatWidgetProvider.KEY_CHARACTER_NAME,
            null
        );
        tile.setLabel(getString(R.string.quick_settings_tile_label));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.setSubtitle(characterName == null ? "" : characterName);
        }
        tile.setState(Tile.STATE_ACTIVE);
        tile.updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        SharedPreferences prefs = getSharedPreferences(
            RecentChatWidgetProvider.PREFS_NAME,
            MODE_PRIVATE
        );
        String characterId = prefs.getString(RecentChatWidgetProvider.KEY_CHARACTER_ID, null);
        String chatId = prefs.getString(RecentChatWidgetProvider.KEY_CHAT_ID, null);

        Intent intent = new Intent(this, MainActivity.class);
        intent.addFlags(
            Intent.FLAG_ACTIVITY_NEW_TASK |
            Intent.FLAG_ACTIVITY_CLEAR_TOP |
            Intent.FLAG_ACTIVITY_SINGLE_TOP
        );
        if (chatId != null && !chatId.trim().isEmpty()) {
            intent.setAction(NativeIntegrationPlugin.ACTION_OPEN_CHAT);
            intent.putExtra(NativeIntegrationPlugin.EXTRA_CHAT_ID, chatId.trim());
            if (characterId != null && !characterId.trim().isEmpty()) {
                intent.putExtra(NativeIntegrationPlugin.EXTRA_CHARACTER_ID, characterId.trim());
            }
        }
        launchAndCollapse(intent, chatId);
    }

    @SuppressWarnings("deprecation")
    @SuppressLint("StartActivityAndCollapseDeprecated")
    private void launchAndCollapse(Intent intent, String chatId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            PendingIntent pendingIntent = PendingIntent.getActivity(
                this,
                chatId == null ? 0 : chatId.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
            startActivityAndCollapse(pendingIntent);
            return;
        }
        startActivityAndCollapse(intent);
    }
}
