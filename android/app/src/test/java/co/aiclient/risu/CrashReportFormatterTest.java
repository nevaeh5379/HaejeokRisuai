package co.aiclient.risu;

import static org.junit.Assert.*;
import org.junit.Test;

public class CrashReportFormatterTest {
    @Test
    public void preservesExceptionTypeAndCallSiteWithoutUserData() {
        Throwable cause = new OutOfMemoryError("secret prompt and API key");
        cause.setStackTrace(new StackTraceElement[] {
            new StackTraceElement("co.aiclient.risu.NativeSqlitePlugin", "queryRows", "NativeSqlitePlugin.java", 471)
        });
        String report = CrashReportFormatter.exceptionStack(new RuntimeException("SQL with private bind", cause));
        assertTrue(report.contains("java.lang.OutOfMemoryError"));
        assertTrue(report.contains("NativeSqlitePlugin.java:471"));
        assertFalse(report.contains("secret prompt"));
        assertFalse(report.contains("private bind"));
    }

    @Test
    public void boundsDeepAndCyclicExceptionStacks() {
        RuntimeException first = new RuntimeException();
        RuntimeException second = new RuntimeException();
        first.initCause(second);
        second.initCause(first);
        StackTraceElement[] frames = new StackTraceElement[1000];
        for (int index = 0; index < frames.length; index++) {
            frames[index] = new StackTraceElement("Example", "run", "Example.java", index);
        }
        first.setStackTrace(frames);
        second.setStackTrace(frames);
        String report = CrashReportFormatter.exceptionStack(first);
        assertTrue(report.contains("remaining frames omitted"));
        assertFalse(report.contains("Example.java:999"));
        assertTrue(report.length() < 20000);
    }

    @Test
    public void distinguishesForegroundFailuresFromOrdinaryProcessEvictionAndUserStops() {
        assertTrue(CrashReportFormatter.shouldNotify(4, 400)); // Java crash even in background
        assertTrue(CrashReportFormatter.shouldNotify(5, 100)); // native crash
        assertTrue(CrashReportFormatter.shouldNotify(6, 100)); // ANR
        assertTrue(CrashReportFormatter.shouldNotify(3, 100)); // foreground LMK
        assertTrue(CrashReportFormatter.shouldNotify(2, 200)); // visible signal, cause uncertain
        assertFalse(CrashReportFormatter.shouldNotify(3, 400)); // ordinary cached process eviction
        assertFalse(CrashReportFormatter.shouldNotify(3, 0)); // no importance evidence
        assertFalse(CrashReportFormatter.shouldNotify(10, 100)); // explicit force stop
        assertFalse(CrashReportFormatter.shouldNotify(11, 100));
        assertFalse(CrashReportFormatter.shouldNotify(1, 100)); // app exit
        assertFalse(CrashReportFormatter.shouldNotify(16, 100)); // package update
    }
}
