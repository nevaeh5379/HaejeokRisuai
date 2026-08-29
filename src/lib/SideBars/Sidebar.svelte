<script lang="ts">
    import {
    CharEmotion,
    DynamicGUI,
    botMakerMode,
    selectedCharID,
    settingsOpen,
    sideBarClosing,
    sideBarStore,
    OpenRealmStore,
    PlaygroundStore,

    QuickSettings,

    additionalHamburgerMenu,

    messageSearchOpen,
    pendingCharID,

  } from "../../ts/stores.svelte";
    import type { folder } from "../../ts/storage/database/schema";

    import { characterStore, settingsStore } from 'src/ts/stores/domain';
    import BarIcon from "./BarIcon.svelte";
    import SidebarIndicator from "./SidebarIndicator.svelte";
    import {
    ShellIcon,
    Settings,
    ListIcon,
    LayoutGridIcon,
    FolderIcon,
    FolderOpenIcon,
    HomeIcon,
    WrenchIcon,
    User2Icon,
    SearchIcon,
  } from "@lucide/svelte";
    import { getCharImage, preloadCharacterImage } from '../../ts/characterImage';
    import { language } from "../../lang";
    import isEqual from "lodash/isEqual";
    import SidebarAvatar from "./SidebarAvatar.svelte";
    import BaseRoundedButton from "../UI/BaseRoundedButton.svelte";
    import { getCharacterIndexObject, selectSingleFile } from "src/ts/util";
    import { v4 } from "uuid";
    import { checkCharOrder, getFileSrc, getPreparedNativeThumbnailSrc, saveAsset } from "src/ts/globalApi.svelte";
    import { alertInput, alertSelect } from "src/ts/alert";
    import { ConnectionIsHost, ConnectionOpenStore, RoomIdStore } from 'src/ts/sync/multiuserState';
  import { sideBarSize } from "src/ts/gui/guisize";
    import LazyComponent from '../Others/LazyComponent.svelte';
    import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
    import { RISU_SIDEBAR_DRAG_TYPE } from "src/ts/dragTypes";
    import { get } from 'svelte/store';
    import { loadCharConfig, loadSideChatList, preloadChatSidebarPanel } from './sidebarPanelLoaders';
    import { btwRuntime } from 'src/ts/process/btwRuntime.svelte';
  let sideBarMode = $state(0);
  let editMode = $state(false);
  let menuMode = $state(0);
  let devTool = $state(false)

  const recentSessionsLoader = () => import('./RecentSessionsList.svelte')
  const devToolLoader = () => import('./DevTool.svelte')
  const quickSettingsLoader = () => import('../Others/QuickSettingsGUI.svelte')
  const btwPanelLoader = () => import('../ChatScreens/BtwPanel.svelte')

  function sidebarThumbnail(loc: string) {
    return getPreparedNativeThumbnailSrc(loc) ?? getCharImage(loc, "plain", { thumbnail: true })
  }

  async function changeCharacter(index: number) {
    // Reflect the tap before loading the character module or persisted chat data,
    // without exposing partially loaded character data to the chat components.
    reseter()
    pendingCharID.set(index)
    void preloadChatSidebarPanel()
    void preloadCharacterImage(characterStore.characters?.[index]?.image)
    const { changeChar } = await import('../../ts/characters')
    if (get(pendingCharID) !== index) {
      return
    }
    void changeChar(index)
  }

  async function addNewCharacter() {
    const { addCharacter } = await import('../../ts/characters')
    addCharacter({ reseter })
  }

  function reseter() {
    pendingCharID.set(-1)
    menuMode = 0;
    sideBarMode = 0;
    editMode = false;
    settingsOpen.set(false);
    CharEmotion.set({});
  }

  type sortTypeNormal = { type:'normal',img: string, index: number, name:string }
  type sortType =  sortTypeNormal|{type:'folder',folder:sortTypeNormal[],id:string, name:string, color:string, img?:string}
  let charImages: sortType[] = $state([]);
  const iconRounded = $derived(settingsStore.state.roundIcons);
  let openFolders:string[] = $state([])
  let currentDrag: DragData | null = $state(null)
  interface Props {
    openGrid?: () => void;
    hidden?: boolean;
  }

  let { openGrid = () => {}, hidden = false }: Props = $props();

  sideBarClosing.set(false)

  function buildCharList(): sortType[] {
    const newCharImages: sortType[] = [];
    const idObject = getCharacterIndexObject()
    for (const id of settingsStore.state.characterOrder) {
      if(typeof(id) === 'string'){
        const index = idObject[id] ?? -1
        if(index !== -1){
          const cha = characterStore.characters[index]
          newCharImages.push({
            img:cha.image ?? "",
            index:index,
            type: "normal",
            name: cha.name
          });
        }
      }
      else{
        const folder = id
        const folderCharImages: sortTypeNormal[] = []
        for(const entryId of folder.data){
          const index = idObject[entryId] ?? -1
          if(index !== -1){
            const cha = characterStore.characters[index]
            folderCharImages.push({
              img:cha.image ?? "",
              index:index,
              type: "normal",
              name: cha.name
            });
          }
        }
        newCharImages.push({
          folder: folderCharImages,
          type: "folder",
          id: folder.id,
          name: folder.name,
          color: folder.color,
          img: folder.imgFile,
        });
      }
    }
    return newCharImages;
  }

  $effect(() => {
    const nextCharImages = buildCharList();
    if (!isEqual(charImages, nextCharImages)) {
      charImages = nextCharImages;
    }
  })


  const inserter = (mainIndex:DragData, targetIndex:DragData) => {
    if(mainIndex.index === targetIndex.index && mainIndex.folder === targetIndex.folder){
      return
    }
    let db = settingsStore.state
    let mainFolderIndex = mainIndex.folder ? getFolderIndex(mainIndex.folder) : null
    let targetFolderIndex = targetIndex.folder ? getFolderIndex(targetIndex.folder) : null
    let mainFolderId = mainIndex.folder ? (db.characterOrder[mainFolderIndex] as folder).id : ''
    let movingFolder:folder|false = false
    let mainId = ''
    if(mainIndex.folder){
      mainId = (db.characterOrder[mainFolderIndex] as folder).data[mainIndex.index]
    }
    else{
      const da = db.characterOrder[mainIndex.index]
      if(typeof(da) !== 'string'){
        mainId = da.id
        movingFolder = $state.snapshot(da)
        if(targetIndex.folder){
          return
        }
      }
      else{
        mainId = da
      }
    }
    if(targetIndex.folder){
        const folder = db.characterOrder[targetFolderIndex] as folder
        folder.data.splice(targetIndex.index,0,mainId)
        db.characterOrder[targetFolderIndex] = folder
    }
    else if(movingFolder){
        db.characterOrder.splice(targetIndex.index,0,movingFolder)
    }
    else{
        db.characterOrder.splice(targetIndex.index,0,mainId)
    }
    if(mainIndex.folder){
      mainFolderIndex = -1
      for(let i=0;i<db.characterOrder.length;i++){
        const a =db.characterOrder[i]
        if(typeof(a) !== 'string'){
          if(a.id === mainFolderId){
            mainFolderIndex = i
            break
          }
        }
      }
      if(mainFolderIndex !== -1){
        const folder:folder = db.characterOrder[mainFolderIndex] as folder
        const ind = mainIndex.index > targetIndex.index ? folder.data.lastIndexOf(mainId) : folder.data.indexOf(mainId) 
        if(ind !== -1){
          folder.data.splice(ind, 1)
        }
        db.characterOrder[mainFolderIndex] = folder
      }
      else{
        console.log('folder not found')
      }
    }
    else if(movingFolder){
      let idList:string[] = []
      for(const ord of db.characterOrder){
        idList.push(typeof(ord) === 'string' ? ord : ord.id)
      }
      const ind = mainIndex.index > targetIndex.index ? idList.lastIndexOf(mainId) : idList.indexOf(mainId) 
      if(ind !== -1){
        db.characterOrder.splice(ind, 1)
      }
    }
    else{
      const ind = mainIndex.index > targetIndex.index ? db.characterOrder.lastIndexOf(mainId) : db.characterOrder.indexOf(mainId) 
      if(ind !== -1){
        db.characterOrder.splice(ind, 1)
      }
    }

    settingsStore.state.characterOrder = db.characterOrder
    checkCharOrder()
  }

  function getFolderIndex(id:string){
    for(let i=0;i<settingsStore.state.characterOrder.length;i++){
      const data = settingsStore.state.characterOrder[i]
      if(typeof(data) !== 'string' && data.id === id){
        return i
      }
    }
    return -1
  }

  function scrollToActiveCharacter() {
    const selectedId = $selectedCharID
    if (selectedId === -1) return
    
    const characterId = characterStore.characters[selectedId]?.chaId
    if (!characterId) return
    
    let targetFolderId: string | null = null
    
    for (const item of charImages) {
      if (item.type === 'folder') {
        const foundChar = item.folder.find(c => 
          characterStore.characters[c.index]?.chaId === characterId
        )
        if (foundChar) {
          targetFolderId = item.id
          break
        }
      }
    }
    
    if (targetFolderId && !openFolders.includes(targetFolderId)) {
      openFolders.push(targetFolderId)
      openFolders = openFolders
    }
    
    setTimeout(() => {
      const activeElement = document.querySelector(`[data-char-id="${characterId}"]`)
      if (activeElement) {
        activeElement.scrollIntoView({ 
          behavior: 'smooth', 
          block: 'start' 
        })
      }
    }, 100)
  }

  $effect(() => {
    if (typeof window === 'undefined') return
    
    const handler = () => {
      scrollToActiveCharacter()
    }
    
    window.addEventListener('scrollToActiveCharacter', handler)
    
    return () => {
      window.removeEventListener('scrollToActiveCharacter', handler)
    }
  })


  const createFolder = (mainIndex:DragData, targetIndex:DragData) => {
    if(mainIndex.index === targetIndex.index && mainIndex.folder === targetIndex.folder){
      return
    }
    let db = settingsStore.state
    let mainFolderIndex = mainIndex.folder ? getFolderIndex(mainIndex.folder) : null
    let mainFolder = db.characterOrder[mainFolderIndex] as folder
    if(targetIndex.folder){
      return
    }
    const main = mainIndex.folder ? mainFolder.data[mainIndex.index] : db.characterOrder[mainIndex.index]
    const target = db.characterOrder[targetIndex.index]
    if(typeof(main) !== 'string'){
      return
    }
    if(typeof (target) === 'string'){
      const newFolder:folder = {
        name: "New Folder",
        data: [main, target],
        color: "",
        id: v4()
      }
      db.characterOrder[targetIndex.index] = newFolder
      if(mainIndex.folder){
        mainFolder.data.splice(mainIndex.index, 1)
        db.characterOrder[mainFolderIndex] = mainFolder
      }
      else{
        db.characterOrder.splice(mainIndex.index, 1)
      }
    }
    else{
      target.data.push(main)
      if(mainIndex.folder){
        mainFolder.data.splice(mainIndex.index, 1)
        db.characterOrder[mainFolderIndex] = mainFolder
      }
      else{
        db.characterOrder.splice(mainIndex.index, 1)
      }
    }

    settingsStore.state.characterOrder = db.characterOrder
    checkCharOrder()
  }

  type DragEv = DragEvent & {
    currentTarget: EventTarget & HTMLDivElement;
  }
  type DragData = {
    index:number,
    folder?:string
  }
  const avatarDragStart = (ind:DragData, e:DragEv) => {
    e.dataTransfer.setData('text/plain', '');
    e.dataTransfer.setData(RISU_SIDEBAR_DRAG_TYPE, 'true');
    currentDrag = ind
    const avatar = e.currentTarget.querySelector('.avatar')
    if(avatar){
      e.dataTransfer.setDragImage(avatar, 10, 10);
    }
  }

  const clearCurrentDrag = () => {
    currentDrag = null
  }

  $effect(() => {
    if (typeof window === 'undefined') return

    window.addEventListener('dragend', clearCurrentDrag)
    window.addEventListener('drop', clearCurrentDrag)
    window.addEventListener('blur', clearCurrentDrag)

    return () => {
      window.removeEventListener('dragend', clearCurrentDrag)
      window.removeEventListener('drop', clearCurrentDrag)
      window.removeEventListener('blur', clearCurrentDrag)
    }
  })

  const getCurrentSidebarDrag = (e:DragEvent) => {
    if(!currentDrag || !e.dataTransfer?.types.includes(RISU_SIDEBAR_DRAG_TYPE)){
      return null
    }
    return currentDrag
  }

  const avatarDragOver = (e:DragEv) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
  }

  const avatarDrop = (ind:DragData, e:DragEv) => {
    const drag = getCurrentSidebarDrag(e)
    if(!drag){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    try {
      createFolder(drag,ind)
    } catch (error) {
      console.error('avatarDrop error:', error)
    } finally {
      clearCurrentDrag()
    }
  }

  const preventAll = (e:DragEvent) => {
    if(!getCurrentSidebarDrag(e)){
      return
    }
    e.preventDefault()
    e.stopPropagation()
    return false
  }

  const toDragData = (index: number, folderId: string | undefined): DragData => {
    if (folderId === undefined) {
      return { index }
    }
    return { index, folder: folderId }
  }

  function goHome() {
    reseter();
    selectedCharID.set(-1)
    PlaygroundStore.set(0)
    OpenRealmStore.set(false)
  }

  function toggleSettings() {
    if ($settingsOpen) {
      reseter();
      settingsOpen.set(false);
    } else {
      reseter();
      settingsOpen.set(true);
    }
  }

  function openCharacterGrid() {
    reseter();
    openGrid();
  }

  function togglePlayground() {
    reseter()
    if ($selectedCharID === -1 && $PlaygroundStore !== 0) {
      PlaygroundStore.set(0)
      return
    }
    selectedCharID.set(-1)
    PlaygroundStore.set(1)
  }

  function openPlayground() {
    reseter();
    selectedCharID.set(-1)
    PlaygroundStore.set(1)
  }

  function openMessageSearch() {
    reseter();
    messageSearchOpen.set(true);
  }

  const folderColorBg: Record<string, string> = {
    red: 'bg-red-700/20',
    yellow: 'bg-yellow-700/20',
    green: 'bg-green-700/20',
    blue: 'bg-blue-700/20',
    indigo: 'bg-indigo-700/20',
    purple: 'bg-purple-700/20',
    pink: 'bg-pink-700/20',
  }

  function toggleFolderOpen(folderId: string) {
    if (openFolders.includes(folderId)) {
      openFolders.splice(openFolders.indexOf(folderId), 1)
    }
    else {
      openFolders.push(folderId)
    }
    openFolders = openFolders
  }

  async function handleFolderContextMenu(e: MouseEvent, ind: number, currentName: string) {
    e.preventDefault()
    const sel = parseInt(await alertSelect([language.renameFolder, language.changeFolderColor, language.changeFolderImage, language.cancel]))
    if(sel === 0){
      const v = await alertInput(language.changeFolderName, [], currentName)
      const db = settingsStore.state
      if(v){
        const orderEntry = db.characterOrder[ind]
        if(typeof(orderEntry) === 'string'){
          return
        }
        orderEntry.name = v
        db.characterOrder[ind] = orderEntry
      }
    }
    else if(sel === 1){
      const colors = ["red","green","blue","yellow","indigo","purple","pink","default"]
      const colorSel = parseInt(await alertSelect(colors))
      const db = settingsStore.state
      const orderEntry = db.characterOrder[ind]
      if(typeof(orderEntry) === 'string'){
        return
      }
      orderEntry.color = colors[colorSel].toLocaleLowerCase()
      db.characterOrder[ind] = orderEntry
    }
    else if(sel === 2) {
      const imageSel = parseInt(await alertSelect(['Reset to Default Image', 'Select Image File']))
      const db = settingsStore.state
      const orderEntry = db.characterOrder[ind]
      if(typeof(orderEntry) === 'string'){
        return
      }

      switch (imageSel) {
        case 0:
          orderEntry.imgFile = null
          orderEntry.img = ''
          break;

        case 1: {
          const folderImage = await selectSingleFile([
            'png',
            'jpg',
            'webp',
          ])

          if(!folderImage) {
            return
          }

          const folderImageData = await saveAsset(folderImage.data)

          orderEntry.imgFile = folderImageData
          orderEntry.img = await getFileSrc(folderImageData)
          db.characterOrder[ind] = orderEntry
          break;
        }
      }
    }
  }
</script>

{#snippet dropZone(dropIndex: number, folderId: string | undefined, zoneClass: string)}
<div
  class="h-4 min-h-4 w-14 {zoneClass}"
  role="listitem"
  ondragover={(e) => {
    if(!getCurrentSidebarDrag(e)){ return }
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    e.currentTarget.classList.add('bg-green-500')
  }}
  ondragleave={(e) => {
    e.currentTarget.classList.remove('bg-green-500')
  }}
  ondrop={(e) => {
    const drag = getCurrentSidebarDrag(e)
    if(!drag){ return }
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.classList.remove('bg-green-500')
    try {
      if(folderId === undefined){
        inserter(drag,{index: dropIndex})
      }
      else{
        inserter(drag,{index: dropIndex, folder: folderId})
      }
    } finally {
      clearCurrentDrag()
    }
  }}
  ondragenter={preventAll}
></div>
{/snippet}

{#snippet charItem(index: number, img: string, name: string, folderId: string | undefined, itemClass: string)}
<div
  class={itemClass}
  role="listitem"
  draggable="true"
  ondragstart={(e) => { avatarDragStart(toDragData(index, folderId), e) }}
  ondragend={clearCurrentDrag}
  ondragover={avatarDragOver}
  ondrop={(e) => { avatarDrop(toDragData(index, folderId), e) }}
  ondragenter={preventAll}
>
  <SidebarIndicator
    isActive={($pendingCharID === index || ($pendingCharID < 0 && $selectedCharID === index)) && sideBarMode !== 1}
  />
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    role="button" tabindex="0"
    onpointerenter={() => void preloadChatSidebarPanel()}
    onfocus={() => void preloadChatSidebarPanel()}
    onclick={() => {
      void changeCharacter(index)
    }}
    onkeydown={(e) => {
      if (e.key === "Enter") {
        void changeCharacter(index)
      }
    }}
  >
    <SidebarAvatar
      src={img ? () => sidebarThumbnail(img) : "/none.webp"}
      size="56"
      rounded={iconRounded}
      name={name}
      chaId={characterStore.characters[index]?.chaId}
    />
  </div>
</div>
{/snippet}

{#snippet hamburgerMenuItems()}
  <BarIcon
    onClick={toggleSettings}><Settings /></BarIcon
  >
  <div class="mt-2"></div>
  <BarIcon
    onClick={goHome}><HomeIcon /></BarIcon>
  <div class="mt-2"></div>
  <BarIcon
    onClick={togglePlayground}
  ><ShellIcon /></BarIcon>
  <div class="mt-2"></div>
  <BarIcon
    onClick={openMessageSearch}><SearchIcon /></BarIcon
  >
  {#each additionalHamburgerMenu as menu}
    <div class="mt-2"></div>
    <BarIcon
      onClick={() => {
        reseter();
        menu.callback();
      }}>
      <PluginDefinedIcon ico={menu} />
    </BarIcon>
  {/each}
  <div class="mt-2"></div>
  <BarIcon
    onClick={openCharacterGrid}><LayoutGridIcon /></BarIcon
  >
{/snippet}

{#snippet hamburgerPanel(position: 'top' | 'bottom')}
<div
  class={position === 'top'
    ? "mt-2 border-b border-b-selected w-full relative text-white"
    : "border-t border-t-selected w-full relative text-white"}
>
  {#if menuMode === 1}
    <div
      class={position === 'top'
        ? "absolute w-20 min-w-20 flex border-b-selected border-b bg-bgcolor flex-col items-center pt-2 rounded-b-md z-20 pb-2"
        : "absolute bottom-full w-20 min-w-20 flex border-t-selected border-t bg-bgcolor flex-col items-center pt-2 rounded-t-md z-20 pb-2"}
    >
      {@render hamburgerMenuItems()}
    </div>
  {/if}
</div>
{/snippet}

{#if settingsStore.state.menuSideBar}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full mt-4"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore === 0 &&
    !$settingsOpen
  )}
  onclick={goHome}
>
  <HomeIcon />
  <span class="text-xs">{language.home}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!$settingsOpen}
  onclick={toggleSettings}
>
  <Settings />
  <span class="text-xs">{language.settings}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID >= 0
  )}
  onclick={openCharacterGrid}
>
  <User2Icon />
  <span class="text-xs">{language.character}</span>
</button>
<button
  class="flex items-center justify-center py-2 flex-col gap-1 w-full"
  class:text-textcolor2={!(
    $selectedCharID < 0 &&
    $PlaygroundStore !== 0
  )}
  onclick={openPlayground}
>
  <ShellIcon />
  <span class="text-xs">{language.playground.playground}</span>
</button>
</div>
{:else}
<div
  class="h-full w-20 min-w-20 flex-col items-center bg-bgcolor text-textcolor shadow-lg relative rs-sidebar"
  class:editMode
  class:risu-sub-sidebar={$sideBarClosing}
  class:risu-sub-sidebar-close={$sideBarClosing}
  class:hidden={hidden}
  class:flex={!hidden}
>
  {#if !settingsStore.state.hamburgerButtonBottom}
  <button
    class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-blue-500"
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {@render hamburgerPanel('top')}
  {/if}
  <div class="flex grow w-full flex-col items-center overflow-x-hidden overflow-y-auto pr-0">
    {@render dropZone(0, undefined, '')}
    {#each charImages as char, ind}
      {#if char.type === 'normal'}
        {@render charItem(char.index, char.img, char.name, undefined, "group relative flex items-center px-2 [content-visibility:auto] [contain-intrinsic-size:64px]")}
      {:else if char.type === "folder"}
        <div class="group relative flex items-center px-2 [content-visibility:auto] [contain-intrinsic-size:64px]"
          role="listitem"
          draggable="true"
          ondragstart={(e) => { avatarDragStart({index: ind}, e) }}
          ondragend={clearCurrentDrag}
          ondragover={avatarDragOver}
          ondrop={(e) => { avatarDrop({index: ind}, e) }}
          ondragenter={preventAll}
        >
          <SidebarIndicator isActive={false} />
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            role="button" tabindex="0"
            onpointerenter={() => void preloadChatSidebarPanel()}
            onfocus={() => void preloadChatSidebarPanel()}
          >
            {#key char.color}
            {#key char.name}
              <SidebarAvatar src="slot" size="56" rounded={iconRounded} bordered name={char.name} color={char.color} backgroundimg={char.img ? () => sidebarThumbnail(char.img) : ""}
                oncontextmenu={(e) => void handleFolderContextMenu(e, ind, char.name)}
                onClick={() => {
                  if(char.type !== 'folder'){
                    return
                  }
                  toggleFolderOpen(char.id)
                }}>
                {#if settingsStore.state.showFolderName}
                  <div class="h-full w-full flex justify-center items-center">
                    <span class="hyphens-auto truncate font-bold">{char.name}</span>
                  </div>
                {:else if openFolders.includes(char.id)}
                  <FolderOpenIcon />
                {:else}
                  <FolderIcon />
                {/if}
              </SidebarAvatar>
            {/key}
            {/key}
          </div>
        </div>
        {#if openFolders.includes(char.id)}
          {#key char.color}
          <div class="p-1 flex flex-col items-center py-1 mt-1 rounded-lg relative">
            <div class="absolute top-0 left-1 border border-selected w-full h-full rounded-lg z-0 {folderColorBg[char.color] ?? 'bg-darkbg/20'}"></div>
            {@render dropZone(0, char.id, "relative z-10")}
            {#each char.folder as char2, ind2}
              {@render charItem(char2.index, char2.img, char2.name, char.id, "group relative flex items-center px-2 z-10")}
              {@render dropZone(ind2 + 1, char.id, "relative z-20")}
            {/each}
          </div>
          {/key}
        {/if}
      {/if}
      {@render dropZone(ind + 1, undefined, '')}
    {/each}
    <div class="flex flex-col items-center gap-2 px-2">
      <BaseRoundedButton
        onClick={async () => {
          void addNewCharacter()
        }}
        ><svg viewBox="0 0 24 24" width="1.2em" height="1.2em"
          ><path
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M12 6v6m0 0v6m0-6h6m-6 0H6"
          /></svg
        ></BaseRoundedButton
      >
    </div>
  </div>
  {#if settingsStore.state.hamburgerButtonBottom}
  {@render hamburgerPanel('bottom')}
  <button
    class="flex h-8 min-h-8 w-14 min-w-14 cursor-pointer text-white mb-2 mt-2 items-center justify-center rounded-md bg-textcolor2 transition-colors hover:bg-blue-500"
    onclick={() => {
      menuMode = 1 - menuMode;
    }}><ListIcon />
  </button>
  {/if}
</div>
{/if}
<div
  class="setting-area h-full flex-col overflow-x-hidden bg-darkbg text-textcolor max-h-full"
  class:overflow-hidden={btwRuntime.open}
  class:overflow-y-auto={!btwRuntime.open}
  class:py-0={btwRuntime.open}
  class:py-6={!btwRuntime.open}
  class:risu-sidebar={!$sideBarClosing}
  class:w-96={$sideBarSize === 0}
  class:w-110={$sideBarSize === 1}
  class:w-124={$sideBarSize === 2}
  class:w-138={$sideBarSize === 3}
  class:risu-sidebar-close={$sideBarClosing}
  class:min-w-96={!$DynamicGUI && $sideBarSize === 0}
  class:min-w-110={!$DynamicGUI && $sideBarSize === 1}
  class:min-w-124={!$DynamicGUI && $sideBarSize === 2}
  class:min-w-138={!$DynamicGUI && $sideBarSize === 3}
  class:px-0={btwRuntime.open}
  class:px-2={$DynamicGUI && !btwRuntime.open}
  class:px-4={!$DynamicGUI && !btwRuntime.open}
  class:dynamic-sidebar={$DynamicGUI}
  class:hidden={hidden}
  class:flex={!hidden}
  onanimationend={() => {
    if($sideBarClosing){
      $sideBarClosing = false
      sideBarStore.set(false)
    }
  }}
>
  <button
    class="flex w-full justify-end text-textcolor"
    onclick={async () => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
  >
    <!-- <button class="border-none bg-transparent p-0 text-textcolor"><X /></button> -->
  </button>
  {#if sideBarMode === 0}
    {#if btwRuntime.open}
      <LazyComponent loader={btwPanelLoader} />
    {:else if $selectedCharID < 0 || $settingsOpen}
      <LazyComponent loader={recentSessionsLoader} props={{ reseter }} />
    {:else if characterStore.characters[$selectedCharID]?.chaId === '§playground'}
      <LazyComponent loader={loadSideChatList} />
    {:else if $ConnectionOpenStore}
      <div class="flex flex-col">
        <h1 class="text-xl">{language.connectionOpen}</h1>
        <span class="text-textcolor2 mb-4">{language.connectionOpenInfo}</span>
        <div class="flex">
          <span>ID: </span>
          <span class="text-blue-600">{$RoomIdStore}</span>
        </div>
        <div>
          {#if $ConnectionIsHost}
            <span class="text-emerald-600">{language.connectionHost}</span>
          {:else}
            <span class="text-gray-500">{language.connectionGuest}</span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="w-full h-8 min-h-8 border-l border-b border-r border-selected relative bottom-6 rounded-b-md flex">
        <button onclick={() => {
          void loadSideChatList()
          devTool = false
          botMakerMode.set(false)
        }} class="grow border-r border-r-selected rounded-bl-md" class:text-textcolor2={$botMakerMode || devTool}>{language.Chat}</button>
        <button onclick={() => {
          void loadCharConfig()
          devTool = false
          botMakerMode.set(true)
        }} class="grow rounded-br-md" class:text-textcolor2={!$botMakerMode || devTool}>{language.character}</button>
        {#if settingsStore.state.enableDevTools}
          <button onclick={() => {
            devTool = true
          }} class="border-l border-l-selected rounded-br-md px-1" class:text-textcolor2={!devTool}>
            <WrenchIcon size={18} />
          </button>
        {/if}
      </div>
      {#if QuickSettings.open}
        <LazyComponent loader={quickSettingsLoader} />
      {:else if devTool}
        <LazyComponent loader={devToolLoader} />
      {:else if $botMakerMode}
        <LazyComponent loader={loadCharConfig} />
      {:else}
        <LazyComponent loader={loadSideChatList} />
      {/if}
    {/if}
  {/if}
</div>

{#if $DynamicGUI}
    <div role="button" tabindex="0" class="grow h-full min-w-12" class:hidden={hidden} onclick={() => {
      if($sideBarClosing){
        return
      }
      $sideBarClosing = true;
    }}
      onkeydown={(e)=>{
        if(e.key === 'Enter'){
            e.currentTarget.click()
        }
      }}
      class:sidebar-dark-animation={!$sideBarClosing}
      class:sidebar-dark-close-animation={$sideBarClosing}>

    </div>

{/if}

<style>
  .editMode {
    min-width: 6rem;
  }
  @keyframes sidebar-transition {
    from {
      width: 0rem;
    }
    to {
      width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close {
    from {
      width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-transition-non-dynamic {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
    }
  }
  @keyframes sidebar-transition-close-non-dynamic {
    from {
      width: var(--sidebar-size);
      min-width: var(--sidebar-size);
      right:0rem;
    }
    to {
      width: 0rem;
      min-width: 0rem;
      right:3rem;
    }
  }
  @keyframes sub-sidebar-transition {
    from {
      width: 0rem;
      min-width: 0rem;
    }
    to {
      width: 5rem;
      min-width: 5rem;
    }
  }
  @keyframes sub-sidebar-transition-close {
    from {
      width: 5rem;
      min-width: 5rem;
      max-width: 5rem;
      right:0rem;

    }
    to {
      width: 0rem;
      min-width: 0rem;
      max-width: 0rem;
      right: 10rem;
    }
  }
  @keyframes sidebar-dark-animation{
    from {
      background-color: rgba(0,0,0,0) !important;
    }
    to {
      background-color: rgba(0,0,0,0.5) !important;
    }
  }
  @keyframes sidebar-dark-closing-animation{
    from {
      background-color: rgba(0,0,0,0.5) !important;
    }
    to {
      background-color: rgba(0,0,0,0) !important;
    }
  }

  .risu-sidebar:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-non-dynamic;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close:not(.dynamic-sidebar) {
    animation-name: sidebar-transition-close-non-dynamic;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .risu-sidebar.dynamic-sidebar {
    animation-name: sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sidebar-close.dynamic-sidebar {
    animation-name: sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
    right: 3rem;
  }


  .risu-sub-sidebar {
    animation-name: sub-sidebar-transition;
    animation-duration: var(--risu-animation-speed);
  }
  .risu-sub-sidebar-close {
    animation-name: sub-sidebar-transition-close;
    animation-duration: var(--risu-animation-speed);
    position: relative;
  }
  .sidebar-dark-animation{
    animation-name: sidebar-dark-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0.5)
  }
  .sidebar-dark-close-animation{
    animation-name: sidebar-dark-closing-transition;
    animation-duration: var(--risu-animation-speed);
    background-color: rgba(0,0,0,0)
  }
</style>
