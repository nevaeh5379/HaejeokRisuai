package co.aiclient.risu;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

public class RecentChatWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) updateWidget(context, manager, appWidgetId);
    }

    @Override
    public void onAppWidgetOptionsChanged(
        Context context,
        AppWidgetManager manager,
        int appWidgetId,
        Bundle newOptions
    ) {
        updateWidget(context, manager, appWidgetId);
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, RecentChatWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(component)) updateWidget(context, manager, id);
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        AndroidWidgetStore.Item item = AndroidWidgetStore.first(context);
        Bundle options = manager.getAppWidgetOptions(appWidgetId);
        int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 220);
        int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 120);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_recent_chat);

        String characterName = item == null ? context.getString(R.string.app_name) : item.characterName;
        String chatName = item == null ? "" : item.chatName;
        String lastMessage = item == null ? "" : item.lastMessage;
        views.setTextViewText(R.id.widget_character_name, characterName);
        views.setTextViewText(R.id.widget_chat_name, chatName);
        views.setTextViewText(
            R.id.widget_last_message,
            lastMessage == null || lastMessage.trim().isEmpty()
                ? context.getString(R.string.widget_open_recent_chat)
                : lastMessage
        );
        boolean showChatName = width >= 190 && height >= 92 && chatName != null && !chatName.trim().isEmpty();
        views.setViewVisibility(R.id.widget_chat_name, showChatName ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_last_message, height >= 118 ? View.VISIBLE : View.GONE);

        Bitmap icon = AndroidWidgetStore.decodeIcon(item);
        if (icon != null) views.setImageViewBitmap(R.id.widget_character_icon, icon);
        else views.setImageViewResource(R.id.widget_character_icon, R.mipmap.ic_launcher);
        views.setOnClickPendingIntent(
            R.id.widget_root,
            AndroidWidgetStore.openChatIntent(context, item, appWidgetId)
        );
        manager.updateAppWidget(appWidgetId, views);
    }
}
