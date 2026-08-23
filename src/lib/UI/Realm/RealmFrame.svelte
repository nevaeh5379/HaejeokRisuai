<script lang="ts">
    import { alertMd, alertRisuServiceTOS } from "src/ts/alert";
    import { shareRealmCardData } from "src/ts/realm";
    import { downloadPreset } from "src/ts/storage/database.svelte";
    import { characterStore, settingsStore, moduleStore } from 'src/ts/stores/domain';
    import { selectedCharID, ShowRealmFrameStore } from "src/ts/stores.svelte";
    import { sleep } from "src/ts/util";
    import { onDestroy, onMount } from "svelte";

    const close =  () => {
        $ShowRealmFrameStore = ''
    }
    let iframe: HTMLIFrameElement = $state(null)
    let loadingStage = $state(0)
    let pongGot = false

    const pmfunc = (e:MessageEvent) => {
        if(e.data.type === 'filedata' && e.data.success){
            loadingStage = 2
        }
        if(e.data.type === 'pong'){
            pongGot = true
        }
        if(e.data.type === 'close'){
            close()
        }
        if(e.data.type === 'success'){
            alertMd(`## Upload Success\n\nYour character has been uploaded to Realm successfully.\n\n${"```\nhttps://realm.risuai.net/character/" +  e.data.id + "\n```"}`)
            if($ShowRealmFrameStore.startsWith('preset') || $ShowRealmFrameStore.startsWith('module')){
                //TODO, add preset edit
            }
            else if(characterStore.characters[$selectedCharID].type === 'character'){
                loadingStage = 0
                characterStore.characters[$selectedCharID].realmId = e.data.id
            }
            close()
        }
    }

    const waitPing = async () => {
        if(iframe){
            while(!pongGot){
                iframe.contentWindow.postMessage({
                    type: 'ping'
                }, '*')
                await sleep(300)
            }
        }
    }

    onMount(async () => {
        if (!(await alertRisuServiceTOS())) {
            close()
            return
        }

        window.addEventListener('message', pmfunc)

        let data:{
            data: ArrayBuffer,
            name: ArrayBuffer
        }

        const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
            return new Uint8Array(bytes).buffer
        }
        
        if($ShowRealmFrameStore.startsWith('preset')){
            const predata = await downloadPreset(Number($ShowRealmFrameStore.split(':')[1]), 'return')
            const encodedPredata = predata.buf
            const encodedPredataName = new TextEncoder().encode(predata.data.name + '.risup')
            data = {
                data: toArrayBuffer(encodedPredata),
                name: toArrayBuffer(encodedPredataName)
            }
        }
        else if($ShowRealmFrameStore.startsWith('module')){
            const predata = (moduleStore.modules ?? settingsStore.state.modules)[Number($ShowRealmFrameStore.split(':')[1])]
            predata.type = 'risuModule'
            const encodedPredata = new TextEncoder().encode(JSON.stringify(predata))
            const encodedPredataName = new TextEncoder().encode(predata.name + '.json')
            data = {
                data: toArrayBuffer(encodedPredata),
                name: toArrayBuffer(encodedPredataName)
            }
        }
        else{
            data = await shareRealmCardData()
        }

        if(iframe){
            await waitPing()
            loadingStage = 1
            iframe.contentWindow.postMessage({
                type: 'filedata',
                buf: [data.data, data.name]
            }, '*', [data.data, data.name])
        }
    })

    const getUrl = () => {
        const url = new URL('https://realm.risuai.net/upload')
        if($ShowRealmFrameStore.startsWith('preset') || $ShowRealmFrameStore.startsWith('module')){
            //TODO, add preset edit
        }
        else if(characterStore.characters[$selectedCharID].type === 'character' && characterStore.characters[$selectedCharID].realmId){
            url.searchParams.set('edit', characterStore.characters[$selectedCharID].realmId)
            url.searchParams.set('edit-type', 'normal')
        }
        url.hash = 'noLayout'
        return url.toString()
    }

    onDestroy(() => {
        window.removeEventListener('message', pmfunc)
    })
</script>

<div class="top-0 left-0 z-50 fixed w-full h-full flex flex-col justify-center items-center text-textcolor bg-white">
    <div class="bg-darkbg border-b border-b-darkborderc w-full flex p-2">
        <h1 class="text-2xl font-bold max-w-full overflow-hidden whitespace-nowrap text-ellipsis">Upload to Realm</h1>
        <button class="text-textcolor text-lg hover:text-red-500 ml-auto" onclick={close}>&times;</button>
    </div>
    {#if loadingStage < 1}
    <div class="w-full flex justify-center items-center p-4 flex-1">
        <div class="loadmove"></div>
    </div>
    {/if}
    <iframe bind:this={iframe}
        src={getUrl()}
        title="upload" class="w-full flex-1" class:hidden={loadingStage < 1}
></iframe>
</div>
