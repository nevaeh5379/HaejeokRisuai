<script lang="ts">
    import { MobileGUIStack, MobileSideBar, selectedCharID } from "src/ts/stores.svelte";
    import { WrenchIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { isLite } from "src/ts/lite";
    import LazyComponent from '../Others/LazyComponent.svelte'
    import { loadCharConfig, loadSideChatList } from '../SideBars/sidebarPanelLoaders'
    
    const settingsLoader = () => import('../Setting/Settings.svelte')
    const realmLoader = () => import('../UI/Realm/RealmMain.svelte')
    const charactersLoader = () => import('./MobileCharacters.svelte')
    const chatLoader = () => import('../ChatScreens/ChatScreen.svelte')
    const devToolLoader = () => import('../SideBars/DevTool.svelte')

</script>

{#if $MobileSideBar > 0 && !$isLite}
<div class="w-full px-2 py-1 text-textcolor2 border-b border-b-darkborderc bg-darkbg flex justify-start items-center gap-2">
    <button class="flex-1 border-r border-r-darkborderc" class:text-textcolor={$MobileSideBar === 1} onclick={() => {
        void loadSideChatList()
        $MobileSideBar = 1
    }}>
        {language.Chat}
    </button>
    <button class="flex-1 border-r border-r-darkborderc" class:text-textcolor={$MobileSideBar === 2} onclick={() => {
        void loadCharConfig()
        $MobileSideBar = 2
    }}>
        {language.character}
    </button>
    <button class:text-textcolor={$MobileSideBar === 3} onclick={() => {
        $MobileSideBar = 3
    }}>
        <WrenchIcon size={18} />
    </button>
</div>
{/if}
<div class="w-full flex-1 overflow-y-auto bg-bgcolor relative">
    {#if $MobileSideBar > 0}
        <div class="w-full flex flex-col p-2 mt-2 h-full">
            {#if $MobileSideBar === 1}
                <LazyComponent loader={loadSideChatList} />
            {:else if $MobileSideBar === 2}
                <LazyComponent loader={loadCharConfig} />
            {:else if $MobileSideBar === 3}
                <LazyComponent loader={devToolLoader} />
            {/if}
        </div>
    {:else if $selectedCharID !== -1}
        <LazyComponent loader={chatLoader} />
    {:else if $MobileGUIStack === 0}
        <LazyComponent loader={realmLoader} />
    {:else if $MobileGUIStack === 1}
        <LazyComponent loader={charactersLoader} />
    {:else if $MobileGUIStack === 2}
        <LazyComponent loader={settingsLoader} />
    {/if}
</div>
