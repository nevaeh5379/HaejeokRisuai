package co.aiclient.risu;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebView;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.core.splashscreen.SplashScreen;
import androidx.lifecycle.Lifecycle;

import com.getcapacitor.BridgeActivity;

import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    public static final String ACTION_SAFE_MODE = "co.aiclient.risu.action.SAFE_MODE";
    private static final String STATE_SAFE_MODE = "haejeok_safe_mode";
    private boolean safeMode;
    private final AndroidSafeArea safeArea = new AndroidSafeArea();
    private AlertDialog crashReportDialog;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        safeMode = ACTION_SAFE_MODE.equals(getIntent().getAction())
            || (savedInstanceState != null && savedInstanceState.getBoolean(STATE_SAFE_MODE));
        SplashScreen.installSplashScreen(this);
        // Hybrid E2E tools need a debuggable WebView context to inspect the
        // bundled Capacitor UI. Never expose it from release builds.
        WebView.setWebContentsDebuggingEnabled(
                (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0
        );
        registerPlugins(
                Arrays.asList(
                        StreamedFetchPlugin.class,
                        StreamFileWriterPlugin.class,
                        NativeBackupPlugin.class,
                        NativeSqlitePlugin.class,
                        NativeImagePlugin.class,
                        NativeChatPlugin.class,
                        NativeAppControlPlugin.class,
                        NativeIntegrationPlugin.class,
                        NativeUpdaterPlugin.class,
                        CrashGuardPlugin.class
                ));
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (getBridge() == null || getBridge().getWebView() == null) {
                    finish();
                    return;
                }
                getBridge().getWebView().evaluateJavascript(
                        "window.dispatchEvent(new Event('risu:android-back'))",
                        null
                );
            }
        });
    }

    @Override
    protected void load() {
        // Do not create/load the bridge until the report is reviewed. A boot
        // crash loop must still allow sharing a report without running JS/SQL.
        if (AndroidCrashDiagnostics.hasPendingReport()) {
            showCrashReport(this::loadRisuBridge);
        } else {
            loadRisuBridge();
        }
    }

    private void loadRisuBridge() {
        AndroidCrashDiagnostics.checkpoint("native:bridge-loading");
        super.load();
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            safeArea.install(webView);
            getBridge().setWebViewClient(new RisuWebViewClient(
                getBridge(), getApplicationContext(), safeArea::onPageFinished
            ));
            // Deferred creation happens after the Activity lifecycle callbacks.
            if (getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED)) {
                getBridge().onStart();
            }
            if (getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.RESUMED)) {
                getBridge().getApp().fireStatusChange(true);
                getBridge().onResume();
            }
        }
        handleNativeIntent(getIntent());
    }

    void showRendererRecovery() {
        showCrashReport(this::recreate);
    }

    private void showCrashReport(Runnable continueLoading) {
        if (isFinishing() || isDestroyed() || crashReportDialog != null) return;
        TextView text = new TextView(this);
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        text.setPadding(padding, padding, padding, padding);
        text.setText(getString(R.string.crash_report_message) + "\n\n" + AndroidCrashDiagnostics.reportPreview());
        text.setTextIsSelectable(true);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(text);
        crashReportDialog = new AlertDialog.Builder(this)
            .setTitle(R.string.crash_report_title)
            .setView(scroll)
            .setCancelable(false)
            .setPositiveButton(R.string.crash_report_continue, (dialog, which) -> {
                AndroidCrashDiagnostics.acknowledgeReport();
                crashReportDialog = null;
                continueLoading.run();
            })
            .setNegativeButton(R.string.safe_mode_shortcut, (dialog, which) -> {
                AndroidCrashDiagnostics.acknowledgeReport();
                safeMode = true;
                getIntent().setAction(ACTION_SAFE_MODE);
                crashReportDialog = null;
                continueLoading.run();
            })
            .setNeutralButton(R.string.crash_report_share, null)
            .create();
        crashReportDialog.show();
        // Sharing/cancelling the chooser must not dismiss/acknowledge the report.
        crashReportDialog.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(view -> {
            try {
                AndroidCrashDiagnostics.share(this);
            } catch (Exception error) {
                Toast.makeText(this, R.string.crash_report_share_failed, Toast.LENGTH_LONG).show();
            }
        });
    }

    @Override
    public void onDestroy() {
        if (crashReportDialog != null) crashReportDialog.dismiss();
        super.onDestroy();
    }

    @Override
    public void onResume() {
        super.onResume();
        AndroidCrashDiagnostics.checkpoint("native:activity-resumed");
        NativeIntegrationPlugin.applySavedSystemBarAppearance(this);
    }

    @Override
    public void onPause() {
        AndroidCrashDiagnostics.checkpoint("native:activity-paused");
        super.onPause();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        NativeIntegrationPlugin.applySavedSystemBarAppearance(this);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().requestApplyInsets();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // BridgeActivity also dispatches the launch intent from load() during onCreate.
        if (ACTION_SAFE_MODE.equals(intent.getAction()) && !safeMode) {
            safeMode = true;
            recreate();
            return;
        }
        handleNativeIntent(intent);
    }

    @Override
    public void onSaveInstanceState(Bundle outState) {
        outState.putBoolean(STATE_SAFE_MODE, safeMode);
        super.onSaveInstanceState(outState);
    }

    boolean isSafeMode() {
        return safeMode;
    }

    private void handleNativeIntent(Intent intent) {
        if (!NativeIntegrationPlugin.enqueueIntent(getApplicationContext(), intent)) return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new Event('risu:native-entry-available'))",
                null
        );
    }
}
