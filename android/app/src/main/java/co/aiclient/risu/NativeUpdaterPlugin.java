package co.aiclient.risu;

import android.content.Intent;
import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "NativeUpdater")
public class NativeUpdaterPlugin extends Plugin {
    private static final String UPDATE_MANIFEST_URL =
        "https://github.com/nevaeh5379/HaejeokRisuai/releases/latest/download/android-update.json";
    private static final int BUFFER_SIZE = 256 * 1024;
    private static final int MAX_MANIFEST_BYTES = 256 * 1024;
    private static final long MAX_APK_BYTES = 512L * 1024L * 1024L;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final long PROGRESS_INTERVAL_MS = 100L;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void check(PluginCall call) {
        executor.execute(() -> {
            try {
                UpdateManifest update = fetchManifest();
                long currentCode = getCurrentVersionCode();
                JSObject result = new JSObject();
                result.put("available", update.versionCode > currentCode);
                result.put("currentVersion", getCurrentVersionName());
                result.put("latestVersion", update.version);
                result.put("latestVersionCode", update.versionCode);
                call.resolve(result);
            } catch (Exception error) {
                call.reject("Failed to check for Android updates", error);
            }
        });
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        executor.execute(() -> {
            try {
                UpdateManifest update = fetchManifest();
                if (update.versionCode <= getCurrentVersionCode()) {
                    call.reject("The installed version is already up to date");
                    return;
                }
                File apk = downloadUpdate(update);
                getActivity().runOnUiThread(() -> beginInstall(call, apk));
            } catch (Exception error) {
                call.reject("Failed to download Android update", error);
            }
        });
    }

    @ActivityCallback
    private void unknownSourcesResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        File apk = getUpdateApkFile();
        if (!apk.isFile()) {
            call.reject("Downloaded update APK is missing");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !getContext().getPackageManager().canRequestPackageInstalls()) {
            call.reject("Permission to install updates was not granted");
            return;
        }
        launchInstaller(call, apk);
    }

    private void beginInstall(PluginCall call, File apk) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent permissionIntent = new Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + getContext().getPackageName())
            );
            startActivityForResult(call, permissionIntent, "unknownSourcesResult");
            return;
        }
        launchInstaller(call, apk);
    }

    private void launchInstaller(PluginCall call, File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                apk
            );
            Intent intent = new Intent(Intent.ACTION_INSTALL_PACKAGE);
            intent.setData(uri);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Failed to open the Android package installer", error);
        }
    }

    private UpdateManifest fetchManifest() throws Exception {
        HttpURLConnection connection = openConnection(UPDATE_MANIFEST_URL);
        try {
            long declaredLength = connection.getContentLengthLong();
            if (declaredLength > MAX_MANIFEST_BYTES) {
                throw new IllegalStateException("Update manifest is too large");
            }
            try (
                InputStream input = new BufferedInputStream(connection.getInputStream());
                ByteArrayOutputStream output = new ByteArrayOutputStream()
            ) {
                byte[] buffer = new byte[16 * 1024];
                int total = 0;
                int read;
                while ((read = input.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_MANIFEST_BYTES) {
                        throw new IllegalStateException("Update manifest is too large");
                    }
                    output.write(buffer, 0, read);
                }
                JSONObject json = new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
                return UpdateManifest.fromJson(json);
            }
        } finally {
            connection.disconnect();
        }
    }

    private File downloadUpdate(UpdateManifest update) throws Exception {
        File updatesDir = new File(getContext().getCacheDir(), "updates");
        if (!updatesDir.mkdirs() && !updatesDir.isDirectory()) {
            throw new IllegalStateException("Failed to create update cache directory");
        }
        File partial = new File(updatesDir, "RisuAI-update.apk.part");
        File destination = getUpdateApkFile();
        if (partial.exists() && !partial.delete()) {
            throw new IllegalStateException("Failed to replace partial update");
        }
        if (destination.exists() && !destination.delete()) {
            throw new IllegalStateException("Failed to replace cached update");
        }

        HttpURLConnection connection = openConnection(update.url);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        long totalBytes = connection.getContentLengthLong();
        if (totalBytes > MAX_APK_BYTES) {
            connection.disconnect();
            throw new IllegalStateException("Android update APK is too large");
        }
        long downloaded = 0L;
        long lastProgressAt = 0L;
        try (
            InputStream input = new BufferedInputStream(connection.getInputStream());
            BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(partial))
        ) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) {
                output.write(buffer, 0, read);
                digest.update(buffer, 0, read);
                downloaded += read;
                if (downloaded > MAX_APK_BYTES) {
                    throw new IllegalStateException("Android update APK is too large");
                }
                long now = System.currentTimeMillis();
                if (now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
                    notifyProgress(downloaded, totalBytes);
                    lastProgressAt = now;
                }
            }
        } catch (Exception error) {
            partial.delete();
            throw error;
        } finally {
            connection.disconnect();
        }

        String actualSha256 = toHex(digest.digest());
        if (!actualSha256.equalsIgnoreCase(update.sha256)) {
            partial.delete();
            throw new SecurityException("Downloaded update SHA-256 does not match release metadata");
        }
        try {
            validateDownloadedApk(partial, update);
        } catch (Exception error) {
            partial.delete();
            throw error;
        }
        if (!partial.renameTo(destination)) {
            copyFile(partial, destination);
            if (!partial.delete()) partial.deleteOnExit();
        }
        notifyProgress(downloaded, downloaded);
        return destination;
    }

    private void validateDownloadedApk(File apk, UpdateManifest update) throws Exception {
        PackageInfo archive = getContext().getPackageManager()
            .getPackageArchiveInfo(apk.getAbsolutePath(), 0);
        if (archive == null) {
            throw new SecurityException("Downloaded update is not a valid APK");
        }
        if (!getContext().getPackageName().equals(archive.packageName)) {
            throw new SecurityException("Downloaded update belongs to a different application");
        }
        long archiveCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? archive.getLongVersionCode()
            : archive.versionCode;
        if (archiveCode != update.versionCode) {
            throw new SecurityException("Downloaded update versionCode does not match release metadata");
        }
        String archiveVersion = archive.versionName == null ? "" : archive.versionName;
        if (!archiveVersion.equals(update.version)) {
            throw new SecurityException("Downloaded update versionName does not match release metadata");
        }
    }

    private void notifyProgress(long downloaded, long total) {
        JSObject progress = new JSObject();
        progress.put("bytesDownloaded", downloaded);
        progress.put("totalBytes", Math.max(total, 0L));
        progress.put(
            "percent",
            total > 0L ? Math.min(100.0, downloaded * 100.0 / total) : 0.0
        );
        notifyListeners("downloadProgress", progress);
    }

    private HttpURLConnection openConnection(String url) throws Exception {
        URL parsed = new URL(url);
        if (!"https".equalsIgnoreCase(parsed.getProtocol())) {
            throw new SecurityException("Update URLs must use HTTPS");
        }
        HttpURLConnection connection = (HttpURLConnection) parsed.openConnection();
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(READ_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("Accept", "application/json, application/octet-stream");
        connection.setRequestProperty("User-Agent", "RisuAI-Android-Updater");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            connection.disconnect();
            throw new IllegalStateException("Update server returned HTTP " + status);
        }
        return connection;
    }

    private File getUpdateApkFile() {
        return new File(new File(getContext().getCacheDir(), "updates"), "RisuAI-update.apk");
    }

    private PackageInfo getPackageInfo() throws Exception {
        return getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
    }

    private long getCurrentVersionCode() throws Exception {
        PackageInfo info = getPackageInfo();
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? info.getLongVersionCode()
            : info.versionCode;
    }

    private String getCurrentVersionName() throws Exception {
        String version = getPackageInfo().versionName;
        return version == null ? "0.0.0" : version;
    }

    private static void copyFile(File source, File destination) throws Exception {
        try (
            InputStream input = new FileInputStream(source);
            BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination))
        ) {
            byte[] buffer = new byte[BUFFER_SIZE];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        }
        return result.toString();
    }

    private static final class UpdateManifest {
        final String version;
        final long versionCode;
        final String url;
        final String sha256;

        UpdateManifest(String version, long versionCode, String url, String sha256) {
            this.version = version;
            this.versionCode = versionCode;
            this.url = url;
            this.sha256 = sha256;
        }

        static UpdateManifest fromJson(JSONObject json) throws Exception {
            String version = json.getString("version").trim();
            long versionCode = json.getLong("versionCode");
            String url = json.getString("url").trim();
            String sha256 = json.getString("sha256").trim().toLowerCase(Locale.ROOT);
            if (version.isEmpty() || versionCode <= 0L) {
                throw new IllegalArgumentException("Invalid Android update version");
            }
            if (!url.startsWith("https://")) {
                throw new SecurityException("Android update URL must use HTTPS");
            }
            if (!sha256.matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException("Invalid Android update SHA-256");
            }
            return new UpdateManifest(version, versionCode, url, sha256);
        }
    }
}
