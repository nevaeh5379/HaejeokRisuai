<script lang="ts">
    import { language } from "src/lang";
    import { alertConfirm } from "src/ts/alert";
    import { loadInternalBackup } from "src/ts/globalApi.svelte";
    import { isTauri, isNodeServer } from "src/ts/platform";
    import { checkDriver } from "src/ts/drive/drive";
    import { LoadLocalBackup, SaveLocalBackup, SavePartialLocalBackup } from "src/ts/drive/backuplocal";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import { exportAsDataset } from "src/ts/storage/backup/exportAsDataset";
    import { cleanColdStorage } from "src/ts/process/coldstorage.svelte";
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