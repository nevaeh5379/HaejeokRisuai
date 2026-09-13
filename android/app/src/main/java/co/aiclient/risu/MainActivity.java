package co.aiclient.risu;

import android.os.Bundle;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

import java.util.List;

public class MainActivity extends BridgeActivity {


    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugins(
                List.of(
                        StreamedFetchPlugin.class,
                        StreamFileWriterPlugin.class,
                        NativeBackupPlugin.class,
                        NativeSqlitePlugin.class,
                        NativeImagePlugin.class,
                        NativeChatPlugin.class,
                        NativeAppControlPlugin.class,
                        NativeUpdaterPlugin.class
                ));
        super.onCreate(savedInstanceState);
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().setWebViewClient(new RisuWebViewClient(getBridge(), getApplicationContext()));
        }
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
}
