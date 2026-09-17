package co.aiclient.risu;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

public class CompactChatWidgetProvider extends AppWidgetProvider {
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
        ComponentName component = new ComponentName(context, CompactChatWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(component)) updateWidget(context, manager, id);
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        AndroidWidgetStore.Item item = AndroidWidgetStore.first(context);
        Bundle options = manager.getAppWidgetOptions(appWidgetId);
        int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 110);
        int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 110);
        boolean showName = height >= 108 && width >= 100;
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_compact_chat);

        String name = item == null ? context.getString(R.string.app_name) : item.characterName;
        views.setTextViewText(R.id.widget_compact_name, name);
        views.setViewVisibility(R.id.widget_compact_name, showName ? View.VISIBLE : View.GONE);
        Bitmap icon = AndroidWidgetStore.decodeIcon(item);
        if (icon != null) views.setImageViewBitmap(R.id.widget_compact_icon, icon);
        else views.setImageViewResource(R.id.widget_compact_icon, R.mipmap.ic_launcher);
        views.setOnClickPendingIntent(
            R.id.widget_compact_root,
            AndroidWidgetStore.openChatIntent(context, item, appWidgetId)
        );
        manager.updateAppWidget(appWidgetId, views);
    }
}
