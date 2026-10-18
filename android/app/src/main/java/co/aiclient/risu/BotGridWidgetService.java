package co.aiclient.risu;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.widget.RemoteViews;
import android.widget.RemoteViewsService;

import java.util.Collections;
import java.util.List;

public class BotGridWidgetService extends RemoteViewsService {
    @Override
    public RemoteViewsFactory onGetViewFactory(Intent intent) {
        return new Factory(getApplicationContext());
    }

    private static final class Factory implements RemoteViewsFactory {
        private final Context context;
        private List<AndroidWidgetStore.Item> items = Collections.emptyList();

        Factory(Context context) {
            this.context = context;
        }

        @Override
        public void onCreate() {
            onDataSetChanged();
        }

        @Override
        public void onDataSetChanged() {
            items = AndroidWidgetStore.load(context);
        }

        @Override
        public void onDestroy() {
            items = Collections.emptyList();
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public RemoteViews getViewAt(int position) {
            if (position < 0 || position >= items.size()) return null;
            AndroidWidgetStore.Item item = items.get(position);
            RemoteViews views = new RemoteViews(
                context.getPackageName(),
                R.layout.widget_bot_grid_item
            );
            views.setTextViewText(R.id.widget_bot_grid_item_name, item.characterName);
            Bitmap artwork = AndroidWidgetStore.decodeIcon(item);
            if (artwork != null) {
                views.setImageViewBitmap(R.id.widget_bot_grid_item_image, artwork);
            } else {
                views.setImageViewResource(R.id.widget_bot_grid_item_image, R.mipmap.ic_launcher);
            }
            Intent fillIn = new Intent()
                .setAction(NativeIntegrationPlugin.ACTION_OPEN_CHAT)
                .putExtra(NativeIntegrationPlugin.EXTRA_CHARACTER_ID, item.characterId)
                .putExtra(NativeIntegrationPlugin.EXTRA_CHAT_ID, item.chatId);
            views.setOnClickFillInIntent(R.id.widget_bot_grid_item_root, fillIn);
            return views;
        }

        @Override
        public RemoteViews getLoadingView() {
            return null;
        }

        @Override
        public int getViewTypeCount() {
            return 1;
        }

        @Override
        public long getItemId(int position) {
            if (position < 0 || position >= items.size()) return position;
            AndroidWidgetStore.Item item = items.get(position);
            return (item.characterId + "\u0000" + item.chatId).hashCode();
        }

        @Override
        public boolean hasStableIds() {
            return true;
        }
    }
}
