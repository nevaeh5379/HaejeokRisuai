package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import org.junit.Test;

public class StreamedFetchCancellationTest {
    private static final class Connection extends HttpURLConnection {
        int disconnects;

        Connection() throws Exception {
            super(new URL("https://example.test"));
        }

        @Override public void disconnect() { disconnects++; }
        @Override public void connect() {}
        @Override public boolean usingProxy() { return false; }
    }

    @Test
    public void cancellationDisconnectsAnActiveRequest() throws Exception {
        StreamedFetchPlugin.RequestState request = new StreamedFetchPlugin.RequestState();
        Connection connection = new Connection();
        request.attach(connection);
        request.cancel();
        assertEquals(1, connection.disconnects);
        assertThrows(IOException.class, request::throwIfCancelled);
    }

    @Test
    public void cancellationBeforeConnectionAttachmentCannotStartTransfer() throws Exception {
        StreamedFetchPlugin.RequestState request = new StreamedFetchPlugin.RequestState();
        request.cancel();
        Connection connection = new Connection();
        assertThrows(IOException.class, () -> request.attach(connection));
        assertEquals(1, connection.disconnects);
    }

    @Test
    public void cancellationBeforeWorkerStartupIsObserved() {
        StreamedFetchPlugin.RequestState request = new StreamedFetchPlugin.RequestState();
        request.cancel();
        assertThrows(IOException.class, request::throwIfCancelled);
    }
}
