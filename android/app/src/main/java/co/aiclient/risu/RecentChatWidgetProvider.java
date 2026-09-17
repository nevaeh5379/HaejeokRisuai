package co.aiclient.risu;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.view.View;
import android.widget.RemoteViews;

public class RecentChatWidgetProvider extends AppWidgetProvider {
    static final String PREFS_NAME = "risu_recent_chat_widget";
    static final String KEY_CHARACTER_ID = "character_id";
    static final String KEY_CHAT_ID = "chat_id";
    static final String KEY_CHARACTER_NAME = "character_name";
    static final String KEY_CHAT_NAME = "chat_name";
    static final String KEY_LAST_MESSAGE = "last_message";

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, manager, appWidgetId);
        }
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, RecentChatWidgetProvider.class);
        int[] ids = manager.getAppWidgetIds(component);
        for (int id : ids) updateWidget(context, manager, id);
    }

    private static void updateWidget(
        Context context,
        AppWidgetManager manager,
        int appWidgetId
    ) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String characterId = prefs.getString(KEY_CHARACTER_ID, null);
        String chatId = prefs.getString(KEY_CHAT_ID, null);
        String characterName = prefs.getString(
            KEY_CHARACTER_NAME,
            context.getString(R.string.app_name)
        );
        String chatName = prefs.getString(KEY_CHAT_NAME, "");
        String lastMessage = prefs.getString(KEY_LAST_MESSAGE, "");

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_recent_chat);
        views.setTextViewText(R.id.widget_character_name, characterName);
        views.setTextViewText(R.id.widget_chat_name, chatName);
        views.setTextViewText(
            R.id.widget_last_message,
            lastMessage == null || lastMessage.trim().isEmpty()
                ? context.getString(R.string.widget_open_recent_chat)
                : lastMessage
        );
        views.setViewVisibility(
            R.id.widget_chat_name,
            chatName == null || chatName.trim().isEmpty() ? View.GONE : View.VISIBLE
        );
        views.setOnClickPendingIntent(
            R.id.widget_root,
            openChatIntent(context, characterId, chatId, appWidgetId)
        );
        manager.updateAppWidget(appWidgetId, views);
    }

    private static PendingIntent openChatIntent(
        Context context,
        String characterId,
        String chatId,
        int requestCode
    ) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (characterId != null && chatId != null) {
            intent.setAction(NativeIntegrationPlugin.ACTION_OPEN_CHAT);
            intent.putExtra(NativeIntegrationPlugin.EXTRA_CHARACTER_ID, characterId);
            intent.putExtra(NativeIntegrationPlugin.EXTRA_CHAT_ID, chatId);
        }
        return PendingIntent.getActivity(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }
}
