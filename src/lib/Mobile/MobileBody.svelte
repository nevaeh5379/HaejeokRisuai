<script lang="ts">
    import { MobileGUIStack, MobileSideBar, selectedCharID } from "src/ts/stores.svelte";
    import { WrenchIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { isLite } from "src/ts/lite";
    import LazyComponent from '../Others/LazyComponent.svelte'
    import { loadCharConfig } from '../SideBars/sidebarPanelLoaders'
    import { btwRuntime } from 'src/ts/process/btwRuntime.svelte';
    
    const settingsLoader = () => import('../Setting/Settings.svelte')
    const realmLoader = () => import('../UI/Realm/RealmMain.svelte')
    const charactersLoader = () => import('./MobileCharacters.svelte')
    const chatLoader = () => import('../ChatScreens/ChatScreen.svelte')
    const devToolLoader = () => import('../SideBars/DevTool.svelte')
    const btwPanelLoader = () => import('../ChatScreens/BtwPanel.svelte')
    const mobileChatListLoader = () => import('./MobileChatList.svelte')
    const mobileTogglesLoader = () => import('./MobileToggles.svelte')

</script>

{#if $MobileSideBar > 0 && !$isLite}
<nav class="w-full px-2 py-1.5 text-xs font-semibold text-textcolor2 border-b border-b-darkborderc bg-darkbg flex items-center justify-around gap-1 shrink-0 select-none">
    <!-- Tab 1: Chats List -->
    <button
        class="flex-1 py-1.5 px-2 rounded-xl text-center transition-all cursor-pointer truncate shrink-0 {$MobileSideBar === 1 ? 'bg-selected/20 text-selected font-bold' : 'hover:bg-darkbutton hover:text-textcolor'}"
        onclick={() => {
            $MobileSideBar = 1;
        }}
    >
        {language.Chat || "챗"}
    </button>

    <!-- Tab 2: Character Config -->
    <button
        class="flex-1 py-1.5 px-2 rounded-xl text-center transition-all cursor-pointer truncate shrink-0 {$MobileSideBar === 2 ? 'bg-selected/20 text-selected font-bold' : 'hover:bg-darkbutton hover:text-textcolor'}"
        onclick={() => {
            void loadCharConfig();
            $MobileSideBar = 2;
        }}
    >
        {language.character || "캐릭터"}
    </button>

    <!-- Tab 6: Module & Prompt Toggles -->
    <button
        class="flex-1 py-1.5 px-2 rounded-xl text-center transition-all cursor-pointer truncate shrink-0 {$MobileSideBar === 6 ? 'bg-selected/20 text-selected font-bold' : 'hover:bg-darkbutton hover:text-textcolor'}"
        onclick={() => {
            $MobileSideBar = 6;
        }}
    >
        {language.promptTemplate || "토글"}
    </button>

    <!-- Tab 3: Dev Tools -->
    <button
        class="py-1.5 px-3 rounded-xl text-center transition-all cursor-pointer flex items-center justify-center shrink-0 {$MobileSideBar === 3 ? 'bg-selected/20 text-selected font-bold' : 'hover:bg-darkbutton hover:text-textcolor'}"
        onclick={() => {
            $MobileSideBar = 3;
        }}
        title="Dev Tools"
        aria-label="Dev Tools"
    >
        <WrenchIcon size={16} />
    </button>

    <!-- Tab 4: BTW (if enabled) -->
    {#if btwRuntime.open}
        <button
            class="py-1.5 px-2 rounded-xl text-center transition-all cursor-pointer truncate shrink-0 {$MobileSideBar === 4 ? 'bg-selected/20 text-selected font-bold' : 'hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => {
                $MobileSideBar = 4;
            }}
        >
            BTW
        </button>
    {/if}
</nav>
{/if}

<div class="w-full flex-1 overflow-y-auto bg-bgcolor relative min-h-0">
    {#if $MobileSideBar > 0}
        <div
            class="w-full flex flex-col h-full overflow-y-auto"
            class:p-2={$MobileSideBar !== 4 && $MobileSideBar !== 1 && $MobileSideBar !== 6}
        >
            {#if $MobileSideBar === 1}
                <LazyComponent loader={mobileChatListLoader} />
            {:else if $MobileSideBar === 2}
                <LazyComponent loader={loadCharConfig} />
            {:else if $MobileSideBar === 6}
                <LazyComponent loader={mobileTogglesLoader} />
            {:else if $MobileSideBar === 3}
                <LazyComponent loader={devToolLoader} />
            {:else if $MobileSideBar === 4}
                <LazyComponent loader={btwPanelLoader} />
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
