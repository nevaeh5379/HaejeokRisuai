package co.aiclient.risu;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Debug;
import android.os.Process;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import androidx.annotation.RequiresApi;
import android.util.AtomicFile;
import android.util.Log;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

/** Local, bounded records that survive a dead Java process or WebView renderer. */
final class AndroidCrashDiagnostics {
    private static final String TAG = "RisuCrashDiagnostics";
    private static final int JOURNAL_BYTES = 12 * 1024;
    private static AndroidCrashDiagnostics instance;
    private final Context context;
    private final File directory;
    private final SharedPreferences prefs;
    // Release a small reserve before attempting to record OutOfMemoryError.
    private byte[] emergencyReserve = new byte[64 * 1024];
    private boolean recordingFatal;

    private AndroidCrashDiagnostics(Context context) {
        this.context = context.getApplicationContext();
        directory = new File(context.getFilesDir(), "crash-diagnostics");
        directory.mkdirs();
        prefs = context.getSharedPreferences("risu_crash_diagnostics", Context.MODE_PRIVATE);
    }

    static void install(Context context) {
        if (instance != null) return;
        try {
            instance = new AndroidCrashDiagnostics(context);
            final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
            Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
                instance.emergencyReserve = null;
                try {
                    instance.recordFatal(error);
                } catch (Throwable ignored) {
                    // A diagnostic failure must never prevent Android's original crash handler.
                } finally {
                    if (previous != null) previous.uncaughtException(thread, error);
                    else {
                        Process.killProcess(Process.myPid());
                        System.exit(10);
                    }
                }
            });
            instance.collectPreviousExit();
            instance.beginSession();
        } catch (Throwable error) {
            Log.w(TAG, "Crash diagnostics unavailable", error);
        }
    }

    static void checkpoint(String stage) {
        if (instance == null) return;
        try {
            instance.append(stage);
        } catch (Exception ignored) {}
    }

    static void rendererGone(boolean crashed, int priority) {
        if (instance == null) return;
        try {
            instance.saveReport("WebView renderer " + (crashed ? "crashed" : "was killed") +
                "\nrendererPriority=" + priority +
                "\nA killed renderer does not by itself prove an out-of-memory error.\n");
        } catch (Exception ignored) {}
    }

    static boolean hasPendingReport() {
        return instance != null && instance.prefs.getBoolean("pending", false)
            && instance.file("last-report.txt").isFile();
    }

    static String reportPreview() {
        if (instance == null) return "";
        try {
            String report = instance.read("last-report.txt", 48 * 1024);
            return report.substring(0, Math.min(1800, report.length()));
        } catch (IOException ignored) {
            return "";
        }
    }

    static void acknowledgeReport() {
        if (instance != null) instance.prefs.edit().putBoolean("pending", false).commit();
    }

    static void share(Activity activity) throws IOException {
        if (instance == null) throw new IOException("Crash diagnostics unavailable");
        String report = instance.header() + "\nLAST FAILURE\n" +
            instance.read("last-report.txt", 48 * 1024) + "\nLATEST ANDROID PROCESS EXIT\n" +
            instance.read("last-exit.txt", 4 * 1024) + "\nCURRENT SESSION\n" + instance.journal();
        File exportDirectory = new File(activity.getCacheDir(), "crash-diagnostics");
        if (!exportDirectory.isDirectory() && !exportDirectory.mkdirs()) {
            throw new IOException("Cannot create report directory");
        }
        File export = new File(exportDirectory, "risuai-crash-report.txt");
        try (FileOutputStream output = new FileOutputStream(export)) {
            output.write(report.getBytes(StandardCharsets.UTF_8));
        }
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", export);
        Intent intent = new Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.setClipData(ClipData.newRawUri("Crash report", uri));
        activity.startActivity(Intent.createChooser(intent, activity.getString(R.string.crash_report_share)));
    }

    private synchronized void recordFatal(Throwable error) throws IOException {
        if (recordingFatal) return;
        recordingFatal = true;
        saveReport(CrashReportFormatter.exceptionStack(error));
    }

    private synchronized void beginSession() throws IOException {
        write("session.old.log", "");
        write("session.log", header());
        prefs.edit().putLong("sessionStart", System.currentTimeMillis())
            .putInt("sessionPid", Process.myPid()).remove("startupStage").commit();
        append("native:application-created");
    }

    private synchronized void append(String stage) throws IOException {
        // Checkpoints are fixed operation labels, never SQL/binds, URLs or content.
        if (stage == null || stage.length() > 160 || !stage.matches("[a-zA-Z0-9:._= ,/-]+")) return;
        if (stage.startsWith("startup:")) prefs.edit().putString("startupStage", stage).commit();
        Runtime runtime = Runtime.getRuntime();
        String line = System.currentTimeMillis() + " " + stage + " javaUsed=" +
            (runtime.totalMemory() - runtime.freeMemory()) + " javaMax=" + runtime.maxMemory() +
            " nativeAllocated=" + Debug.getNativeHeapAllocatedSize() + "\n";
        File current = file("session.log");
        if (current.length() + line.length() > JOURNAL_BYTES) {
            write("session.old.log", read("session.log", JOURNAL_BYTES));
            write("session.log", "");
        }
        try (FileOutputStream output = new FileOutputStream(current, true)) {
            output.write(line.getBytes(StandardCharsets.UTF_8));
        }
    }

    private synchronized void saveReport(String failure) throws IOException {
        long now = System.currentTimeMillis();
        // Put the last operation near the top, so it is visible in the preview.
        String journal = journal();
        int lastStart = journal.lastIndexOf('\n', Math.max(0, journal.length() - 2));
        String last = journal.substring(lastStart + 1).trim();
        write("last-report.txt", "Recorded at=" + now + "\nLast checkpoint: " + last + "\n" +
            "Last startup stage: " + prefs.getString("startupStage", "not reached") + "\n" +
            failure + "\n\n" + journal);
        prefs.edit().putBoolean("pending", true).putLong("lastFailure", now).commit();
    }

    private void collectPreviousExit() throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) collectPreviousExitApi30();
    }

    @RequiresApi(30)
    private void collectPreviousExitApi30() throws IOException {
        long start = prefs.getLong("sessionStart", 0);
        if (start == 0) return; // No records from a version with diagnostics yet.
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        if (manager == null) return;
        try {
            List<ApplicationExitInfo> exits = manager.getHistoricalProcessExitReasons(null, 0, 8);
            for (ApplicationExitInfo exit : exits) {
                if (!context.getPackageName().equals(exit.getProcessName()) ||
                    exit.getPid() != prefs.getInt("sessionPid", -1) || exit.getTimestamp() < start) continue;
                String summary = "time=" + exit.getTimestamp() + " reason=" + reasonName(exit.getReason()) +
                    " (" + exit.getReason() + ") status=" + exit.getStatus() +
                    " importance=" + exit.getImportance() + "\npssKiB=" + exit.getPss() +
                    " rssKiB=" + exit.getRss() + " (Android last samples, not exact at death)" +
                    "\nlowMemoryKillReportSupported=" + manager.isLowMemoryKillReportSupported() + "\n";
                write("last-exit.txt", summary);
                if (prefs.getLong("lastFailure", 0) >= start && file("last-report.txt").isFile()) {
                    // Keep the Java stack / renderer record instead of overwriting it.
                    write("last-report.txt", read("last-report.txt", 20 * 1024) + "\nANDROID EXIT\n" + summary +
                        "\nSESSION BEFORE PROCESS EXIT\n" + journal());
                } else if (CrashReportFormatter.shouldNotify(exit.getReason(), exit.getImportance())) {
                    saveReport("Android recorded an unexpected process exit\n" + summary);
                }
                break;
            }
        } catch (RuntimeException error) {
            Log.w(TAG, "Android process exit history unavailable", error);
        }
    }

    private static String reasonName(int reason) {
        switch (reason) {
            case 0: return "UNKNOWN";
            case 1: return "EXIT_SELF";
            case 2: return "SIGNALED";
            case 3: return "LOW_MEMORY";
            case 4: return "CRASH";
            case 5: return "CRASH_NATIVE";
            case 6: return "ANR";
            case 7: return "INITIALIZATION_FAILURE";
            case 8: return "PERMISSION_CHANGE";
            case 9: return "EXCESSIVE_RESOURCE_USAGE";
            case 10: return "USER_REQUESTED";
            case 11: return "USER_STOPPED";
            case 12: return "DEPENDENCY_DIED";
            case 13: return "OTHER";
            case 14: return "FREEZER";
            case 15: return "PACKAGE_STATE_CHANGE";
            case 16: return "PACKAGE_UPDATED";
            default: return "UNRECOGNIZED";
        }
    }

    private String header() {
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        String version = "unknown";
        try {
            PackageInfo app = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            version = app.versionName + " code=" +
                (Build.VERSION.SDK_INT >= 28 ? app.getLongVersionCode() : app.versionCode);
        } catch (Exception ignored) {}
        String webView = "unknown";
        if (Build.VERSION.SDK_INT >= 26 && WebView.getCurrentWebViewPackage() != null) {
            webView = WebView.getCurrentWebViewPackage().versionName;
        }
        ActivityManager.MemoryInfo memory = new ActivityManager.MemoryInfo();
        if (manager != null) manager.getMemoryInfo(memory);
        return "RisuAI Android diagnostics v1\napp=" + version + " android=" + Build.VERSION.SDK_INT +
            " device=" + Build.MANUFACTURER + " " + Build.MODEL + " webView=" + webView +
            "\nmemoryClassMiB=" + (manager == null ? 0 : manager.getMemoryClass()) +
            " largeMemoryClassMiB=" + (manager == null ? 0 : manager.getLargeMemoryClass()) +
            " totalRam=" + memory.totalMem + " availableRam=" + memory.availMem +
            "\nMessages, prompts, API keys, SQL parameters and exception messages are not collected.\n";
    }

    private String journal() throws IOException {
        return read("session.old.log", JOURNAL_BYTES) + read("session.log", JOURNAL_BYTES);
    }

    private File file(String name) { return new File(directory, name); }

    private String read(String name, int limit) throws IOException {
        AtomicFile source = new AtomicFile(file(name));
        if (!source.getBaseFile().isFile()) return "(no record)\n";
        byte[] bytes = new byte[limit];
        int size = 0;
        try (FileInputStream input = source.openRead()) {
            while (size < limit) {
                int count = input.read(bytes, size, limit - size);
                if (count < 0) break;
                size += count;
            }
        }
        return new String(bytes, 0, size, StandardCharsets.UTF_8);
    }

    private void write(String name, String value) throws IOException {
        AtomicFile target = new AtomicFile(file(name));
        FileOutputStream output = target.startWrite();
        try {
            output.write(value.getBytes(StandardCharsets.UTF_8));
            target.finishWrite(output);
        } catch (IOException error) {
            target.failWrite(output);
            throw error;
        }
    }
}
