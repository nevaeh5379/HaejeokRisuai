<script lang="ts">
    import { getCustomBackground, getEmotion } from "../../ts/util";
    
    import { characterStore, settingsStore } from 'src/ts/stores/domain';
    import { CharEmotion, selectedCharID } from "../../ts/stores.svelte";
    import ResizeBox from './ResizeBox.svelte'
    import DefaultChatScreen from "./DefaultChatScreen.svelte";
    import defaultWallpaper from '../../etc/bg.jpg'
    import ChatList from "../Others/ChatList.svelte";
    import TransitionImage from "./TransitionImage.svelte";
    import BackgroundDom from "./BackgroundDom.svelte";
    import SideBarArrow from "../UI/GUI/SideBarArrow.svelte";
    import ModuleChatMenu from "../Setting/Pages/Module/ModuleChatMenu.svelte";
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
</script>

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
        <div style={bgImg} class="h-full w-full" class:max-w-6xl={settingsStore.state.classicMaxWidth}>
            {#if $selectedCharID >= 0}
                {#if characterStore.characters[$selectedCharID].viewScreen !== 'none' && (characterStore.characters[$selectedCharID].type === 'group' || (!characterStore.characters[$selectedCharID].inlayViewScreen))}
                    <ResizeBox />
                {/if}
            {/if}
            <DefaultChatScreen customStyle={bgImg.length > 2 ? `${externalStyles}`: ''} bind:openChatList bind:openModuleList/>
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
