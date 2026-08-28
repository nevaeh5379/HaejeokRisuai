package co.aiclient.risu;

import android.os.Bundle;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(StreamedFetchPlugin.class);
        registerPlugin(StreamFileWriterPlugin.class);
        registerPlugin(NativeBackupPlugin.class);
        registerPlugin(NativeSqlitePlugin.class);
        registerPlugin(NativeImagePlugin.class);
        registerPlugin(NativeChatPlugin.class);
        registerPlugin(NativeAppControlPlugin.class);
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
