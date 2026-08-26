package co.aiclient.risu;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

public class ChatForegroundService extends Service {
    public static final String ACTION_START = "co.aiclient.risu.action.START_CHAT_GENERATION";
    public static final String ACTION_STOP = "co.aiclient.risu.action.STOP_CHAT_GENERATION";
    public static final String GENERATION_CHANNEL_ID = "risu_chat_generation";
    public static final String RESULT_CHANNEL_ID = "risu_chat_results";
    public static final int FOREGROUND_NOTIFICATION_ID = 7101;
    public static final int RESULT_NOTIFICATION_ID = 7102;
    private static final long MAX_WAKE_LOCK_MS = 30L * 60L * 1000L;

    private PowerManager.WakeLock wakeLock;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireWakeLock();
        startForeground(FOREGROUND_NOTIFICATION_ID, buildGenerationNotification(this));
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) return;
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = manager.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            getPackageName() + ":chat-generation"
        );
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire(MAX_WAKE_LOCK_MS);
    }

    public static void createNotificationChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel generation = new NotificationChannel(
            GENERATION_CHANNEL_ID,
            context.getString(R.string.chat_generation_channel),
            NotificationManager.IMPORTANCE_LOW
        );
        generation.setDescription(context.getString(R.string.chat_generation_active));
        manager.createNotificationChannel(generation);

        NotificationChannel result = new NotificationChannel(
            RESULT_CHANNEL_ID,
            context.getString(R.string.chat_result_channel),
            NotificationManager.IMPORTANCE_DEFAULT
        );
        manager.createNotificationChannel(result);
    }

    public static PendingIntent openAppIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    private static Notification buildGenerationNotification(Context context) {
        return new NotificationCompat.Builder(context, GENERATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_risu)
            .setContentTitle(context.getString(R.string.app_name))
            .setContentText(context.getString(R.string.chat_generation_active))
            .setContentIntent(openAppIntent(context))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }
}
