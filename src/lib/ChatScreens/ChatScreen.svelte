<script lang="ts">
    import { getCustomBackground, getEmotion } from "../../ts/util";
    
    import { characterStore, settingsStore } from 'src/ts/stores/domain';
    import { CharEmotion, MobileGUI, selectedCharID } from "../../ts/stores.svelte";
    import ResizeBox from './ResizeBox.svelte'
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from '../../etc/bg.jpg'
    import ChatList from "../Others/ChatList.svelte";
    import TransitionImage from "./TransitionImage.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SideBarArrow from "../UI/GUI/SideBarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
    import { chatTabsStore } from 'src/ts/chatTabs.svelte';
    let openChatList = $state(false)
    let openModuleList = $state(false)

    const wallPaper = `background: url(${defaultWallpaper})`
    const externalStyles = 
            ("background: " + (settingsStore.state.textScreenColor ? (settingsStore.state.textScreenColor + '80') : "rgba(0,0,0,0.8)") + ';\n')
        +   (settingsStore.state.textBorder ? "text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000;" : '')
        +   (settingsStore.state.textScreenRounded ? "border-radius: 2rem; padding: 1rem;" : '')
        +   (settingsStore.state.textScreenBorder ? `border: 0.3rem solid ${settingsStore.state.textScreenBorder};` : '')
    let bgImg= $state('')
    let lastBg = $state('')
    $effect.pre(() => {
        (async () =>{
            const customBackground = settingsStore.state.customBackground ?? ''
            if(customBackground !== lastBg){
                lastBg = customBackground
                bgImg = await getCustomBackground(customBackground)
            }
        })()
    });

    let splitRatio = $state(0.5)
    let splitContainer: HTMLDivElement | undefined = $state()
    let draggingSplit = $state(false)
    let splitColumns = $derived(
        chatTabsStore.groups.length > 1
            ? `minmax(0, ${splitRatio}fr) 4px minmax(0, ${1 - splitRatio}fr)`
            : 'minmax(0, 1fr)'
    )

    function startSplitDrag(event: PointerEvent){
        if($MobileGUI || chatTabsStore.groups.length < 2) return
        draggingSplit = true
        event.preventDefault()
    }

    function moveSplitDrag(event: PointerEvent){
        if(!draggingSplit || !splitContainer) return
        const rect = splitContainer.getBoundingClientRect()
        if(rect.width <= 0) return
        splitRatio = Math.max(0.2, Math.min(0.8, (event.clientX - rect.left) / rect.width))
    }

    function stopSplitDrag(){
        draggingSplit = false
    }
</script>

<svelte:window onpointermove={moveSplitDrag} onpointerup={stopSplitDrag} onpointercancel={stopSplitDrag} />

{#if settingsStore.state.theme === 'waifu'}
    <div class="grow h-full flex justify-center relative" style="{bgImg.length < 4 ? wallPaper : bgImg}">
        <SideBarArrow />
        <BackgroundDom />
        {#if $selectedCharID >= 0}
            {#if characterStore.characters[$selectedCharID].viewScreen !== 'none'}
                <div class="h-full mr-10 flex justify-end halfw" style:width="{42 * (settingsStore.state.waifuWidth2 / 100)}rem">
                    <TransitionImage classType="waifu" src={getEmotion({ characters: characterStore.characters } as any, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
        <div class="h-full w-2xl" style:width="{42 * (settingsStore.state.waifuWidth / 100)}rem" class:halfwp={$selectedCharID >= 0 && characterStore.characters[$selectedCharID].viewScreen !== 'none'}>
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList/>
        </div>
    </div>
{:else if settingsStore.state.theme === 'waifuMobile'}
    <div class="grow h-full relative" style={bgImg.length < 4 ? wallPaper : bgImg}>
        <SideBarArrow />
        <BackgroundDom />
        <div class="w-full absolute z-10 bottom-0 left-0"
            class:per33={$selectedCharID >= 0 && characterStore.characters[$selectedCharID].viewScreen !== 'none'}
            class:h-full={!($selectedCharID >= 0 && characterStore.characters[$selectedCharID].viewScreen !== 'none')}
        >
            <DefaultChatScreen customStyle={`${externalStyles}backdrop-filter: blur(4px);`} bind:openChatList bind:openModuleList/>
        </div>
        {#if $selectedCharID >= 0}
            {#if characterStore.characters[$selectedCharID].viewScreen !== 'none'}
                <div class="h-full w-full absolute bottom-0 left-0 max-w-full">
                    <TransitionImage classType="mobile" src={getEmotion({ characters: characterStore.characters } as any, $CharEmotion, 'plain')}/>
                </div>
            {/if}
        {/if}
    </div>
{:else}
    <div class="grow h-full min-w-0 relative justify-center flex">
        <SideBarArrow />
        <BackgroundDom />
        <div style={bgImg} class="h-full w-full min-w-0" class:max-w-6xl={settingsStore.state.classicMaxWidth}>
            {#if $selectedCharID >= 0}
                {#if characterStore.characters[$selectedCharID].viewScreen !== 'none' && (characterStore.characters[$selectedCharID].type === 'group' || (!characterStore.characters[$selectedCharID].inlayViewScreen))}
                    <ResizeBox />
                {/if}
            {/if}
            <div
                bind:this={splitContainer}
                class="h-full w-full min-w-0 grid"
                style:grid-template-columns={splitColumns}
                class:select-none={draggingSplit}
            >
                {#each chatTabsStore.groups as group, index (group.id)}
                    {#if index > 0}
                        <div
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize chat split"
                            class="h-full cursor-col-resize bg-darkborderc hover:bg-textcolor2 transition-colors z-20"
                            class:bg-textcolor2={draggingSplit}
                            onpointerdown={startSplitDrag}
                        ></div>
                    {/if}
                    <div class="h-full min-w-0 overflow-hidden">
                        <DefaultChatScreen
                            customStyle={bgImg.length > 2 ? `${externalStyles}`: ''}
                            groupId={group.id}
                            reserveSidebarSpace={index === 0}
                            allowSplit={!$MobileGUI}
                            bind:openChatList
                            bind:openModuleList
                        />
                    </div>
                {/each}
            </div>
        </div>
    </div>
{/if}
{#if openChatList}
    <ChatList close={() => {openChatList = false}}/>
{:else if openModuleList}
    <ModuleChatMenu close={() => {openModuleList = false}}/>
{/if}

<style>
    .halfw{
        max-width: calc(50% - 5rem);
    }
    .halfwp{
        max-width: calc(50% - 5rem);
    }
    .per33{
        height: 33.333333%;
    }
</style>
