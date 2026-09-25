package co.aiclient.risu;

import android.webkit.WebView;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

/** Publishes Android system-bar insets to the WebView as CSS variables. */
public final class AndroidSafeArea {
    private static final String CSS_VARIABLE = "--risu-safe-area-inset-bottom";

    private WebView webView;
    private int bottomInsetCssPx;
    private int appliedBottomInsetCssPx = -1;

    public void install(WebView target) {
        webView = target;
        ViewCompat.setOnApplyWindowInsetsListener(target, (view, windowInsets) -> {
            Insets navigationBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.navigationBars()
            );
            bottomInsetCssPx = windowInsets.isVisible(WindowInsetsCompat.Type.ime())
                ? 0
                : toCssPixels(
                    navigationBars.bottom,
                    view.getResources().getDisplayMetrics().density
                );
            applyToPage(false);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(target);
    }

    public void onPageFinished() {
        appliedBottomInsetCssPx = -1;
        applyToPage(true);
        if (webView != null) ViewCompat.requestApplyInsets(webView);
    }

    private void applyToPage(boolean force) {
        if (
            webView == null ||
            (!force && appliedBottomInsetCssPx == bottomInsetCssPx)
        ) return;
        appliedBottomInsetCssPx = bottomInsetCssPx;
        String script = "document.documentElement.classList.add('capacitor-android');" +
            "document.documentElement.style.setProperty('" + CSS_VARIABLE + "','" +
            bottomInsetCssPx + "px');";
        webView.post(() -> webView.evaluateJavascript(script, null));
    }

    static int toCssPixels(int devicePixels, float density) {
        if (density <= 0) return devicePixels;
        return Math.round(devicePixels / density);
    }
}
