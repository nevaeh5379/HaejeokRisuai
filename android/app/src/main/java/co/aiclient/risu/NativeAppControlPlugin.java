package co.aiclient.risu;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativeAppControl")
public class NativeAppControlPlugin extends Plugin {
    @PluginMethod
    public void exitApp(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            getActivity().finishAndRemoveTask();
            call.resolve(new JSObject());
        });
    }
}
