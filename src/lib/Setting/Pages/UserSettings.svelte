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

    let inlayMigrating = $state(false);

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
</script>


<h2 class="mb-2 text-2xl font-bold mt-2">{language.files}</h2>

<div class="mt-2">
    <Button
        onclick={async () => {
            if(await alertConfirm(language.backupConfirm)){
                SaveLocalBackup('native')
            }
        }}>
        {language.saveBackupLocalNative}
    </Button>
    <p class="mt-1 text-xs text-textcolor2">{language.saveBackupLocalNativeDescription}</p>
</div>

<div class="mt-3 rounded-xl border border-darkborderc bg-darkbg/40 p-3">
    <h3 class="m-0 text-sm font-semibold text-textcolor">{language.localBackupPerformanceTitle}</h3>
    <div class="mt-3 grid gap-3 md:grid-cols-2">
        <div>
            <label class="block text-xs font-medium text-textcolor2" for="local-backup-page-records">{language.localBackupDatabasePageRecords}</label>
            <NumberInput
                id="local-backup-page-records"
                bind:value={settingsStore.state.localBackupDatabasePageRecords}
                min={LOCAL_BACKUP_PERFORMANCE_LIMITS.databasePageRecords.min}
                max={LOCAL_BACKUP_PERFORMANCE_LIMITS.databasePageRecords.max}
                fullwidth={true}
                className="mt-1"
            />
            <p class="mt-1 text-xs text-textcolor2">{language.localBackupDatabasePageRecordsDescription}</p>
        </div>
        <div>
            <label class="block text-xs font-medium text-textcolor2" for="local-backup-fragment-records">{language.localBackupFragmentRecords}</label>
            <NumberInput
                id="local-backup-fragment-records"
                bind:value={settingsStore.state.localBackupFragmentRecords}
                min={LOCAL_BACKUP_PERFORMANCE_LIMITS.fragmentRecords.min}
                max={LOCAL_BACKUP_PERFORMANCE_LIMITS.fragmentRecords.max}
                fullwidth={true}
                className="mt-1"
            />
            <p class="mt-1 text-xs text-textcolor2">{language.localBackupFragmentRecordsDescription}</p>
        </div>
        <div>
            <label class="block text-xs font-medium text-textcolor2" for="local-backup-writer-buffer">{language.localBackupWriterBufferKiB}</label>
            <NumberInput
                id="local-backup-writer-buffer"
                bind:value={settingsStore.state.localBackupWriterBufferKiB}
                min={LOCAL_BACKUP_PERFORMANCE_LIMITS.writerBufferKiB.min}
                max={LOCAL_BACKUP_PERFORMANCE_LIMITS.writerBufferKiB.max}
                fullwidth={true}
                className="mt-1"
            />
            <p class="mt-1 text-xs text-textcolor2">{language.localBackupWriterBufferKiBDescription}</p>
        </div>
        <div>
            <label class="block text-xs font-medium text-textcolor2" for="local-backup-progress-interval">{language.localBackupProgressUpdateMs}</label>
            <NumberInput
                id="local-backup-progress-interval"
                bind:value={settingsStore.state.localBackupProgressUpdateMs}
                min={LOCAL_BACKUP_PERFORMANCE_LIMITS.progressUpdateMs.min}
                max={LOCAL_BACKUP_PERFORMANCE_LIMITS.progressUpdateMs.max}
                fullwidth={true}
                className="mt-1"
            />
            <p class="mt-1 text-xs text-textcolor2">{language.localBackupProgressUpdateMsDescription}</p>
        </div>
    </div>
    <Button styled="outlined" size="sm" className="mt-3" onclick={resetLocalBackupPerformance}>
        {language.localBackupPerformanceReset}
    </Button>
</div>

<div class="mt-2">
    <Button
        onclick={async () => {
            if(await alertConfirm(language.backupConfirm)){
                SaveLocalBackup('compatible')
            }
        }}>
        {language.saveBackupLocalCompatible}
    </Button>
    <p class="mt-1 text-xs text-textcolor2">{language.saveBackupLocalCompatibleDescription}</p>
</div>

<Button
    onclick={async () => {
        if(await alertConfirm(language.backupConfirm)){
            SavePartialLocalBackup()
        }
    }} className="mt-2">
    {language.savePartialLocalBackup}
</Button>

<Button
    onclick={async () => {
        if((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))){
            LoadLocalBackup()
        }
    }} className="mt-2">
    {language.loadBackupLocal}
</Button>

<Button
    onclick={async () => {
        if((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))){
            loadInternalBackup()
        }
    }} className="mt-2">
    {language.loadInternalBackup}
</Button>

<Button
    onclick={async () => {
        if(await alertConfirm(language.cleanColdStorageConfirm)){
            cleanColdStorage()
        }
    }} className="mt-2">
    {language.cleanColdStorage}
</Button>

{#if isNodeServer}
    <Button
        onclick={async () => {
            if(await alertConfirm(language.inlayMigrationConfirm)){
                runInlayMigration()
            }
        }} className="mt-2" disabled={inlayMigrating}>
        {inlayMigrating ? language.inlayMigrationRunning : language.inlayMigrationButton}
    </Button>
    <p class="mt-1 text-xs text-textcolor2">{language.inlayMigrationDescription}</p>
{/if}

<Button
    onclick={async () => {
        if(await alertConfirm(language.backupConfirm)){
            localStorage.setItem('backup', 'save')
            
            if(isTauri || isNodeServer){
                checkDriver('savetauri')
            }
            else{
                checkDriver('save')
            }
        }
    }} className="mt-2">
    {language.savebackup}
</Button>

<Button
    onclick={async () => {
        if((await alertConfirm(language.backupLoadConfirm)) && (await alertConfirm(language.backupLoadConfirm2))){
            localStorage.setItem('backup', 'load')
            if(isTauri || isNodeServer){
                checkDriver('loadtauri')
            }
            else{
                checkDriver('load')
            }
        }
    }}
    className="mt-2">
    {language.loadbackup}
</Button>

<Button onclick={exportAsDataset} className="mt-2">
    {language.exportAsDataset}
</Button>

<!--

    My song for dear, my old friend.

    Should old aquaintance be forgot,
    and never brought to mind?
    Should old lang syne be forgot,
    and auld lang syne?

    For auld lang syne, my dear,
    for auld lang syne,
    we'll take a cup o' kindness yet,
    for auld lang syne.

-->
