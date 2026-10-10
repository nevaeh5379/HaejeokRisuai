package co.aiclient.risu;

/** Bounded diagnostics: exception messages may contain SQL, prompts or credentials. */
final class CrashReportFormatter {
    private CrashReportFormatter() {}

    static String exceptionStack(Throwable error) {
        StringBuilder text = new StringBuilder();
        for (int depth = 0; error != null && depth < 5; depth++) {
            text.append(depth == 0 ? "Exception: " : "Caused by: ")
                .append(error.getClass().getName()).append('\n');
            StackTraceElement[] frames = error.getStackTrace();
            for (int index = 0; index < Math.min(frames.length, 48); index++) {
                text.append("  at ").append(frames[index]).append('\n');
            }
            if (frames.length > 48) text.append("  [remaining frames omitted]\n");
            Throwable cause = error.getCause();
            if (cause == error) break;
            error = cause;
        }
        return text.toString();
    }

    static boolean shouldNotify(int reason, int importance) {
        // ApplicationExitInfo constants, kept here so policy is JVM-testable.
        // CRASH, CRASH_NATIVE, ANR, INITIALIZATION_FAILURE, EXCESSIVE_RESOURCE_USAGE.
        if (reason >= 4 && reason <= 7 || reason == 9) return true;
        // UNKNOWN, SIGNALED, LOW_MEMORY, DEPENDENCY_DIED: foreground/visible only.
        // Cached-process eviction and explicit user stops are ordinary lifecycle events.
        return (reason == 0 || reason == 2 || reason == 3 || reason == 12)
            && importance > 0 && importance <= 200;
    }
}
