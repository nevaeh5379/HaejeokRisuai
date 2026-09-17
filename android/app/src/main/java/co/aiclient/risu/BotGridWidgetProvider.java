package co.aiclient.risu;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

public class BotGridWidgetProvider extends AppWidgetProvider {
    private static final int[] COLUMN_IDS = {
        R.id.widget_bot_column_0, R.id.widget_bot_column_1,
        R.id.widget_bot_column_2, R.id.widget_bot_column_3
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
        List<AndroidWidgetStore.Item> items = AndroidWidgetStore.load(context);
        int count = Math.min(items.size(), AndroidWidgetStore.MAX_ITEMS);

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_bot_grid);
        for (int columnIndex = 0; columnIndex < COLUMN_IDS.length; columnIndex++) {
            views.removeAllViews(COLUMN_IDS[columnIndex]);
            views.setViewVisibility(COLUMN_IDS[columnIndex], View.GONE);
        }
        if (count == 0) {
            manager.updateAppWidget(appWidgetId, views);
            return;
        }

        Bitmap[] artwork = new Bitmap[count];
        float[] aspectRatios = new float[count];
        for (int index = 0; index < count; index++) {
            artwork[index] = AndroidWidgetStore.decodeIcon(items.get(index));
            aspectRatios[index] = aspectRatio(artwork[index]);
        }
        WidgetGridLayoutPlanner.Plan plan = WidgetGridLayoutPlanner.choose(
            width,
            height,
            aspectRatios
        );
        for (int column = 0; column < plan.columns; column++) {
            views.setViewVisibility(COLUMN_IDS[column], View.VISIBLE);
        }

        int requestCode = appWidgetId * 100;
        for (int itemIndex = 0; itemIndex < count; itemIndex++) {
            Bitmap bitmap = artwork[itemIndex];
            float cardHeight = estimatedHeight(bitmap, plan.columnWidth);
            RemoteViews card = createCard(
                context,
                items.get(itemIndex),
                bitmap,
                cardHeight,
                requestCode + itemIndex
            );
            views.addView(COLUMN_IDS[plan.itemColumns[itemIndex]], card);
        }
        manager.updateAppWidget(appWidgetId, views);
    }

    private static float aspectRatio(Bitmap bitmap) {
        if (bitmap == null || bitmap.getWidth() <= 0 || bitmap.getHeight() <= 0) return 1f;
        return bitmap.getHeight() / (float) bitmap.getWidth();
    }

    private static float estimatedHeight(Bitmap bitmap, float width) {
        if (bitmap == null || bitmap.getWidth() <= 0 || bitmap.getHeight() <= 0) return width;
        return width * bitmap.getHeight() / (float) bitmap.getWidth();
    }

    private static RemoteViews createCard(
        Context context,
        AndroidWidgetStore.Item item,
        Bitmap artwork,
        float cardHeight,
        int requestCode
    ) {
        RemoteViews card = new RemoteViews(context.getPackageName(), R.layout.widget_bot_card);
        card.setTextViewText(R.id.widget_bot_card_name, item.characterName);
        card.setViewVisibility(
            R.id.widget_bot_card_name,
            cardHeight >= 52f ? View.VISIBLE : View.GONE
        );
        if (artwork != null) {
            card.setImageViewBitmap(R.id.widget_bot_card_image, artwork);
        } else {
            card.setImageViewResource(R.id.widget_bot_card_image, R.mipmap.ic_launcher);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            float resolvedHeight = Math.max(48f, cardHeight);
            card.setViewLayoutHeight(
                R.id.widget_bot_card_root,
                resolvedHeight,
                TypedValue.COMPLEX_UNIT_DIP
            );
            card.setViewLayoutHeight(
                R.id.widget_bot_card_image,
                resolvedHeight,
                TypedValue.COMPLEX_UNIT_DIP
            );
        }
        card.setOnClickPendingIntent(
            R.id.widget_bot_card_root,
            AndroidWidgetStore.openChatIntent(context, item, requestCode)
        );
        return card;
    }
}
