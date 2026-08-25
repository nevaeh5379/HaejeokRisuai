<script lang="ts">
    import { AccessibilityIcon, ActivityIcon, PackageIcon, BotIcon, BoxIcon, CodeIcon, ContactIcon, DatabaseIcon, HardDriveIcon, LanguagesIcon, MonitorIcon, Sailboat, UserIcon, CircleXIcon, KeyboardIcon, SparkleIcon, ArrowLeft, ChevronRight, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import DisplaySettings from "./Pages/DisplaySettings.svelte";
    import UserSettings from "./Pages/UserSettings.svelte";
    import BotSettings from "./Pages/BotSettings.svelte";
    import OtherBotSettings from "./Pages/OtherBotSettings.svelte";
    import PluginSettings from "./Pages/PluginSettings.svelte";
    import FilesSettings from "./Pages/FilesSettings.svelte";
    import AdvancedSettings from "./Pages/AdvancedSettings.svelte";
    import { additionalSettingsMenu, easyPanelStore, MobileGUI, SettingsMenuIndex, settingsOpen } from "src/ts/stores.svelte";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import Communities from "./Pages/Communities.svelte";
    import GlobalLoreBookSettings from "./Pages/GlobalLoreBookSettings.svelte";
    import Lorepreset from "./lorepreset.svelte";
    import GlobalRegex from "./Pages/GlobalRegex.svelte";
    import LanguageSettings from "./Pages/LanguageSettings.svelte";
    import AccessibilitySettings from "./Pages/AccessibilitySettings.svelte";
    import PersonaSettings from "./Pages/PersonaSettings.svelte";
    import PromptSettings from "./Pages/PromptSettings.svelte";
    import ThanksPage from "./Pages/ThanksPage.svelte";
    import ModuleSettings from "./Pages/Module/ModuleSettings.svelte";
    import { isLite } from "src/ts/lite";
    import HotkeySettings from "./Pages/HotkeySettings.svelte";
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import PostgresDbExplorerSettings from "./Pages/PostgresDbExplorerSettings.svelte";
    import StorageExplorerSettings from "./Pages/StorageExplorerSettings.svelte";
    import { isNodeServer } from "src/ts/platform";
    import SettingsSearch from "./SettingsSearch.svelte";
    import {
        scrollToSettingAnchor,
        type SettingSearchResult,
    } from "src/ts/setting/searchIndex";

    let openLoreList = $state(false)
    let dbExplorerOpen = $state(false)
    let storageExplorerOpen = $state(false)
    let searchNavigation = $state<{ menuIndex: number; subTab?: number } | null>(null)
    let innerWidth = $state(typeof window !== "undefined" ? window.innerWidth : 1200)
    let isMobile = $derived(innerWidth < 768 || $MobileGUI)

    $effect(() => {
        if (!isMobile && $SettingsMenuIndex === -1) {
            $SettingsMenuIndex = 1
        }
    })

    let currentMenuTitle = $derived.by(() => {
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
    })

    $effect(() => {
        if (searchNavigation && $SettingsMenuIndex !== searchNavigation.menuIndex) {
            searchNavigation = null
        }
    })

    function handleSearchSelect(result: SettingSearchResult) {
        const target = result.target
        if (target.kind === "dbExplorer") {
            storageExplorerOpen = false
            dbExplorerOpen = true
            return
        }
        if (target.kind === "storageExplorer") {
            dbExplorerOpen = false
            storageExplorerOpen = true
            return
        }
        dbExplorerOpen = false
        storageExplorerOpen = false
        searchNavigation = { menuIndex: target.menuIndex, subTab: target.subTab }
        $SettingsMenuIndex = target.menuIndex
        if (target.itemId) {
            requestAnimationFrame(() => scrollToSettingAnchor(target.itemId!))
        }
    }

</script>

<svelte:window bind:innerWidth />

{#snippet desktopMenuButtons()}
    <SettingsSearch onselect={handleSearchSelect} />

    {#if !$isLite}
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 1 || $SettingsMenuIndex === 13}
            class:text-textcolor2={$SettingsMenuIndex !== 1 && $SettingsMenuIndex !== 13}
            onclick={() => {
                $SettingsMenuIndex = 1
        }}>
            <BotIcon />
            <span>{language.chatBot}</span>
        </button>
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 12}
            class:text-textcolor2={$SettingsMenuIndex !== 12}
            onclick={() => {
                $SettingsMenuIndex = 12
        }}>
            <ContactIcon />
            <span>{language.persona}</span>
        </button>
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 2}
            class:text-textcolor2={$SettingsMenuIndex !== 2}
            onclick={() => {
                $SettingsMenuIndex = 2
        }}>
            <Sailboat />
            <span>{language.otherBots}</span>
        </button>
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 3}
            class:text-textcolor2={$SettingsMenuIndex !== 3}
            onclick={() => {
                $SettingsMenuIndex = 3
        }}>
            <MonitorIcon />
            <span>{language.display}</span>
        </button>
    {/if}
    <button class="flex gap-2 items-center hover:text-textcolor"
        class:text-textcolor={$SettingsMenuIndex === 10}
        class:text-textcolor2={$SettingsMenuIndex !== 10}
        onclick={() => {
            $SettingsMenuIndex = 10
    }}>
        <LanguagesIcon />
        <span>{language.language}</span>
    </button>
    {#if !$isLite}
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 11}
            class:text-textcolor2={$SettingsMenuIndex !== 11}
            onclick={() => {
                $SettingsMenuIndex = 11
        }}>
            <AccessibilityIcon />
            <span>{language.accessibility}</span>
        </button>
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 14}
            class:text-textcolor2={$SettingsMenuIndex !== 14}
            onclick={() => {
                $SettingsMenuIndex = 14
        }}>
            <PackageIcon />
            <span>{language.modules}</span>
        </button>
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 4}
            class:text-textcolor2={$SettingsMenuIndex !== 4}
            onclick={() => {
            $SettingsMenuIndex = 4
        }}>
            <CodeIcon />
            <span>{language.plugin}</span>
        </button>
    {/if}
    <button class="flex gap-2 items-center hover:text-textcolor"
        class:text-textcolor={$SettingsMenuIndex === 0}
        class:text-textcolor2={$SettingsMenuIndex !== 0}
        onclick={() => {
            $SettingsMenuIndex = 0
    }}>
        <UserIcon />
        <span>{language.account} & {language.files}</span>
    </button>
    <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 15}
            class:text-textcolor2={$SettingsMenuIndex !== 15}
            onclick={() => {
            $SettingsMenuIndex = 15
        }}>
            <KeyboardIcon />
            <span>{language.hotkey}</span>
        </button>
    {#if !$isLite}
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 6}
            class:text-textcolor2={$SettingsMenuIndex !== 6}
            onclick={() => {
            $SettingsMenuIndex = 6
        }}>
            <ActivityIcon />
            <span>{language.advancedSettings}</span>
        </button>
        {#if isNodeServer}
            <button class="flex gap-2 items-center hover:text-textcolor"
                class:text-textcolor={dbExplorerOpen}
                class:text-textcolor2={!dbExplorerOpen}
                onclick={() => {
                    dbExplorerOpen = true
            }}>
                <DatabaseIcon />
                <span>{language.postgresDbExplorer}</span>
            </button>
            <button class="flex gap-2 items-center hover:text-textcolor"
                class:text-textcolor={storageExplorerOpen}
                class:text-textcolor2={!storageExplorerOpen}
                onclick={() => {
                    storageExplorerOpen = true
            }}>
                <HardDriveIcon />
                <span>{language.storageExplorer}</span>
            </button>
        {/if}
        <button class="flex gap-2 items-center hover:text-textcolor"
            class:text-textcolor={$SettingsMenuIndex === 77}
            class:text-textcolor2={$SettingsMenuIndex !== 77}
            onclick={() => {
            $SettingsMenuIndex = 77
        }}>
            <BoxIcon />
            <span>{language.supporterThanks}</span>
        </button>
        {#each additionalSettingsMenu as menu}
            <button class="flex gap-2 items-center hover:text-textcolor text-textcolor2"
                onclick={() => {
                    menu.callback()
            }}>
                <PluginDefinedIcon ico={menu} />
                <span>{menu.name}</span>
            </button>
        {/each}

        {#if settingsStore.state.enableRisuaiProTools}
            <button class="flex gap-2 items-center hover:text-textcolor"
                class:text-textcolor={$SettingsMenuIndex === 16}
                class:text-textcolor2={$SettingsMenuIndex !== 16}
                onclick={() => {
                easyPanelStore.open = true
            }}>
                <!-- From Lucide Icons, licensed under MIT/ISC License, modified to fit the design. see license from bundled lucide icons. -->
                <svg width={24} height={24}>
                    <defs>
                        <linearGradient id={`grad1`} x1='0' y1='0' x2='1' y2='0'>
                        <stop offset='0%' style="stop-color:#587bff"/>
                        <stop offset='100%' style="stop-color:#00a1ad"/>
                        </linearGradient>
                    </defs>
                        <SparkleIcon color="url(#grad1)" />
                </svg>
                <span>{language.easyPanel}</span>
            </button>
        {/if}
    {/if}
{/snippet}

{#snippet mobileMenuList()}
    <div class="flex flex-col gap-5 p-4 pb-[max(env(safe-area-inset-bottom),32px)]">
        <SettingsSearch onselect={handleSearchSelect} />

        {#if !$isLite}
            <!-- Group 1: AI & Chat -->
            <div class="flex flex-col gap-1.5">
                <span class="text-xs font-semibold text-textcolor2 uppercase tracking-wider px-2">AI & Chat</span>
                <div class="bg-darkbg rounded-2xl border border-darkborderc overflow-hidden divide-y divide-darkborderc/40 shadow-xs">
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 1; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-blue-500/15 text-blue-400 flex items-center justify-center shrink-0">
                                <BotIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.chatBot}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 12; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-purple-500/15 text-purple-400 flex items-center justify-center shrink-0">
                                <ContactIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.persona}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 2; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-400 flex items-center justify-center shrink-0">
                                <Sailboat size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.otherBots}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 14; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                                <PackageIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.modules}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                </div>
            </div>
        {/if}

        <!-- Group 2: Display & System -->
        <div class="flex flex-col gap-1.5">
            <span class="text-xs font-semibold text-textcolor2 uppercase tracking-wider px-2">Interface & System</span>
            <div class="bg-darkbg rounded-2xl border border-darkborderc overflow-hidden divide-y divide-darkborderc/40 shadow-xs">
                {#if !$isLite}
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 3; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-sky-500/15 text-sky-400 flex items-center justify-center shrink-0">
                                <MonitorIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.display}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                {/if}
                <button
                    class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                    onclick={() => { $SettingsMenuIndex = 10; }}
                >
                    <div class="flex items-center gap-3.5 min-w-0">
                        <div class="w-8 h-8 rounded-lg bg-indigo-500/15 text-indigo-400 flex items-center justify-center shrink-0">
                            <LanguagesIcon size={18} />
                        </div>
                        <span class="text-base font-medium text-textcolor truncate">{language.language}</span>
                    </div>
                    <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                </button>
                {#if !$isLite}
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 11; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-teal-500/15 text-teal-400 flex items-center justify-center shrink-0">
                                <AccessibilityIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.accessibility}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 15; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-orange-500/15 text-orange-400 flex items-center justify-center shrink-0">
                                <KeyboardIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.hotkey}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                {/if}
            </div>
        </div>

        <!-- Group 3: Account & Advanced -->
        <div class="flex flex-col gap-1.5">
            <span class="text-xs font-semibold text-textcolor2 uppercase tracking-wider px-2">Account & Data</span>
            <div class="bg-darkbg rounded-2xl border border-darkborderc overflow-hidden divide-y divide-darkborderc/40 shadow-xs">
                <button
                    class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                    onclick={() => { $SettingsMenuIndex = 0; }}
                >
                    <div class="flex items-center gap-3.5 min-w-0">
                        <div class="w-8 h-8 rounded-lg bg-rose-500/15 text-rose-400 flex items-center justify-center shrink-0">
                            <UserIcon size={18} />
                        </div>
                        <span class="text-base font-medium text-textcolor truncate">{language.account} & {language.files}</span>
                    </div>
                    <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                </button>
                {#if !$isLite}
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 4; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-violet-500/15 text-violet-400 flex items-center justify-center shrink-0">
                                <CodeIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.plugin}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 6; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-pink-500/15 text-pink-400 flex items-center justify-center shrink-0">
                                <ActivityIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.advancedSettings}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                    {#if isNodeServer}
                        <button
                            class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                            onclick={() => { dbExplorerOpen = true; }}
                        >
                            <div class="flex items-center gap-3.5 min-w-0">
                                <div class="w-8 h-8 rounded-lg bg-blue-600/15 text-blue-400 flex items-center justify-center shrink-0">
                                    <DatabaseIcon size={18} />
                                </div>
                                <span class="text-base font-medium text-textcolor truncate">{language.postgresDbExplorer}</span>
                            </div>
                            <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                        </button>
                        <button
                            class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                            onclick={() => { storageExplorerOpen = true; }}
                        >
                            <div class="flex items-center gap-3.5 min-w-0">
                                <div class="w-8 h-8 rounded-lg bg-yellow-500/15 text-yellow-400 flex items-center justify-center shrink-0">
                                    <HardDriveIcon size={18} />
                                </div>
                                <span class="text-base font-medium text-textcolor truncate">{language.storageExplorer}</span>
                            </div>
                            <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                        </button>
                    {/if}
                    <button
                        class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                        onclick={() => { $SettingsMenuIndex = 77; }}
                    >
                        <div class="flex items-center gap-3.5 min-w-0">
                            <div class="w-8 h-8 rounded-lg bg-amber-500/15 text-amber-300 flex items-center justify-center shrink-0">
                                <BoxIcon size={18} />
                            </div>
                            <span class="text-base font-medium text-textcolor truncate">{language.supporterThanks}</span>
                        </div>
                        <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                    </button>
                    {#each additionalSettingsMenu as menu}
                        <button
                            class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                            onclick={() => { menu.callback(); }}
                        >
                            <div class="flex items-center gap-3.5 min-w-0">
                                <div class="w-8 h-8 rounded-lg bg-textcolor/10 text-textcolor flex items-center justify-center shrink-0">
                                    <PluginDefinedIcon ico={menu} />
                                </div>
                                <span class="text-base font-medium text-textcolor truncate">{menu.name}</span>
                            </div>
                            <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                        </button>
                    {/each}
                    {#if settingsStore.state.enableRisuaiProTools}
                        <button
                            class="w-full flex items-center justify-between py-3.5 px-4 text-left transition-colors active:bg-textcolor/10 cursor-pointer"
                            onclick={() => { easyPanelStore.open = true; }}
                        >
                            <div class="flex items-center gap-3.5 min-w-0">
                                <div class="w-8 h-8 rounded-lg bg-linear-to-br from-indigo-500/20 to-teal-500/20 flex items-center justify-center shrink-0">
                                    <SparkleIcon size={18} class="text-indigo-400" />
                                </div>
                                <span class="text-base font-medium text-textcolor truncate">{language.easyPanel}</span>
                            </div>
                            <ChevronRight size={18} class="text-textcolor2/60 shrink-0" />
                        </button>
                    {/if}
                {/if}
            </div>
        </div>
    </div>
{/snippet}

{#snippet pageContent()}
    {#if $SettingsMenuIndex === 0}
        <UserSettings />
    {:else if $SettingsMenuIndex === 1}
        <BotSettings
            targetSubmenu={searchNavigation?.menuIndex === 1 ? searchNavigation.subTab : undefined}
            goPromptTemplate={() => {
                $SettingsMenuIndex = 13
            }}
        />
    {:else if $SettingsMenuIndex === 2}
        <OtherBotSettings targetSubmenu={searchNavigation?.menuIndex === 2 ? searchNavigation.subTab : undefined} />
    {:else if $SettingsMenuIndex === 3}
        <DisplaySettings targetSubmenu={searchNavigation?.menuIndex === 3 ? searchNavigation.subTab : undefined} />
    {:else if $SettingsMenuIndex === 4}
        <PluginSettings />
    {:else if $SettingsMenuIndex === 5}
        <FilesSettings />
    {:else if $SettingsMenuIndex === 6}
        <AdvancedSettings />
    {:else if $SettingsMenuIndex === 7}
        <Communities />
    {:else if $SettingsMenuIndex === 8}
        <GlobalLoreBookSettings bind:openLoreList />
    {:else if $SettingsMenuIndex === 9}
        <GlobalRegex/>
    {:else if $SettingsMenuIndex === 10}
        <LanguageSettings/>
    {:else if $SettingsMenuIndex === 11}
        <AccessibilitySettings/>
    {:else if $SettingsMenuIndex === 12}
        <PersonaSettings/>
    {:else if $SettingsMenuIndex === 14}
        <ModuleSettings/>
    {:else if $SettingsMenuIndex === 13}
        <PromptSettings onGoBack={() => {
            $SettingsMenuIndex = 1
        }}/>
    {:else if $SettingsMenuIndex === 15 && window.innerWidth >= 768}
        <HotkeySettings/>
    {:else if $SettingsMenuIndex === 77}
        <ThanksPage/>
    {/if}
{/snippet}

{#if isMobile}
    <div class="fixed inset-0 z-40 bg-bgcolor flex flex-col w-full h-full text-textcolor overflow-hidden rs-setting-cont">
        <!-- Mobile Header (Safe Area Aware) -->
        <div class="w-full px-4 pt-[max(env(safe-area-inset-top),12px)] pb-3 border-b border-b-darkborderc bg-darkbg/95 backdrop-blur-md flex justify-between items-center shrink-0 z-20">
            <div class="flex items-center gap-2.5 min-w-0">
                {#if $SettingsMenuIndex !== -1}
                    <button
                        class="w-9 h-9 rounded-full bg-textcolor/10 hover:bg-textcolor/15 active:scale-95 flex items-center justify-center text-textcolor transition-all cursor-pointer shrink-0"
                        onclick={() => {
                            $SettingsMenuIndex = -1;
                        }}
                        aria-label="Back"
                    >
                        <ArrowLeft size={20} />
                    </button>
                {/if}
                <h1 class="font-bold text-lg text-textcolor truncate m-0">
                    {$SettingsMenuIndex === -1 ? language.settings : currentMenuTitle}
                </h1>
            </div>
            <button
                class="w-9 h-9 rounded-full bg-textcolor/10 hover:bg-textcolor/15 active:scale-95 flex items-center justify-center text-textcolor2 hover:text-textcolor transition-all cursor-pointer shrink-0"
                onclick={() => {
                    settingsOpen.set(false);
                }}
                aria-label="Close"
            >
                <XIcon size={18} />
            </button>
        </div>

        <!-- Mobile Content -->
        <div class="flex-1 overflow-y-auto min-w-0 bg-bgcolor">
            {#if $SettingsMenuIndex === -1}
                {@render mobileMenuList()}
            {:else}
                {#key $SettingsMenuIndex}
                    <div class="py-4 px-4 pb-[max(env(safe-area-inset-bottom),32px)] flex flex-col min-w-0">
                        {@render pageContent()}
                    </div>
                {/key}
            {/if}
        </div>
    </div>
{:else}
    <!-- Desktop Floating Modal -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
        class="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px] flex items-center justify-center p-4 sm:p-6 md:p-8 rs-setting-backdrop"
        role="presentation"
        onclick={(e) => {
            if (e.target === e.currentTarget) {
                settingsOpen.set(false);
            }
        }}
    >
        <div class="relative w-full max-w-5xl h-[86vh] max-h-[880px] bg-bgcolor rounded-2xl shadow-2xl border border-darkborderc overflow-hidden flex flex-row rs-setting-cont-2">
            <!-- Sidebar -->
            <div class="flex h-full flex-col p-4 pt-6 gap-2 overflow-y-auto relative rs-setting-cont-3 shrink-0 bg-darkbg border-r border-darkborderc w-64 md:w-72">
                {@render desktopMenuButtons()}
            </div>

            <!-- Content Area -->
            {#key $SettingsMenuIndex}
                <div class="grow py-6 px-6 bg-bgcolor flex flex-col text-textcolor overflow-y-auto relative rs-setting-cont-4 min-w-0">
                    {@render pageContent()}
                </div>
            {/key}

            <!-- Close Button -->
            <button
                class="absolute top-3 right-3 text-textcolor2 hover:text-textcolor p-1.5 rounded-lg hover:bg-textcolor/10 transition-colors z-10 cursor-pointer"
                onclick={() => {
                    settingsOpen.set(false);
                }}
                aria-label="Close"
            >
                <CircleXIcon size={settingsStore.state.settingsCloseButtonSize || 24} />
            </button>
        </div>
    </div>
{/if}

{#if openLoreList}
    <Lorepreset close={() => {openLoreList = false}} />
{/if}
{#if dbExplorerOpen && isNodeServer}
    <PostgresDbExplorerSettings close={() => {dbExplorerOpen = false}} />
{/if}
{#if storageExplorerOpen && isNodeServer}
    <StorageExplorerSettings close={() => {storageExplorerOpen = false}} />
{/if}