<script lang="ts">
    import {
        ArrowLeft,
        MenuIcon,
        SearchIcon,
        XIcon,
        GlobeIcon,
        SparklesIcon,
        UserIcon,
        SplitIcon,
        BookmarkCheckIcon,
        PlusIcon,
        DownloadIcon,
        RotateCcwIcon,
        SlidersHorizontalIcon,
        PackageIcon
    } from "@lucide/svelte";
    import { language } from "src/lang";
    import { characterStore, settingsStore, presetStore, personaStore } from 'src/ts/stores/domain';
    import {
        MobileGUIStack,
        MobileSearch,
        selectedCharID,
        SettingsMenuIndex,
        MobileSideBar,
        messageSearchOpen,
        openPersonaList,
        openPresetList,
        bookmarkListOpen,
        alertStore,
        ReloadGUIPointer,
        mobileSettingsReturnChar,
        openMobileSettingsPage
    } from "src/ts/stores.svelte";
    import { preloadChatSidebarPanel } from '../SideBars/sidebarPanelLoaders';
    import { getCharImage } from "src/ts/characters";
    import { changeChatTo } from "src/ts/globalApi.svelte";
    import { alertConfirm, alertNormal, alertInput } from "src/ts/alert";
    import { downloadRisuHub } from "src/ts/characterCards";
    import ModuleChatMenu from '../Setting/Pages/Module/ModuleChatMenu.svelte';
    import { v4 } from "uuid";

    let chatQuickMenuOpen = $state(false);
    let openModuleMenu = $state(false);

    let currentChar = $derived(characterStore.characters[$selectedCharID]);
    let activePersonaIcon = $derived(personaStore.activePersona?.icon ?? '');
    let activePersonaName = $derived(personaStore.activePersona?.name ?? 'User');

    let currentPresetName = $derived(
        presetStore.summaries?.[presetStore.activeIndex]?.name ||
        presetStore.state.aiModel ||
        ''
    );

    let settingsMenuTitle = $derived.by(() => {
        switch ($SettingsMenuIndex) {
            case 0: return `${language.account} & ${language.files}`;
            case 1: return language.chatBot;
            case 2: return language.otherBots;
            case 3: return language.display;
            case 4: return language.plugin;
            case 5: return language.files;
            case 6: return language.advancedSettings;
            case 7: return language.community;
            case 8: return language.globalLoreBook;
            case 9: return language.globalRegexScript;
            case 10: return language.language;
            case 11: return language.accessibility;
            case 12: return language.persona;
            case 13: return language.promptTemplate;
            case 14: return language.modules;
            case 15: return language.hotkey;
            case 77: return language.supporterThanks;
            default: return language.settings;
        }
    });

    let sidebarTitle = $derived.by(() => {
        switch ($MobileSideBar) {
            case 1: return language.Chat || "Chat Sessions";
            case 2: return language.character || "Character";
            case 3: return "Dev Tools";
            case 4: return "BTW";
            case 6: return language.promptTemplate || "Toggles";
            default: return language.menu;
        }
    });

    async function handleNewChat() {
        chatQuickMenuOpen = false;
        if (!currentChar) return;
        currentChar.chats.unshift({
            message: [],
            note: "",
            name: `Chat ${currentChar.chats.length + 1}`,
            localLore: [],
            id: v4()
        });
        changeChatTo(0);
        $ReloadGUIPointer += 1;
        alertNormal("New chat started");
    }

    async function handleBranchGraph() {
        chatQuickMenuOpen = false;
        if (!currentChar) return;
        const activeChat = currentChar.chats?.[currentChar.chatPage ?? 0];
        if (!activeChat) return;
        activeChat.id ??= v4();
        alertStore.set({
            type: "branches",
            msg: activeChat.id
        });
    }

    async function handleResetChat() {
        chatQuickMenuOpen = false;
        if (!currentChar) return;
        const chat = currentChar.chats?.[currentChar.chatPage ?? 0];
        if (!chat) return;
        if (await alertConfirm("Clear all messages in current chat?")) {
            chat.message = [];
            $ReloadGUIPointer += 1;
        }
    }

    async function handleExportChat() {
        chatQuickMenuOpen = false;
        if (!currentChar) return;
        const { exportChat } = await import('src/ts/characters');
        await exportChat(currentChar.chatPage ?? 0);
    }

    async function handleImportRealmByUrl() {
        const input = await alertInput('Input Realm URL or ID');
        if (!input) return;
        let id = input;
        if (input.startsWith('http')) {
            try {
                const url = new URL(input);
                id = url.searchParams.get("realm") ?? url.searchParams.get("code") ?? input.split("/").at(-1) ?? input;
            } catch {
                id = input;
            }
        }
        await downloadRisuHub(id);
    }

    function handleGoGlobalModules() {
        chatQuickMenuOpen = false;
        openMobileSettingsPage(14, $selectedCharID, $MobileSideBar);
    }
</script>

<header class="w-full pt-[max(env(safe-area-inset-top),0.5rem)] px-3 pb-2 border-b border-darkborderc bg-darkbg/95 backdrop-blur-md flex items-center justify-between gap-2 shrink-0 z-30 select-none shadow-xs">
    <!-- ================= 1. IN CHAT SIDEBAR OPEN ================= -->
    {#if $selectedCharID !== -1 && $MobileSideBar > 0}
        <div class="flex items-center gap-2 min-w-0 flex-1">
            <button
                onclick={() => { MobileSideBar.set(0); }}
                class="p-2 -ml-1 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors cursor-pointer shrink-0"
                aria-label="Back to chat"
            >
                <ArrowLeft size={20} />
            </button>
            <div class="flex flex-col min-w-0">
                <span class="font-bold text-base text-textcolor truncate">{sidebarTitle}</span>
                {#if currentChar}
                    <span class="text-[11px] text-textcolor2 truncate">{currentChar.name}</span>
                {/if}
            </div>
        </div>

        <div class="flex items-center gap-1 shrink-0">
            {#if $MobileSideBar === 1}
                <button
                    onclick={handleNewChat}
                    class="p-2 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                    title="New Chat"
                >
                    <PlusIcon size={18} />
                </button>
                <button
                    onclick={() => { bookmarkListOpen.set(true); }}
                    class="p-2 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                    title="Bookmarks"
                >
                    <BookmarkCheckIcon size={18} />
                </button>
            {/if}
        </div>

    <!-- ================= 2. IN ACTIVE CHAT ================= -->
    {:else if $selectedCharID !== -1}
        <!-- Left: Back Button & Character Avatar -->
        <div class="flex items-center gap-2 min-w-0 flex-1">
            <button
                onclick={() => { selectedCharID.set(-1); }}
                class="p-2 -ml-1 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors cursor-pointer shrink-0"
                aria-label="Back to character list"
            >
                <ArrowLeft size={20} />
            </button>

            <!-- Character Avatar Thumbnail -->
            <div class="relative w-8 h-8 rounded-full overflow-hidden bg-bgcolor border border-darkborderc shrink-0 flex items-center justify-center">
                {#if currentChar?.image}
                    {#await getCharImage(currentChar.image, 'css', { thumbnail: true })}
                        <div class="w-full h-full bg-darkbg animate-pulse"></div>
                    {:then im}
                        <div class="w-full h-full bg-cover bg-center" style={im}></div>
                    {/await}
                {:else}
                    <UserIcon size={16} class="text-textcolor2" />
                {/if}
            </div>

            <!-- Character Name & Active Subtitle -->
            <div class="flex flex-col min-w-0 flex-1">
                <span class="font-bold text-sm text-textcolor truncate leading-tight">{currentChar?.name || "RisuAI"}</span>
                <span class="text-[10px] text-textcolor2 truncate mt-0.5">{currentPresetName || "Chat"}</span>
            </div>
        </div>

        <!-- Right: Actions (Persona Switcher, Quick Menu, Sidebar Toggle) -->
        <div class="flex items-center gap-1 shrink-0">
            <!-- Quick Persona Switcher Icon -->
            <button
                onclick={() => { openPersonaList.set(true); }}
                class="relative p-1 rounded-full border border-darkborderc hover:border-selected transition-colors shrink-0"
                title={`${language.persona || 'Persona'}: ${activePersonaName}`}
                aria-label="Switch persona"
            >
                <div class="w-6 h-6 rounded-full overflow-hidden bg-darkbg flex items-center justify-center">
                    {#if activePersonaIcon}
                        {#await getCharImage(activePersonaIcon, 'css', { thumbnail: true })}
                            <div class="w-full h-full bg-darkbg animate-pulse"></div>
                        {:then im}
                            <div class="w-full h-full bg-cover bg-center" style={im}></div>
                        {/await}
                    {:else}
                        <UserIcon size={14} class="text-textcolor2" />
                    {/if}
                </div>
            </button>

            <!-- Quick Actions Dropdown Button -->
            <div class="relative">
                <button
                    onclick={() => { chatQuickMenuOpen = !chatQuickMenuOpen; }}
                    class="p-2 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                    aria-label="Chat quick menu"
                >
                    <SparklesIcon size={18} />
                </button>

                {#if chatQuickMenuOpen}
                    <button
                        type="button"
                        tabindex="-1"
                        class="fixed inset-0 z-40 bg-transparent cursor-default"
                        onclick={() => { chatQuickMenuOpen = false; }}
                        aria-label="Close menu"
                    ></button>

                    <div class="absolute right-0 top-10 z-50 bg-darkbg border border-darkborderc rounded-2xl p-1.5 shadow-2xl min-w-[190px] flex flex-col gap-0.5 backdrop-blur-md">
                        <button
                            onclick={handleNewChat}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <PlusIcon size={15} class="text-selected" />
                            <span>New Chat</span>
                        </button>
                        <button
                            onclick={handleBranchGraph}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <SplitIcon size={15} class="text-blue-400" />
                            <span>Chat Branches</span>
                        </button>
                        <button
                            onclick={() => { chatQuickMenuOpen = false; bookmarkListOpen.set(true); }}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <BookmarkCheckIcon size={15} class="text-emerald-400" />
                            <span>Bookmarks</span>
                        </button>
                        <button
                            onclick={() => { chatQuickMenuOpen = false; messageSearchOpen.set(true); }}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <SearchIcon size={15} class="text-purple-400" />
                            <span>{language.search || "Search Messages"}</span>
                        </button>
                        <button
                            onclick={() => { chatQuickMenuOpen = false; openPresetList.set(true); }}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <SlidersHorizontalIcon size={15} class="text-amber-400" />
                            <span>Bot Presets</span>
                        </button>
                        <button
                            onclick={() => { chatQuickMenuOpen = false; openPersonaList.set(true); }}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <UserIcon size={15} class="text-teal-400" />
                            <span>{language.persona || "Switch Persona"}</span>
                        </button>
                        <button
                            onclick={() => { chatQuickMenuOpen = false; openModuleMenu = true; }}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <PackageIcon size={15} class="text-orange-400" />
                            <span>대화 모듈</span>
                        </button>
                        <button
                            onclick={handleGoGlobalModules}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <GlobeIcon size={15} class="text-blue-400" />
                            <span>전역 모듈 (설정)</span>
                        </button>
                        <div class="my-1 border-t border-darkborderc/50"></div>
                        <button
                            onclick={handleExportChat}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-textcolor hover:bg-darkbutton transition-colors"
                        >
                            <DownloadIcon size={15} class="text-textcolor2" />
                            <span>{language.export || "Export Chat"}</span>
                        </button>
                        <button
                            onclick={handleResetChat}
                            class="flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-draculared hover:bg-draculared/10 transition-colors"
                        >
                            <RotateCcwIcon size={15} />
                            <span>{language.reset || "Clear Chat"}</span>
                        </button>
                    </div>
                {/if}
            </div>

            <!-- Sidebar Hamburger Menu Button -->
            <button
                onpointerdown={() => void preloadChatSidebarPanel()}
                onclick={() => { MobileSideBar.set(1); }}
                class="p-2 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                aria-label="Open sidebar"
            >
                <MenuIcon size={20} />
            </button>
        </div>

    <!-- ================= 3. SETTINGS STACK (STACK === 2) ================= -->
    {:else if $MobileGUIStack === 2}
        <div class="flex items-center gap-2 min-w-0 flex-1">
            {#if $SettingsMenuIndex > -1 || mobileSettingsReturnChar.value}
                <button
                    onclick={() => {
                        if (mobileSettingsReturnChar.value) {
                            const ret = mobileSettingsReturnChar.value;
                            mobileSettingsReturnChar.value = null;
                            SettingsMenuIndex.set(-1);
                            selectedCharID.set(ret.charId);
                            MobileSideBar.set(ret.sideBar ?? 0);
                            return;
                        }
                        SettingsMenuIndex.set(-1);
                    }}
                    class="p-2 -ml-1 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors cursor-pointer shrink-0"
                    aria-label="Back"
                >
                    <ArrowLeft size={20} />
                </button>
            {/if}
            <h1 class="font-bold text-base text-textcolor truncate m-0">
                {$SettingsMenuIndex === -1 ? (language.settings || "Settings") : settingsMenuTitle}
            </h1>
        </div>

    <!-- ================= 4. CHARACTERS LIST STACK (STACK === 1) ================= -->
    {:else if $MobileGUIStack === 1}
        <!-- Search Input with Clear Button -->
        <div class="relative flex-1 flex items-center min-w-0">
            <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none text-textcolor2">
                <SearchIcon size={16} />
            </div>
            <input
                placeholder={`${language.search || 'Search'}...`}
                bind:value={$MobileSearch}
                class="w-full h-10 pl-9 pr-9 rounded-2xl bg-darkbutton/60 border border-darkborderc text-textcolor placeholder-textcolor2/70 text-xs focus:outline-none focus:border-selected focus:ring-1 focus:ring-selected/40 transition-colors"
            />
            {#if $MobileSearch}
                <button
                    onclick={() => { $MobileSearch = ''; }}
                    class="absolute inset-y-0 right-2.5 flex items-center text-textcolor2 hover:text-textcolor p-1"
                    aria-label="Clear search"
                >
                    <XIcon size={14} />
                </button>
            {/if}
        </div>

        <!-- Quick Persona Switcher & Message Search -->
        <div class="flex items-center gap-1 shrink-0">
            <button
                onclick={() => { messageSearchOpen.set(true); }}
                class="p-2 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                title={language.search || "Search"}
                aria-label="Search all messages"
            >
                <SearchIcon size={18} />
            </button>

            <!-- Persona Avatar shortcut -->
            <button
                onclick={() => { openPersonaList.set(true); }}
                class="relative p-1 rounded-full border border-darkborderc hover:border-selected transition-colors"
                title={`${language.persona || 'Persona'}: ${activePersonaName}`}
                aria-label="Switch persona"
            >
                <div class="w-7 h-7 rounded-full overflow-hidden bg-darkbg flex items-center justify-center">
                    {#if activePersonaIcon}
                        {#await getCharImage(activePersonaIcon, 'css', { thumbnail: true })}
                            <div class="w-full h-full bg-darkbg animate-pulse"></div>
                        {:then im}
                            <div class="w-full h-full bg-cover bg-center" style={im}></div>
                        {/await}
                    {:else}
                        <UserIcon size={16} class="text-textcolor2" />
                    {/if}
                </div>
            </button>
        </div>

    <!-- ================= 5. RISUREALM STACK (STACK === 0) ================= -->
    {:else}
        <div class="flex items-center gap-2 min-w-0">
            <div class="w-7 h-7 rounded-xl bg-purple-500/20 text-purple-400 flex items-center justify-center">
                <GlobeIcon size={16} />
            </div>
            <span class="font-bold text-base text-textcolor">RisuRealm</span>
        </div>

        <div class="flex items-center gap-1.5">
            <button
                onclick={handleImportRealmByUrl}
                class="px-2.5 py-1 rounded-xl bg-darkbutton border border-darkborderc text-xs font-semibold text-textcolor hover:bg-selected transition-colors"
            >
                Import URL
            </button>
        </div>
    {/if}
</header>

{#if openModuleMenu}
    <div class="fixed inset-0 z-50">
        <ModuleChatMenu close={() => { openModuleMenu = false; }} />
    </div>
{/if}
