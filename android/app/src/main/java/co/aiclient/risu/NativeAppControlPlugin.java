package co.aiclient.risu;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeAppControl")
public class NativeAppControlPlugin extends Plugin {
    @PluginMethod
    public void getSafeMode(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", ((MainActivity) getActivity()).isSafeMode());
        call.resolve(result);
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().finishAndRemoveTask();
            call.resolve(new JSObject());
        });
    }
}
