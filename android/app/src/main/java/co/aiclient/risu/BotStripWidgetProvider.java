package co.aiclient.risu;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

public class BotStripWidgetProvider extends AppWidgetProvider {
    private static final int[] CELL_IDS = {
        R.id.widget_strip_cell_0, R.id.widget_strip_cell_1,
        R.id.widget_strip_cell_2, R.id.widget_strip_cell_3
    };
    private static final int[] ICON_IDS = {
        R.id.widget_strip_icon_0, R.id.widget_strip_icon_1,
        R.id.widget_strip_icon_2, R.id.widget_strip_icon_3
    };
    private static final int[] NAME_IDS = {
        R.id.widget_strip_name_0, R.id.widget_strip_name_1,
        R.id.widget_strip_name_2, R.id.widget_strip_name_3
    };

    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) updateWidget(context, manager, appWidgetId);
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, BotStripWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(component)) updateWidget(context, manager, id);
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        List<AndroidWidgetStore.Item> items = AndroidWidgetStore.load(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_bot_strip);
        for (int index = 0; index < CELL_IDS.length; index++) {
            if (index >= items.size()) {
                views.setViewVisibility(CELL_IDS[index], View.INVISIBLE);
                continue;
            }
            AndroidWidgetStore.Item item = items.get(index);
            views.setViewVisibility(CELL_IDS[index], View.VISIBLE);
            views.setTextViewText(NAME_IDS[index], item.characterName);
            Bitmap icon = AndroidWidgetStore.decodeIcon(item);
            if (icon != null) views.setImageViewBitmap(ICON_IDS[index], icon);
            else views.setImageViewResource(ICON_IDS[index], R.mipmap.ic_launcher);
            views.setOnClickPendingIntent(
                CELL_IDS[index],
                AndroidWidgetStore.openChatIntent(context, item, appWidgetId * 10 + index)
            );
        }
        manager.updateAppWidget(appWidgetId, views);
    }
}
