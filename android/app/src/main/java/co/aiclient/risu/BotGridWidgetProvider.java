package co.aiclient.risu;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.widget.RemoteViews;

public class BotGridWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager manager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            updateWidget(context, manager, appWidgetId);
        }
    }

    @Override
    public void onAppWidgetOptionsChanged(
        Context context,
        AppWidgetManager manager,
        int appWidgetId,
        android.os.Bundle newOptions
    ) {
        updateWidget(context, manager, appWidgetId);
    }

    static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName component = new ComponentName(context, BotGridWidgetProvider.class);
        for (int id : manager.getAppWidgetIds(component)) {
            updateWidget(context, manager, id);
        }
    }

    private static void updateWidget(
        Context context,
        AppWidgetManager manager,
        int appWidgetId
    ) {
        RemoteViews views = new RemoteViews(
            context.getPackageName(),
            R.layout.widget_bot_grid
        );
        Intent serviceIntent = new Intent(context, BotGridWidgetService.class)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId);
        serviceIntent.setData(Uri.parse(serviceIntent.toUri(Intent.URI_INTENT_SCHEME)));
        views.setRemoteAdapter(R.id.widget_bot_grid_collection, serviceIntent);
        views.setEmptyView(
            R.id.widget_bot_grid_collection,
            R.id.widget_bot_grid_empty
        );
        Intent templateIntent = new Intent(context, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags |= PendingIntent.FLAG_MUTABLE;
        }
        PendingIntent template = PendingIntent.getActivity(
            context,
            appWidgetId,
            templateIntent,
            flags
        );
        views.setPendingIntentTemplate(
            R.id.widget_bot_grid_collection,
            template
        );
        manager.updateAppWidget(appWidgetId, views);
        manager.notifyAppWidgetViewDataChanged(
            appWidgetId,
            R.id.widget_bot_grid_collection
        );
    }
}
