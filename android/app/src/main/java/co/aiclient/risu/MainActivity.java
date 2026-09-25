package co.aiclient.risu;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.res.Configuration;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.splashscreen.SplashScreen;

import com.getcapacitor.BridgeActivity;

import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    private final AndroidSafeArea safeArea = new AndroidSafeArea();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
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
                        NativeUpdaterPlugin.class
                ));
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            WebView webView = getBridge().getWebView();
            safeArea.install(webView);
            getBridge().setWebViewClient(new RisuWebViewClient(
                getBridge(),
                getApplicationContext(),
                safeArea::onPageFinished
            ));
        }
        handleNativeIntent(getIntent());
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
    public void onResume() {
        super.onResume();
        NativeIntegrationPlugin.applySavedSystemBarAppearance(this);
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
        handleNativeIntent(intent);
    }

    private void handleNativeIntent(Intent intent) {
        // The VIEW intent's URI grant (FLAG_GRANT_READ_URI_PERMISSION) is tied
        // to the activity, so the activity context must be used — the
        // application context has no grant and MediaStore queries return empty.
        if (!NativeIntegrationPlugin.enqueueIntent(this, intent)) return;
        if (getBridge() == null || getBridge().getWebView() == null) return;
        getBridge().getWebView().evaluateJavascript(
                "window.dispatchEvent(new Event('risu:native-entry-available'))",
                null
        );
    }
}
