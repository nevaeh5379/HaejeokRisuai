package co.aiclient.risu;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import java.util.Arrays;

public class MainActivity extends BridgeActivity {


    @Override
    protected void onCreate(Bundle savedInstanceState) {
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
            getBridge().setWebViewClient(new RisuWebViewClient(getBridge(), getApplicationContext()));
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
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleNativeIntent(intent);
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
