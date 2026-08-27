package co.aiclient.risu;

import static org.junit.Assert.assertEquals;
import org.junit.Test;

public class BackupEntryPolicyTest {
    @Test
    public void classifiesCoreAndLegacyAssetEntries() {
        assertEquals(BackupEntryPolicy.Kind.DATABASE, BackupEntryPolicy.classify("database.risudat"));
        assertEquals(BackupEntryPolicy.Kind.ENCRYPTION, BackupEntryPolicy.classify("encryption.risudat"));
        assertEquals(BackupEntryPolicy.Kind.ASSET, BackupEntryPolicy.classify("avatar.png"));
        assertEquals(BackupEntryPolicy.Kind.ASSET, BackupEntryPolicy.classify("assets/avatar.png"));
        assertEquals(BackupEntryPolicy.Kind.ASSET, BackupEntryPolicy.classify("assets/folder/avatar.png"));
    }

    @Test
    public void recognizesColdStorageBeforeNamespaceFiltering() {
        assertEquals(BackupEntryPolicy.Kind.COLD_STORAGE, BackupEntryPolicy.classify(
            "coldstorage/11111111-1111-1111-1111-111111111111.json"
        ));
        assertEquals(BackupEntryPolicy.Kind.COLD_STORAGE, BackupEntryPolicy.classify(
            "coldstorage_22222222-2222-2222-2222-222222222222.json"
        ));
    }

    @Test
    public void ignoresUnknownForkNamespacesWithoutTreatingThemAsAssets() {
        assertEquals(BackupEntryPolicy.Kind.EXTENSION, BackupEntryPolicy.classify("inlay/abc.png"));
        assertEquals(BackupEntryPolicy.Kind.EXTENSION, BackupEntryPolicy.classify("inlay_sidecar/abc"));
        assertEquals(BackupEntryPolicy.Kind.EXTENSION, BackupEntryPolicy.classify("inlay_meta/abc"));
        assertEquals(BackupEntryPolicy.Kind.EXTENSION, BackupEntryPolicy.classify("another-fork/cache/item.bin"));
    }

    @Test
    public void rejectsTraversalAndMalformedPaths() {
        assertEquals(BackupEntryPolicy.Kind.INVALID, BackupEntryPolicy.classify("../escape.bin"));
        assertEquals(BackupEntryPolicy.Kind.INVALID, BackupEntryPolicy.classify("fork//item.bin"));
        assertEquals(BackupEntryPolicy.Kind.INVALID, BackupEntryPolicy.classify("/absolute.bin"));
    }
}
