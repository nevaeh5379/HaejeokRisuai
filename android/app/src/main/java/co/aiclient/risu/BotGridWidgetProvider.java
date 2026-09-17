package co.aiclient.risu;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

public class BotGridWidgetProvider extends AppWidgetProvider {
    private static final int[] ROW_IDS = {
        R.id.widget_bot_row_0, R.id.widget_bot_row_1
    };
    private static final int[] CELL_IDS = {
        R.id.widget_bot_cell_0, R.id.widget_bot_cell_1,
        R.id.widget_bot_cell_2, R.id.widget_bot_cell_3,
        R.id.widget_bot_cell_4, R.id.widget_bot_cell_5,
        R.id.widget_bot_cell_6, R.id.widget_bot_cell_7
    };
    private static final int[] ICON_IDS = {
        R.id.widget_bot_icon_0, R.id.widget_bot_icon_1,
        R.id.widget_bot_icon_2, R.id.widget_bot_icon_3,
        R.id.widget_bot_icon_4, R.id.widget_bot_icon_5,
        R.id.widget_bot_icon_6, R.id.widget_bot_icon_7
    };
    private static final int[] NAME_IDS = {
        R.id.widget_bot_name_0, R.id.widget_bot_name_1,
        R.id.widget_bot_name_2, R.id.widget_bot_name_3,
        R.id.widget_bot_name_4, R.id.widget_bot_name_5,
        R.id.widget_bot_name_6, R.id.widget_bot_name_7
    };

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
        ComponentName component = new ComponentName(context, BotGridWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(component)) updateWidget(context, manager, id);
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        Bundle options = manager.getAppWidgetOptions(appWidgetId);
        int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 220);
        int height = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 180);
        int columns = width >= 340 ? 4 : width >= 250 ? 3 : 2;
        int rows = height >= 240 ? 2 : 1;
        boolean showNames = height >= 118;
        List<AndroidWidgetStore.Item> items = AndroidWidgetStore.load(context);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_bot_grid);

        for (int rowId : ROW_IDS) views.setViewVisibility(rowId, View.GONE);
        for (int cellId : CELL_IDS) views.setViewVisibility(cellId, View.GONE);
        views.setViewVisibility(ROW_IDS[0], View.VISIBLE);
        if (rows > 1) views.setViewVisibility(ROW_IDS[1], View.VISIBLE);

        int capacity = Math.min(items.size(), columns * rows);
        for (int itemIndex = 0; itemIndex < capacity; itemIndex++) {
            int row = itemIndex / columns;
            int column = itemIndex % columns;
            int cellIndex = row * 4 + column;
            AndroidWidgetStore.Item item = items.get(itemIndex);
            views.setViewVisibility(CELL_IDS[cellIndex], View.VISIBLE);
            views.setTextViewText(NAME_IDS[cellIndex], item.characterName);
            views.setViewVisibility(NAME_IDS[cellIndex], showNames ? View.VISIBLE : View.GONE);
            Bitmap icon = AndroidWidgetStore.decodeIcon(item);
            if (icon != null) views.setImageViewBitmap(ICON_IDS[cellIndex], icon);
            else views.setImageViewResource(ICON_IDS[cellIndex], R.mipmap.ic_launcher);
            views.setOnClickPendingIntent(
                CELL_IDS[cellIndex],
                AndroidWidgetStore.openChatIntent(context, item, appWidgetId * 100 + itemIndex)
            );
        }
        manager.updateAppWidget(appWidgetId, views);
    }
}
