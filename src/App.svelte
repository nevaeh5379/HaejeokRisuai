<script lang="ts">
    import { DynamicGUI, settingsOpen, sideBarStore, ShowRealmFrameStore, openPresetList, openPersonaList, MobileGUI, MobileGUIStack, MobileSideBar, SettingsMenuIndex, CustomGUISettingMenuStore, loadedStore, alertStore, LoadingStatusState, bookmarkListOpen, popupStore, easyPanelStore, popUpEditorStore, loadoutModalStore, irisStore, customSideBarConfigDialogStore, assetManagerModalStore, messageSearchOpen, sqlConfiguredStore, pluginAlertModalStore, selectedCharID, PlaygroundStore, mobileSettingsReturnChar } from './ts/stores.svelte';
    import { settingsStore, moduleStore, characterStore, messageStore } from './ts/stores/domain';
    import { showRealmInfoStore } from './ts/realmStore';
    import { isCapacitor, isNodeServer, isTauri } from './ts/platform';
    import { registerPlugin } from '@capacitor/core';
    import { onMount } from 'svelte';
    import { ArrowUpIcon, GlobeIcon, PlusIcon } from '@lucide/svelte';
    import { hypaV3ModalOpen, hypaV3ProgressStore } from "./ts/stores.svelte";
    import sendSound from './etc/send.mp3'
    import { RISU_APP_INTERNAL_DRAG_TYPE, RISU_SIDEBAR_DRAG_TYPE } from './ts/dragTypes';
    import AirisuMascot from './lib/UI/AirisuMascot.svelte';
    import LazyComponent, { preloadLazy } from './lib/Others/LazyComponent.svelte';
    import type RealmPopUpType from './lib/UI/Realm/RealmPopUp.svelte';


  
    let didFirstSetup: boolean  = $derived(settingsStore.state.didFirstSetup)
    let gridOpen = $state(false)
    let aprilFools = $state(new Date().getMonth() === 3 && new Date().getDate() === 1)
    let aprilFoolsPage = $state(0)
    let keepingSessionAlive = $state(false)
    let RealmPopUp = $state<typeof RealmPopUpType | null>(null)
    let exitConfirmationOpen = false

    const nativeAppControl = registerPlugin<{ exitApp(): Promise<void> }>('NativeAppControl')

    onMount(() => {
        if (!isCapacitor) return

        const handleAndroidBack = async () => {
            if ($alertStore.type !== 'none') {
                alertStore.set({ type: 'none', msg: '' })
                return
            }
            if (assetManagerModalStore.open) { assetManagerModalStore.open = false; return }
            if (customSideBarConfigDialogStore.open) { customSideBarConfigDialogStore.open = false; return }
            if (irisStore.open) { irisStore.open = false; return }
            if (loadoutModalStore.open) { loadoutModalStore.open = false; return }
            if (popUpEditorStore.open) { popUpEditorStore.open = false; return }
            if (easyPanelStore.open) { easyPanelStore.open = false; return }
            if (popupStore.children) { popupStore.children = null; return }
            if ($messageSearchOpen) { $messageSearchOpen = false; return }
            if ($bookmarkListOpen) { $bookmarkListOpen = false; return }
            if ($openPersonaList) { $openPersonaList = false; return }
            if ($openPresetList) { $openPresetList = false; return }
            if ($ShowRealmFrameStore) { $ShowRealmFrameStore = ''; return }
            if (gridOpen) { gridOpen = false; return }
            if ($settingsOpen) {
                if ($SettingsMenuIndex > -1) $SettingsMenuIndex = -1
                else $settingsOpen = false
                return
            }
            if ($CustomGUISettingMenuStore) { $CustomGUISettingMenuStore = false; return }
            if ($MobileSideBar > 0) { $MobileSideBar = 0; return }
            if ($MobileGUI && $MobileGUIStack === 2 && mobileSettingsReturnChar.value) {
                const ret = mobileSettingsReturnChar.value;
                mobileSettingsReturnChar.value = null;
                $SettingsMenuIndex = -1;
                $selectedCharID = ret.charId;
                $MobileSideBar = ret.sideBar ?? 0;
                return;
            }
            if ($selectedCharID >= 0) { $selectedCharID = -1; return }
            if ($MobileGUI) {
                if ($MobileGUIStack === 2 && $SettingsMenuIndex > -1) { $SettingsMenuIndex = -1; return }
                if ($MobileGUIStack !== 1) { $MobileGUIStack = 1; return }
            } else {
                if ($MobileGUIStack === 2 && $SettingsMenuIndex > -1) { $SettingsMenuIndex = -1; return }
                if ($MobileGUIStack !== 0) { $MobileGUIStack = 0; return }
            }
            if (exitConfirmationOpen) return

            exitConfirmationOpen = true
            try {
                const [{ alertConfirm }, { language }] = await Promise.all([
                    import('./ts/alert'),
                    import('./lang'),
                ])
                if (await alertConfirm(language.exitAppConfirm)) {
                    const flushResults = await Promise.allSettled([
                        settingsStore.flush(),
                        characterStore.flush(),
                        messageStore.flush(),
                    ])
                    if (
                        flushResults.some((result) => result.status === 'rejected') ||
                        settingsStore.hasPendingWrites() ||
                        characterStore.hasPendingWrites() ||
                        messageStore.hasPendingWrites()
                    ) {
                        console.error('[App] Exit cancelled because data is still waiting to be saved')
                        return
                    }
                    await nativeAppControl.exitApp()
                }
            } finally {
                exitConfirmationOpen = false
            }
        }

        window.addEventListener('risu:android-back', handleAndroidBack)
        return () => window.removeEventListener('risu:android-back', handleAndroidBack)
    })

    const legalLoader = () => import('./lib/Others/Legal.svelte')
    const sqlQuickSetupLoader = () => import('./lib/Others/SqlQuickSetup.svelte')
    const customGUISettingMenuLoader = () => import('./lib/Setting/Pages/CustomGUISettingMenu.svelte')
    const welcomeLoader = () => import('./lib/Others/WelcomeRisu.svelte')
    const settingsLoader = () => import('./lib/Setting/Settings.svelte')
    const mobileHeaderLoader = () => import('./lib/Mobile/MobileHeader.svelte')
    const mobileBodyLoader = () => import('./lib/Mobile/MobileBody.svelte')
    const mobileFooterLoader = () => import('./lib/Mobile/MobileFooter.svelte')
    const gridLoader = () => import('./lib/Others/GridCatalog.svelte')
    const sidebarLoader = () => import('./lib/SideBars/Sidebar.svelte')
    const chatScreenLoader = () => import('./lib/ChatScreens/ChatScreen.svelte')
    const mainMenuLoader = () => import('./lib/UI/HomeScreen.svelte')
    const alertLoader = () => import('./lib/Others/AlertComp.svelte')
    const realmFrameLoader = () => import('./lib/UI/Realm/RealmFrame.svelte')
    const botPresetLoader = () => import('./lib/Setting/botpreset.svelte')
    const personaLoader = () => import('./lib/Setting/listedPersona.svelte')
    const bookmarkLoader = () => import('./lib/Others/BookmarkList.svelte')
    const messageSearchLoader = () => import('./lib/Others/MessageSearch.svelte')
    const hypaModalLoader = () => import('./lib/Others/HypaV3Modal.svelte')
    const hypaProgressLoader = () => import('./lib/Others/HypaV3Progress.svelte')
    const pluginAlertLoader = () => import('./lib/Others/PluginAlertModal.svelte')
    const popupListLoader = () => import('./lib/UI/PopupList.svelte')
    const easyPanelLoader = () => import('./lib/Others/ProTools/EasyPanel.svelte')
    const popupEditorLoader = () => import('./lib/Others/PopupEditor.svelte')
    const loadoutLoader = () => import('./lib/Others/LoadoutModal.svelte')
    const irisLoader = () => import('./lib/Others/IrisModal.svelte')
    const sidebarConfigLoader = () => import('./lib/Others/CustomSidebarConfig.svelte')
    const assetManagerLoader = () => import('./lib/Others/AssetManagerModal.svelte')
    const savePopupLoader = () => import('./lib/Others/SavePopupIcon.svelte')

    $effect(() => {
        if ($showRealmInfoStore && !RealmPopUp) {
            void import('./lib/UI/Realm/RealmPopUp.svelte').then((module) => {
                RealmPopUp = module.default
            })
        }
    })

    $effect(() => {
        if ($sideBarStore || $selectedCharID) {
            preloadLazy(assetManagerLoader)
        }
    })

    const getMainDropEffect = (e:DragEvent): DataTransfer['dropEffect'] => {
        const types = Array.from(e.dataTransfer?.types ?? [])
        if(types.includes(RISU_SIDEBAR_DRAG_TYPE)){
            return 'none'
        }
        if(types.includes(RISU_APP_INTERNAL_DRAG_TYPE)){
            return 'none'
        }
        return types.includes('Files') ? 'copy' : 'none'
    }

    const markAppInternalDrag = (e:DragEvent) => {
        e.dataTransfer?.setData(RISU_APP_INTERNAL_DRAG_TYPE, 'true')
    }

</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<main class="flex bg-bg w-full h-full max-w-100vw text-textcolor" class:tauri-native={isTauri} ondragover={(e) => {
    const dropEffect = getMainDropEffect(e)
    e.preventDefault()
    e.dataTransfer.dropEffect = dropEffect
}} ondragstart={markAppInternalDrag} ondrop={async (e) => {
    const types = Array.from(e.dataTransfer.types ?? [])
    if (types.includes(RISU_APP_INTERNAL_DRAG_TYPE) || types.includes(RISU_SIDEBAR_DRAG_TYPE)) {
        e.preventDefault()
        return
    }
    const file = e.dataTransfer.files[0]
    if (!file) {
        e.preventDefault()
        return
    }
    e.preventDefault()
    const name = file.name.toLowerCase()

    if (name.endsWith('.risup')) {
        const [{ language }, { alertNormal }] = await Promise.all([import('./lang'), import('./ts/alert')])
        const data = new Uint8Array(await file.arrayBuffer())
        const { importPreset } = await import('./ts/storage/presets/presetService')
        await importPreset({ name: file.name, data })
        alertNormal(language.successImport)
    } else if (name.endsWith('.risum')) {
        const [{ language }, { alertNormal }] = await Promise.all([import('./lang'), import('./ts/alert')])
        const data = new Uint8Array(await file.arrayBuffer())
        const { readModule } = await import('./ts/process/modules')
        const module = await readModule(Buffer.from(data))
        await moduleStore.installModule(module)
        alertNormal(language.successImport)
    } else {
        const { importCharacterProcess } = await import('./ts/characterCards')
        await importCharacterProcess({
            name: file.name,
            data: file
        })
        const { checkCharOrder } = await import('./ts/globalApi.svelte')
        checkCharOrder()
    }
}} onclick={() => {
    if(keepingSessionAlive){
        return
    }

    const aliveMode = settingsStore.state?.keepSessionAlive
    switch(aliveMode){
        case 'pip':{

            break
        }
        case 'sound':{
            console.log("Starting silent audio to keep session alive")
            const silentAudio = new Audio(sendSound);
            silentAudio.loop = true;
            silentAudio.volume = 0.000001;
            silentAudio.play();
            keepingSessionAlive = true;
            break
        }
    }

}}>
    {#if !(import.meta.env.VITE_RISU_LEGAL_CONFIGURED || globalThis.__RISU_LEGAL_CONFIGURED__)}
        <LazyComponent loader={legalLoader} />
    {:else if aprilFools}

        <div class="bg-[#212121] w-full h-screen min-h-screen text-black flex relative">
            <div class="w-full max-w-3xl mx-auto py-8 px-4 flex justify-center items-center">
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div class="flex flex-col w-full items-center text-[#bbbbbb]">
                    {#if aprilFoolsPage === 0}
                        <h1 class="text-3xl text-white font-bold mb-6">What can I help you?</h1>
                        <div class="resize-none relative w-full bg-[#303030] rounded-3xl h-[110px] mb-6 text-[#bbbbbb]" placeholder="Ask me" onkeydown={(e) => {
                            if(e.key === 'Enter'){
                                aprilFoolsPage = 1
                            }
                        }}>
                            <textarea class="absolute top-0 left-0 w-full placeholder-[#bbbbbb] rounded-3xl h-full p-4 bg-transparent resize-none" placeholder="Ask me"></textarea>
                            <div class="absolute bottom-2 left-4 flex gap-1.5">
                                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                                    <PlusIcon size={18} color="#bbbbbb" />
                                </button>
                                <button class="p-2 rounded-full border border-[#bbbbbb30]">
                                    <GlobeIcon size={18} color="#bbbbbb" />
                                </button>
                                
                            </div>
                            <div class="absolute bottom-2 right-4 flex">
                                <button class="p-2 rounded-full bg-[#bbbbbb]">
                                    <ArrowUpIcon size={18} color="#00000080" />
                                </button>
                            </div>
                        </div>
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <div class="flex gap-1.5" onclick={() => {
                            aprilFoolsPage = 1
                        }}>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🔍</span>
                                Search
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🎮</span>
                                Games
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                <span class="text-[#bbbbbb]">🎨</span>
                                Roleplay
                            </button>
                            <button class="rounded-full border border-[#bbbbbb15] px-4 py-2">
                                More
                            </button>
                        </div>
                    {:else}
                    <h1 class="text-3xl text-white font-bold mb-6">
                        We do not have search results.
                    </h1>
                    <p class="text-[#bbbbbb] mb-6">
                        <!-- svelte-ignore a11y_missing_attribute -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <a class="text-blue-500 cursor-pointer" onclick={() => {
                            aprilFoolsPage = 0
                            aprilFools = false
                        }}>
                            Go to Risuai  
                        </a>
                    </p>

                    {/if}
                </div>
            </div>
            <span class="absolute top-4 left-4 font-bold text-[#bbbbbb] text-md md:text-lg">RisyGTP 9+ Mytho Ultra Free</span>
        </div>
    {:else if !$loadedStore}
        {#if isNodeServer && $sqlConfiguredStore === false}
            <LazyComponent loader={sqlQuickSetupLoader} />
        {:else}
            <div class="w-full h-full flex justify-center items-center text-textcolor bg-bgcolor flex-col px-6" aria-live="polite">
                <div class="airisu-loading-step motion-reduce:animate-none">
                    <AirisuMascot variant="progress" className="w-36 sm:w-44 drop-shadow-xl" eager />
                </div>
                <div class="mt-3 flex items-center gap-2 text-lg font-semibold">
                    <span class="h-2 w-2 rounded-full bg-textcolor2 motion-safe:animate-pulse"></span>
                    <span>Loading...</span>
                </div>
                <span class="text-sm mt-1.5 text-center text-textcolor2">{LoadingStatusState.text}</span>
            </div>
        {/if}
    {:else if $CustomGUISettingMenuStore}
        <LazyComponent loader={customGUISettingMenuLoader} />
    {:else if !didFirstSetup}
        <LazyComponent loader={welcomeLoader} />
    {:else if isNodeServer && $sqlConfiguredStore === false}
        <LazyComponent loader={sqlQuickSetupLoader} />
    {:else if $MobileGUI}
        <div class="w-full h-full flex flex-col">
            <LazyComponent loader={mobileHeaderLoader} />
            <LazyComponent loader={mobileBodyLoader} />
            <LazyComponent loader={mobileFooterLoader} />
        </div>
    {:else}
        {#if gridOpen}
            <LazyComponent loader={gridLoader} props={{ endGrid: () => { gridOpen = false } }} />
        {:else}
            {#if (!$DynamicGUI)}
                <LazyComponent loader={sidebarLoader} props={{ openGrid: () => { gridOpen = true }, hidden: !$sideBarStore }} />
            {:else}
                <div class="top-0 w-full h-full left-0 z-30 flex flex-row items-center" class:fixed={$sideBarStore} class:hidden={!$sideBarStore} >
                    <!-- svelte-ignore a11y_click_events_have_key_events -->
                    <LazyComponent loader={sidebarLoader} props={{ openGrid: () => { gridOpen = true }, hidden: false }} />



                </div>
            {/if}
            {#if $selectedCharID < 0 && $PlaygroundStore === 0}
                <LazyComponent loader={mainMenuLoader} />
            {:else}
                <LazyComponent loader={chatScreenLoader} />
            {/if}
        {/if}
    {/if}
    {#if $settingsOpen && !$MobileGUI}
        <LazyComponent loader={settingsLoader} />
    {/if}
    {#if $alertStore.type !== 'none'}
        <LazyComponent loader={alertLoader} />
    {/if}
    {#if $showRealmInfoStore && RealmPopUp}
        <RealmPopUp bind:openedData={$showRealmInfoStore} />
    {/if}
    {#if $ShowRealmFrameStore}
        <LazyComponent loader={realmFrameLoader} />
    {/if}
    {#if $openPresetList}
        <LazyComponent loader={botPresetLoader} props={{ close: () => { $openPresetList = false } }} />
    {/if}
    {#if $openPersonaList}
        <LazyComponent loader={personaLoader} props={{ close: () => { $openPersonaList = false } }} />
    {/if}
    {#if $bookmarkListOpen}
        <LazyComponent loader={bookmarkLoader} />
    {/if}
    {#if $messageSearchOpen}
        <LazyComponent loader={messageSearchLoader} />
    {/if}
    {#if $hypaV3ModalOpen}
        <LazyComponent loader={hypaModalLoader} />
    {/if}
    <LazyComponent loader={savePopupLoader} />
    {#if $hypaV3ProgressStore.open}
        <LazyComponent loader={hypaProgressLoader} />
    {/if}
    {#if pluginAlertModalStore.open}
        <LazyComponent loader={pluginAlertLoader} />
    {/if}
    {#if popupStore.children}
        <LazyComponent loader={popupListLoader} />
    {/if}
    {#if easyPanelStore.open}
        <LazyComponent loader={easyPanelLoader} />
    {/if}
    {#if popUpEditorStore.open}
        <LazyComponent loader={popupEditorLoader} />
    {/if}
    {#if loadoutModalStore.open}
        <LazyComponent loader={loadoutLoader} />
    {/if}
    {#if irisStore.open}
        <LazyComponent loader={irisLoader} />
    {/if}
    {#if customSideBarConfigDialogStore.open}
        <LazyComponent loader={sidebarConfigLoader} />
    {/if}
    {#if assetManagerModalStore.open}
        <LazyComponent loader={assetManagerLoader} />
    {/if}
</main>

<style>
    @keyframes airisu-loading-step {
        0%, 100% {
            transform: translate3d(-5px, 0, 0) rotate(-1deg);
        }
        50% {
            transform: translate3d(5px, -5px, 0) rotate(1deg);
        }
    }

    .airisu-loading-step {
        animation: airisu-loading-step 0.85s ease-in-out infinite;
    }

    @media (prefers-reduced-motion: reduce) {
        .airisu-loading-step {
            animation: none;
        }
    }
</style>
