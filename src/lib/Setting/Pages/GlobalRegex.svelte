<script lang="ts">
    import { DownloadIcon, HardDriveUploadIcon, PlusIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
</script>
<h2 class="mb-2 text-2xl font-bold mt-2">{language.globalRegexScript} <Help key="regexScript" /></h2>
<RegexList bind:value={settingsStore.state.globalscript} />
<div class="text-textcolor2 mt-2 flex gap-2">
    <button class="font-medium cursor-pointer hover:text-green-500" onclick={() => {
        let script = settingsStore.state.globalscript
        script.push({
            comment: "",
            in: "",
            out: "",
            type: "editinput"
        })
        settingsStore.state.globalscript = script
    }}><PlusIcon /></button>
    <button class="font-medium cursor-pointer hover:text-green-500" onclick={() => {
        exportRegex()
    }}><DownloadIcon /></button>
    <button class="font-medium cursor-pointer hover:text-green-500" onclick={() => {
        importRegex()
    }}><HardDriveUploadIcon /></button>
</div>