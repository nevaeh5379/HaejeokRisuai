<script lang="ts">
    import { language } from "src/lang";
    import { alertConfirm, alertError, alertNormal } from "src/ts/alert";
    import { loadInternalBackup } from "src/ts/globalApi.svelte";
    import { isTauri, isNodeServer } from "src/ts/platform";
    import { checkDriver } from "src/ts/drive/drive";
    import { LoadLocalBackup, SaveLocalBackup, SavePartialLocalBackup } from "src/ts/drive/backuplocal";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import {
        DEFAULT_LOCAL_BACKUP_PERFORMANCE,
        LOCAL_BACKUP_PERFORMANCE_LIMITS,
    } from "src/ts/storage/backup/localBackupPerformance";
    import { exportAsDataset } from "src/ts/storage/backup/exportAsDataset";
    import { cleanColdStorage } from "src/ts/process/coldstorage.svelte";
    import { migrateLocalInlaysToServer } from "src/ts/process/files/inlays";
    import Help from "src/lib/Others/Help.svelte";
    import CollapsibleSettingsSection from "src/lib/Setting/Wrappers/CollapsibleSettingsSection.svelte";
    import { requestedSettingAnchor } from "src/ts/setting/searchIndex";

    let inlayMigrating = $state(false);
    let backupSaveOpen = $state(true);
    let backupRestoreOpen = $state(true);
    let dataToolsOpen = $state(false);
    let localBackupPerformanceOpen = $state(false);

    $effect(() => {
        const anchor = $requestedSettingAnchor;
        if (!anchor) return;
        if (anchor.startsWith("backup.save")) {
            backupSaveOpen = true;
        } else if (anchor.startsWith("backup.load")) {
            backupRestoreOpen = true;
        } else if (
            anchor.startsWith("backup.clean") ||
            anchor.startsWith("backup.inlay") ||
            anchor.startsWith("backup.export")
        ) {
            dataToolsOpen = true;
        } else if (anchor.startsWith("backup.performance")) {
            localBackupPerformanceOpen = true;
        }
    });

    function resetLocalBackupPerformance() {
        settingsStore.state.localBackupDatabasePageRecords = DEFAULT_LOCAL_BACKUP_PERFORMANCE.databasePageRecords;
        settingsStore.state.localBackupFragmentRecords = DEFAULT_LOCAL_BACKUP_PERFORMANCE.fragmentRecords;
        settingsStore.state.localBackupWriterBufferKiB = DEFAULT_LOCAL_BACKUP_PERFORMANCE.writerBufferKiB;
        settingsStore.state.localBackupProgressUpdateMs = DEFAULT_LOCAL_BACKUP_PERFORMANCE.progressUpdateMs;
    }

    async function runInlayMigration() {
        if (inlayMigrating) return;
        inlayMigrating = true;
        try {
            const result = await migrateLocalInlaysToServer();
            if (result.failed > 0) {
                alertError(language.inlayMigrationPartial(result.migrated, result.failed));
            } else {
                alertNormal(language.inlayMigrationDone(result.migrated));
            }
        } catch (error) {
            alertError(error);
        } finally {
            inlayMigrating = false;
        }
    }

    async function uploadInlayImages() {
        if (inlayMigrating) return;
        if (await alertConfirm(language.inlayMigrationConfirm)) {
            await runInlayMigration();
        }
    }

    async function saveNativeBackup() {
        if (await alertConfirm(language.backupConfirm)) {
            SaveLocalBackup("native");
        }
    }

    async function saveCompatibleBackup() {
        if (await alertConfirm(language.backupConfirm)) {
            SaveLocalBackup("compatible");
        }
    }

    async function saveDriveBackup() {
        if (await alertConfirm(language.backupConfirm)) {
            localStorage.setItem("backup", "save");
            checkDriver(isTauri || isNodeServer ? "savetauri" : "save");
        }
    }

    async function restoreLocalBackup() {
        if (
            (await alertConfirm(language.backupLoadConfirm)) &&
            (await alertConfirm(language.backupLoadConfirm2))
        ) {
            LoadLocalBackup();
        }
    }

    async function restoreInternalBackup() {
        if (
            (await alertConfirm(language.backupLoadConfirm)) &&
            (await alertConfirm(language.backupLoadConfirm2))
        ) {
            loadInternalBackup();
        }
    }

    async function loadDriveBackup() {
        if (
            (await alertConfirm(language.backupLoadConfirm)) &&
            (await alertConfirm(language.backupLoadConfirm2))
        ) {
            localStorage.setItem("backup", "load");
            checkDriver(isTauri || isNodeServer ? "loadtauri" : "load");
        }
    }

    async function cleanUnusedColdStorage() {
        if (await alertConfirm(language.cleanColdStorageConfirm)) {
            cleanColdStorage();
        }
    }
</script>

{#snippet backupAction(anchorId: string, helpKey: keyof typeof language.help, action: () => void, label: string)}
    <div class="flex items-center gap-2" data-setting-id={anchorId}>
        <Button className="grow" onclick={action}>{label}</Button>
        <Help key={helpKey} />
    </div>
{/snippet}

<h2 class="mb-2 text-2xl font-bold mt-2">{language.data} & {language.backup}</h2>

<div class="flex max-w-3xl flex-col gap-5">
    <CollapsibleSettingsSection
        title={language.backupSaveSection}
        help="backupSaveSection"
        bind:open={backupSaveOpen}
    >
        {@render backupAction("backup.saveNative", "saveBackupLocalNative", saveNativeBackup, language.saveBackupLocalNative)}
        {@render backupAction("backup.saveCompatible", "saveBackupLocalCompatible", saveCompatibleBackup, language.saveBackupLocalCompatible)}
        {@render backupAction("backup.savePartial", "savePartialLocalBackup", SavePartialLocalBackup, language.savePartialLocalBackup)}
        {@render backupAction("backup.saveDrive", "savebackup", saveDriveBackup, language.savebackup)}
    </CollapsibleSettingsSection>

    <CollapsibleSettingsSection
        anchorId="backup.performance"
        title={language.localBackupPerformanceTitle}
        bind:open={localBackupPerformanceOpen}
    >
        <div class="grid gap-3 md:grid-cols-2">
            <div>
                <div class="flex items-center gap-1">
                    <label class="text-xs font-medium text-textcolor2" for="local-backup-page-records">{language.localBackupDatabasePageRecords}</label>
                    <Help key="localBackupDatabasePageRecords" />
                </div>
                <NumberInput
                    id="local-backup-page-records"
                    bind:value={settingsStore.state.localBackupDatabasePageRecords}
                    min={LOCAL_BACKUP_PERFORMANCE_LIMITS.databasePageRecords.min}
                    max={LOCAL_BACKUP_PERFORMANCE_LIMITS.databasePageRecords.max}
                    fullwidth={true}
                    className="mt-1"
                />
            </div>
            <div>
                <div class="flex items-center gap-1">
                    <label class="text-xs font-medium text-textcolor2" for="local-backup-fragment-records">{language.localBackupFragmentRecords}</label>
                    <Help key="localBackupFragmentRecords" />
                </div>
                <NumberInput
                    id="local-backup-fragment-records"
                    bind:value={settingsStore.state.localBackupFragmentRecords}
                    min={LOCAL_BACKUP_PERFORMANCE_LIMITS.fragmentRecords.min}
                    max={LOCAL_BACKUP_PERFORMANCE_LIMITS.fragmentRecords.max}
                    fullwidth={true}
                    className="mt-1"
                />
            </div>
            <div>
                <div class="flex items-center gap-1">
                    <label class="text-xs font-medium text-textcolor2" for="local-backup-writer-buffer">{language.localBackupWriterBufferKiB}</label>
                    <Help key="localBackupWriterBufferKiB" />
                </div>
                <NumberInput
                    id="local-backup-writer-buffer"
                    bind:value={settingsStore.state.localBackupWriterBufferKiB}
                    min={LOCAL_BACKUP_PERFORMANCE_LIMITS.writerBufferKiB.min}
                    max={LOCAL_BACKUP_PERFORMANCE_LIMITS.writerBufferKiB.max}
                    fullwidth={true}
                    className="mt-1"
                />
            </div>
            <div>
                <div class="flex items-center gap-1">
                    <label class="text-xs font-medium text-textcolor2" for="local-backup-progress-interval">{language.localBackupProgressUpdateMs}</label>
                    <Help key="localBackupProgressUpdateMs" />
                </div>
                <NumberInput
                    id="local-backup-progress-interval"
                    bind:value={settingsStore.state.localBackupProgressUpdateMs}
                    min={LOCAL_BACKUP_PERFORMANCE_LIMITS.progressUpdateMs.min}
                    max={LOCAL_BACKUP_PERFORMANCE_LIMITS.progressUpdateMs.max}
                    fullwidth={true}
                    className="mt-1"
                />
            </div>
        </div>
        <Button styled="outlined" size="sm" onclick={resetLocalBackupPerformance}>
            {language.localBackupPerformanceReset}
        </Button>
    </CollapsibleSettingsSection>

    <CollapsibleSettingsSection
        title={language.backupRestoreSection}
        help="backupRestoreSection"
        bind:open={backupRestoreOpen}
    >
        {@render backupAction("backup.loadLocal", "loadBackupLocal", restoreLocalBackup, language.loadBackupLocal)}
        {@render backupAction("backup.loadInternal", "loadInternalBackup", restoreInternalBackup, language.loadInternalBackup)}
        {@render backupAction("backup.loadDrive", "loadbackup", loadDriveBackup, language.loadbackup)}
    </CollapsibleSettingsSection>

    <CollapsibleSettingsSection
        title={language.dataToolsSection}
        help="dataToolsSection"
        bind:open={dataToolsOpen}
    >
        {@render backupAction("backup.cleanColdStorage", "cleanColdStorage", cleanUnusedColdStorage, language.cleanColdStorage)}
        {#if isNodeServer}
            <div class="flex items-center gap-2" data-setting-id="backup.inlayMigration">
                <Button className="grow" disabled={inlayMigrating} onclick={uploadInlayImages}>
                    {inlayMigrating ? language.inlayMigrationRunning : language.inlayMigrationButton}
                </Button>
                <Help key="inlayMigration" />
            </div>
        {/if}
        {@render backupAction("backup.exportDataset", "exportAsDataset", exportAsDataset, language.exportAsDataset)}
    </CollapsibleSettingsSection>
</div>