package co.aiclient.risu;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(StreamedFetchPlugin.class);
        registerPlugin(StreamFileWriterPlugin.class);
        registerPlugin(NativeBackupPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
