package co.aiclient.risu;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.widget.RemoteViews;

public class CompactChatWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, manager, appWidgetId);
        }
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, CompactChatWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(component)) {
            updateWidget(context, manager, id);
        }
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        AndroidWidgetStore.Item item = AndroidWidgetStore.first(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_compact_chat);

        String name = item == null ? context.getString(R.string.app_name) : item.characterName;
        views.setTextViewText(R.id.widget_compact_name, name);
        Bitmap icon = AndroidWidgetStore.decodeIcon(item);
        if (icon != null) {
            views.setImageViewBitmap(R.id.widget_compact_icon, icon);
        } else {
            views.setImageViewResource(R.id.widget_compact_icon, R.mipmap.ic_launcher);
        }
        views.setOnClickPendingIntent(
            R.id.widget_compact_root,
            AndroidWidgetStore.openChatIntent(context, item, appWidgetId)
        );
        manager.updateAppWidget(appWidgetId, views);
    }
}
