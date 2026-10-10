package co.aiclient.risu;

import static org.junit.Assert.*;
import android.content.Context;
import android.content.ContextWrapper;
import android.content.SharedPreferences;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.lang.reflect.Field;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class AndroidCrashDiagnosticsTest {
    private Context isolated;
    private File directory;
    private Field singleton;
    private Object previousInstance;
    private Thread.UncaughtExceptionHandler previousHandler;

    @Before
    public void setUp() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        String id = "diagnostics-test-" + System.nanoTime();
        directory = new File(target.getCacheDir(), id);
        assertTrue(directory.mkdirs());
        isolated = new ContextWrapper(target) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getFilesDir() { return directory; }
            @Override public SharedPreferences getSharedPreferences(String name, int mode) {
                return super.getSharedPreferences(id + "-" + name, mode);
            }
        };
        singleton = AndroidCrashDiagnostics.class.getDeclaredField("instance");
        singleton.setAccessible(true);
        previousInstance = singleton.get(null);
        previousHandler = Thread.getDefaultUncaughtExceptionHandler();
        simulateNewProcess();
    }

    private void simulateNewProcess() throws Exception {
        Thread.setDefaultUncaughtExceptionHandler(previousHandler);
        singleton.set(null, null);
        AndroidCrashDiagnostics.install(isolated);
    }

    @After
    public void tearDown() throws Exception {
        Thread.setDefaultUncaughtExceptionHandler(previousHandler);
        singleton.set(null, previousInstance);
        isolated.getSharedPreferences("risu_crash_diagnostics", Context.MODE_PRIVATE).edit().clear().commit();
        deleteTestDirectory(directory);
    }

    private void deleteTestDirectory(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTestDirectory(child);
        file.delete();
    }

    @Test
    public void uncaughtExceptionPersistsStackAndDelegatesToOriginalHandler() throws Exception {
        Throwable failure = new OutOfMemoryError("private prompt must not appear");
        Throwable[] delegated = new Throwable[1];
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> delegated[0] = error);
        singleton.set(null, null);
        AndroidCrashDiagnostics.install(isolated);
        AndroidCrashDiagnostics.checkpoint("startup:sql-domains");
        Thread.getDefaultUncaughtExceptionHandler().uncaughtException(Thread.currentThread(), failure);
        assertSame(failure, delegated[0]);
        assertTrue(AndroidCrashDiagnostics.hasPendingReport());
        String preview = AndroidCrashDiagnostics.reportPreview();
        assertTrue(preview.contains("OutOfMemoryError"));
        assertTrue(preview.contains("startup:sql-domains"));
        assertFalse(preview.contains("private prompt"));
    }

    @Test
    public void rendererReportSurvivesRestartAndAcknowledgement() throws Exception {
        AndroidCrashDiagnostics.checkpoint("startup:sql-domains");
        AndroidCrashDiagnostics.rendererGone(false, 2);
        assertTrue(AndroidCrashDiagnostics.hasPendingReport());
        assertTrue(AndroidCrashDiagnostics.reportPreview().contains("startup:sql-domains"));
        assertTrue(AndroidCrashDiagnostics.reportPreview().contains("was killed"));
        simulateNewProcess();
        assertTrue(AndroidCrashDiagnostics.hasPendingReport());
        assertTrue(AndroidCrashDiagnostics.reportPreview().contains("startup:sql-domains"));
        AndroidCrashDiagnostics.acknowledgeReport();
        simulateNewProcess();
        assertFalse(AndroidCrashDiagnostics.hasPendingReport());
        assertTrue(AndroidCrashDiagnostics.reportPreview().contains("was killed"));
    }

    @Test
    public void journalRotationRetainsLatestWorkWithinDiskBudget() {
        AndroidCrashDiagnostics.checkpoint("startup:modules");
        for (int index = 0; index < 1000; index++) {
            AndroidCrashDiagnostics.checkpoint("sqlite:query-end rows=" + index);
        }
        File logs = new File(directory, "crash-diagnostics");
        assertTrue(new File(logs, "session.log").length() <= 12 * 1024);
        assertTrue(new File(logs, "session.old.log").length() <= 12 * 1024);
        AndroidCrashDiagnostics.rendererGone(true, 2);
        String preview = AndroidCrashDiagnostics.reportPreview();
        assertTrue(preview.contains("rows=999"));
        assertTrue(preview.contains("Last startup stage: startup:modules"));
    }

    @Test
    public void pendingReportPausesBridgeCreationIncludingActivityRecreation() {
        AndroidCrashDiagnostics.rendererGone(true, 2);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(main -> assertNull(main.getBridge()));
            activity.recreate();
            activity.onActivity(main -> assertNull(main.getBridge()));
        }
        assertTrue(AndroidCrashDiagnostics.hasPendingReport());
    }
}
