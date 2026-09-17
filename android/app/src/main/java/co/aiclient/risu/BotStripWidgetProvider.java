package co.aiclient.risu;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import java.util.List;

public class BotStripWidgetProvider extends AppWidgetProvider {
    private static final String ACTION_PREVIOUS =
        "co.aiclient.risu.widget.BOT_STRIP_PREVIOUS";
    private static final String ACTION_NEXT =
        "co.aiclient.risu.widget.BOT_STRIP_NEXT";
    private static final String PREFS_NAME = "risu_bot_strip_widget";

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

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (!ACTION_PREVIOUS.equals(action) && !ACTION_NEXT.equals(action)) return;
        int appWidgetId = intent.getIntExtra(
            AppWidgetManager.EXTRA_APPWIDGET_ID,
            AppWidgetManager.INVALID_APPWIDGET_ID
        );
        if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) return;
        changePage(context, appWidgetId, ACTION_NEXT.equals(action) ? 1 : -1);
    }

    @Override
    public void onDeleted(Context context, int[] appWidgetIds) {
        SharedPreferences.Editor editor = prefs(context).edit();
        for (int id : appWidgetIds) editor.remove(pageKey(id));
        editor.apply();
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, BotStripWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(component)) updateWidget(context, manager, id);
    }

    private static void changePage(Context context, int appWidgetId, int delta) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        List<AndroidWidgetStore.Item> items = AndroidWidgetStore.load(context);
        int pageSize = visibleCount(manager.getAppWidgetOptions(appWidgetId));
        int pageCount = Math.max(1, (items.size() + pageSize - 1) / pageSize);
        int current = prefs(context).getInt(pageKey(appWidgetId), 0);
        int next = Math.floorMod(current + delta, pageCount);
        prefs(context).edit().putInt(pageKey(appWidgetId), next).apply();
        updateWidget(context, manager, appWidgetId);
    }

    private static int visibleCount(Bundle options) {
        int width = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 280);
        if (width >= 390) return 4;
        if (width >= 285) return 3;
        return 2;
    }

    private static void updateWidget(Context context, AppWidgetManager manager, int appWidgetId) {
        List<AndroidWidgetStore.Item> items = AndroidWidgetStore.load(context);
        int pageSize = visibleCount(manager.getAppWidgetOptions(appWidgetId));
        int pageCount = Math.max(1, (items.size() + pageSize - 1) / pageSize);
        int page = Math.min(
            prefs(context).getInt(pageKey(appWidgetId), 0),
            pageCount - 1
        );
        prefs(context).edit().putInt(pageKey(appWidgetId), page).apply();

        RemoteViews views = new RemoteViews(
            context.getPackageName(),
            R.layout.widget_bot_strip
        );
        views.removeAllViews(R.id.widget_strip_items);
        int start = page * pageSize;
        int end = Math.min(items.size(), start + pageSize);
        for (int index = start; index < end; index++) {
            AndroidWidgetStore.Item item = items.get(index);
            RemoteViews card = createCard(context, item, appWidgetId * 100 + index);
            views.addView(R.id.widget_strip_items, card);
        }

        boolean paged = pageCount > 1;
        views.setViewVisibility(R.id.widget_strip_previous, paged ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_strip_next, paged ? View.VISIBLE : View.GONE);
        if (paged) {
            views.setOnClickPendingIntent(
                R.id.widget_strip_previous,
                pageIntent(context, appWidgetId, ACTION_PREVIOUS, 1)
            );
            views.setOnClickPendingIntent(
                R.id.widget_strip_next,
                pageIntent(context, appWidgetId, ACTION_NEXT, 2)
            );
        }
        manager.updateAppWidget(appWidgetId, views);
    }

    private static RemoteViews createCard(
        Context context,
        AndroidWidgetStore.Item item,
        int requestCode
    ) {
        RemoteViews card = new RemoteViews(
            context.getPackageName(),
            R.layout.widget_bot_strip_card
        );
        card.setTextViewText(R.id.widget_strip_card_name, item.characterName);
        Bitmap artwork = AndroidWidgetStore.decodeIcon(item);
        if (artwork != null) {
            card.setImageViewBitmap(R.id.widget_strip_card_image, artwork);
        } else {
            card.setImageViewResource(R.id.widget_strip_card_image, R.mipmap.ic_launcher);
        }
        card.setOnClickPendingIntent(
            R.id.widget_strip_card_root,
            AndroidWidgetStore.openChatIntent(context, item, requestCode)
        );
        return card;
    }

    private static PendingIntent pageIntent(
        Context context,
        int appWidgetId,
        String action,
        int offset
    ) {
        Intent intent = new Intent(context, BotStripWidgetProvider.class)
            .setAction(action)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        return PendingIntent.getBroadcast(
            context,
            appWidgetId * 10 + offset,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    private static String pageKey(int appWidgetId) {
        return "page_" + appWidgetId;
    }
}
