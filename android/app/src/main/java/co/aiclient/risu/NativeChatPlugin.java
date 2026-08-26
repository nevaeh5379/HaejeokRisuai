package co.aiclient.risu;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "NativeChat",
    permissions = {
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class NativeChatPlugin extends Plugin {
    private static final int MAX_NOTIFICATION_BODY = 320;

    @PluginMethod
    public void begin(PluginCall call) {
        Context context = getContext();
        Intent intent = new Intent(context, ChatForegroundService.class);
        intent.setAction(ChatForegroundService.ACTION_START);
        try {
            ContextCompat.startForegroundService(context, intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to start background chat", error);
        }
    }

    @PluginMethod
    public void end(PluginCall call) {
        stopGenerationService();
        call.resolve();
    }

    @PluginMethod
    public void complete(PluginCall call) {
        stopGenerationService();
        if (Boolean.TRUE.equals(call.getBoolean("notify", false)) && canNotify()) {
            showResultNotification(
                call.getString("title", getContext().getString(R.string.app_name)),
                call.getString("body", getContext().getString(R.string.chat_result_ready))
            );
        }
        call.resolve();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || canNotify()) {
            resolvePermission(call, true);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        resolvePermission(call, getPermissionState("notifications") == PermissionState.GRANTED);
    }

    private void resolvePermission(PluginCall call, boolean granted) {
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    private boolean canNotify() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ActivityCompat.checkSelfPermission(
                getContext(),
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED;
    }

    private void stopGenerationService() {
        Context context = getContext();
        context.stopService(new Intent(context, ChatForegroundService.class));
    }

    private void showResultNotification(String title, String body) {
        ChatForegroundService.createNotificationChannels(getContext());
        String safeBody = body == null ? "" : body.trim().replaceAll("\\s+", " ");
        if (safeBody.isEmpty()) safeBody = getContext().getString(R.string.chat_result_ready);
        if (safeBody.length() > MAX_NOTIFICATION_BODY) {
            safeBody = safeBody.substring(0, MAX_NOTIFICATION_BODY - 1) + "…";
        }
        String safeTitle = title == null || title.trim().isEmpty()
            ? getContext().getString(R.string.app_name)
            : title.trim();
        Notification notification = new NotificationCompat.Builder(
            getContext(),
            ChatForegroundService.RESULT_CHANNEL_ID
        )
            .setSmallIcon(R.drawable.ic_stat_risu)
            .setContentTitle(safeTitle)
            .setContentText(safeBody)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(safeBody))
            .setContentIntent(ChatForegroundService.openAppIntent(getContext()))
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build();
        NotificationManager manager =
            (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        manager.notify(ChatForegroundService.RESULT_NOTIFICATION_ID, notification);
    }
}
