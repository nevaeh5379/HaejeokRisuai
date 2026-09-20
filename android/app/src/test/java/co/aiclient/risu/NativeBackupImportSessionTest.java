package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import co.aiclient.risu.NativeBackupPlugin.ImportSession;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.Test;

public class NativeBackupImportSessionTest {
    private static File createSessionDirectory(
        boolean withStagedAssets
    ) throws IOException {
        Path directory = Files.createTempDirectory("risu-import-session");
        if (withStagedAssets) {
            Path staging = Files.createDirectory(directory.resolve("assets"));
            Files.createFile(staging.resolve("staged.bin"));
        }
        Files.createFile(directory.resolve("special.risubackup"));
        return directory.toFile();
    }

    private static ImportSession containerSession(
        File directory,
        int assetsWritten,
        boolean committed
    ) {
        ImportSession session = new ImportSession(
            directory,
            new File(directory, "special.risubackup"),
            new File(directory, "assets"),
            42L,
            assetsWritten,
            false
        );
        session.committed = committed;
        return session;
    }

    private static ImportSession rawSession(File directory) {
        return new ImportSession(
            directory,
            new File(directory, "raw.risubackup"),
            null,
            12L,
            0,
            true
        );
    }

    @Test
    public void rawSessionsNeverNeedCommit() throws IOException {
        File directory = createSessionDirectory(false);
        ImportSession session = rawSession(directory);
        assertFalse(NativeBackupPlugin.needsCommit(session));
    }

    @Test
    public void uncommittedContainerSessionsNeedCommit() throws IOException {
        File directory = createSessionDirectory(true);
        ImportSession session = containerSession(directory, 1, false);
        assertTrue(NativeBackupPlugin.needsCommit(session));
    }

    @Test
    public void committedContainerSessionsAreIdempotent() throws IOException {
        File directory = createSessionDirectory(true);
        ImportSession session = containerSession(directory, 1, false);
        session.committed = true;
        assertFalse(NativeBackupPlugin.needsCommit(session));
    }

    @Test
    public void sessionsWithoutStagedAssetsNeverNeedCommit() throws IOException {
        File directory = createSessionDirectory(false);
        ImportSession session = rawSession(directory);
        assertFalse(NativeBackupPlugin.needsCommit(session));
    }

    @Test
    public void discardRemovesStagedAssetsAndSpecialFile() throws IOException {
        File directory = createSessionDirectory(true);
        ImportSession session = containerSession(directory, 1, false);

        NativeBackupPlugin.discardImportSession(session);

        assertFalse(directory.exists());
    }

    @Test
    public void discardIsSafeForMissingSessionDirectories() {
        File missingDirectory = new File("/nonexistent/risu-import-session");
        ImportSession session = rawSession(missingDirectory);

        NativeBackupPlugin.discardImportSession(session);

        assertFalse(session.specialFile.exists());
    }
}