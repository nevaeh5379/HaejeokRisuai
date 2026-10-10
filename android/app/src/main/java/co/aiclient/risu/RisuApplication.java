package co.aiclient.risu;

import android.app.Application;

public final class RisuApplication extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        AndroidCrashDiagnostics.install(this);
    }
}
