<script lang="ts">
    import { language } from "src/lang";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import { alertConfirm, alertSelect } from "src/ts/alert";
    import { getCharImage } from "src/ts/characters";
    import { 
        changeUserPersona, 
        exportUserPersona, 
        importUserPersona, 
        selectUserImg,
        createPersonaFolder,
        renamePersonaFolder,
        removePersonaFolder,
        movePersonaToFolderByIndex
    } from "src/ts/persona";
    import { settingsStore, personaStore } from 'src/ts/stores/domain';
    import { onMount } from "svelte";
    import { v4 } from "uuid";
    import { 
        PlusIcon, 
        UserIcon, 
        CameraIcon, 
        CheckIcon, 
        SearchIcon, 
        XIcon, 
        PencilIcon, 
        ArrowLeft, 
        CopyIcon, 
        TrashIcon, 
        DownloadIcon, 
        UploadIcon,
        LayoutGridIcon,
        ListIcon,
        FolderPlusIcon,
        FolderIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        FolderInputIcon
    } from "@lucide/svelte";

    // View state: 'list' for persona cards, 'edit' for active persona editor
    let viewMode = $state<'list' | 'edit'>('list');
    // Display layout: 'list' for vertical row list, 'grid' for image card grid
    let displayMode = $state<'list' | 'grid'>('list');
    let searchQuery = $state('');
    let openFolders = $state<Set<string>>(new Set());
    let folders = $derived(personaStore.folders);

    let personasReady = $state(personaStore.isLoaded);
    let selectedPersona = $derived(personaStore.activePersona);
    let selectedPersonaIcon = $derived(selectedPersona?.icon ?? '');

    onMount(() => {
        if (personasReady) return;
        void personaStore.ensureLoaded().then(() => {
            personasReady = true;
        });
    });

    let filteredPersonas = $derived.by(() => {
        const list = personaStore.list;
        const q = searchQuery.trim().toLowerCase();
        if (!q) {
            return list.map((p, idx) => ({ persona: p, originalIndex: idx }));
        }
        return list
            .map((p, idx) => ({ persona: p, originalIndex: idx }))
            .filter(({ persona }) => {
                const name = (persona.name || '').toLowerCase();
                const note = (persona.note || '').toLowerCase();
                const prompt = (persona.personaPrompt || '').toLowerCase();
                return name.includes(q) || note.includes(q) || prompt.includes(q);
            });
    });

    let rootPersonas = $derived(
        filteredPersonas.filter(({ persona }) => !persona.folderId || !personaStore.getPersonaFolderById(persona.folderId))
    );
    let folderedPersonas = $derived(
        folders.map((folder) => ({
            folder,
            personas: filteredPersonas.filter(({ persona }) => persona.folderId === folder.id),
        }))
    );

    function toggleFolder(id: string) {
        const next = new Set(openFolders);
        if (next.has(id)) {
            next.delete(id);
        } else {
            next.add(id);
        }
        openFolders = next;
    }

    async function addNewPersona() {
        const sel = parseInt(await alertSelect([language.createfromScratch, language.importCharacter]));
        if (sel === 0) {
            const index = personaStore.add({
                name: 'New Persona',
                icon: '',
                personaPrompt: '',
                note: '',
                largePortrait: false,
                id: v4()
            });
            changeUserPersona(index);
            viewMode = 'edit';
        } else if (sel === 1) {
            await importUserPersona();
            viewMode = 'edit';
        }
    }

    function duplicateCurrentPersona() {
        const current = personaStore.activePersona;
        if (!current) return;
        const index = personaStore.add({
            name: `${current.name || 'Persona'} (Copy)`,
            icon: current.icon || '',
            personaPrompt: current.personaPrompt || '',
            note: current.note || '',
            largePortrait: current.largePortrait || false,
            id: v4()
        });
        changeUserPersona(index);
        viewMode = 'edit';
    }

    function removeUserImg() {
        if (selectedPersona) selectedPersona.icon = '';
    }

    async function deleteCurrentPersona() {
        if (personaStore.list.length <= 1) return;
        const currentName = personaStore.activePersona?.name ?? '';
        const d = await alertConfirm(`${language.removeConfirm}${currentName}`);
        if (d) {
            const personas = [...personaStore.list];
            personas.splice(personaStore.activeIndex, 1);
            personaStore.replace(personas);
            changeUserPersona(0);
            viewMode = 'list';
        }
    }

    function handleSelectPersona(index: number) {
        changeUserPersona(index);
    }

    function handleEditPersona(index: number, e: MouseEvent) {
        e.stopPropagation();
        changeUserPersona(index);
        viewMode = 'edit';
    }

    function goBackToList() {
        viewMode = 'list';
    }
</script>

{#if personasReady}
<div class="flex-1 flex flex-col min-h-0 w-full text-textcolor">
    {#if viewMode === 'list'}
        <!-- LIST VIEW -->
        <div class="flex flex-col gap-2.5 w-full flex-1 min-h-0">
            <!-- Search & Add & View Mode Toolbar -->
            <div class="flex items-center gap-1.5 shrink-0">
                <div class="relative flex-1">
                    <div class="absolute inset-y-0 left-2.5 flex items-center pointer-events-none text-textcolor2">
                        <SearchIcon size={15} />
                    </div>
                    <input 
                        type="text"
                        bind:value={searchQuery}
                        placeholder={`${language.persona} (${personaStore.list.length})...`}
                        class="w-full h-9 pl-8 pr-8 rounded-lg border border-darkborderc bg-darkbutton/70 text-textcolor placeholder-textcolor2/60 text-xs focus:outline-none focus:ring-1 focus:ring-selected/50 transition-all"
                    />
                    {#if searchQuery}
                        <button 
                            class="absolute inset-y-0 right-2 flex items-center text-textcolor2 hover:text-textcolor p-1"
                            onclick={() => { searchQuery = ''; }}
                            title="Clear"
                            aria-label="Clear search"
                        >
                            <XIcon size={14} />
                        </button>
                    {/if}
                </div>

                <!-- Create Folder Button -->
                <button
                    onclick={createPersonaFolder}
                    class="h-9 w-9 rounded-lg bg-darkbutton/70 hover:bg-darkbutton text-textcolor2 hover:text-amber-400 border border-darkborderc transition-colors cursor-pointer shrink-0 flex items-center justify-center"
                    title={language.createFolder || "Create Folder"}
                    aria-label={language.createFolder || "Create Folder"}
                >
                    <FolderPlusIcon size={16} />
                </button>

                <!-- View Layout Toggle (List / Grid) -->
                <button
                    onclick={() => { displayMode = displayMode === 'list' ? 'grid' : 'list'; }}
                    class="h-9 w-9 rounded-lg bg-darkbutton/70 hover:bg-darkbutton text-textcolor2 hover:text-textcolor border border-darkborderc transition-colors cursor-pointer shrink-0 flex items-center justify-center"
                    title={displayMode === 'list' ? "그리드 보기" : "목록 보기"}
                    aria-label="Toggle view mode"
                >
                    {#if displayMode === 'list'}
                        <LayoutGridIcon size={16} />
                    {:else}
                        <ListIcon size={16} />
                    {/if}
                </button>

                <!-- Add Persona Button (Clean '+' icon only) -->
                <button
                    onclick={addNewPersona}
                    class="h-9 w-9 rounded-lg bg-selected/20 hover:bg-selected/30 text-selected border border-selected/40 transition-colors cursor-pointer shrink-0 flex items-center justify-center font-medium shadow-xs"
                    title={language.createfromScratch || "Add Persona"}
                    aria-label={language.createfromScratch || "Add Persona"}
                >
                    <PlusIcon size={18} />
                </button>
            </div>

            <!-- Current Active Persona Mini Bar -->
            {#if selectedPersona}
                <div class="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-selected/10 border border-selected/30 text-xs shrink-0">
                    <div class="flex items-center gap-1.5 min-w-0 flex-1">
                        <span class="text-selected font-semibold shrink-0">현재 활성:</span>
                        <span class="font-bold text-textcolor truncate">{selectedPersona.name || 'User'}</span>
                    </div>
                    <button
                        onclick={() => { viewMode = 'edit'; }}
                        class="text-selected hover:text-selected/80 font-medium px-1.5 py-0.5 rounded hover:bg-selected/10 transition-colors cursor-pointer shrink-0 flex items-center gap-1 text-[11px]"
                    >
                        <PencilIcon size={11} />
                        <span>{language.edit || '편집'}</span>
                    </button>
                </div>
            {/if}

            {#snippet personaRow(persona: any, originalIndex: number)}
                {@const isSelected = originalIndex === personaStore.activeIndex}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                    class="group relative flex items-center justify-between gap-2.5 p-2 rounded-lg border transition-all cursor-pointer active:scale-[0.99] {isSelected ? 'border-selected bg-selected/20 ring-1 ring-selected/70 shadow-xs' : 'border-darkborderc/70 bg-darkbg/40 hover:bg-darkbutton/50 hover:border-textcolor/30'}"
                    role="button"
                    tabindex="0"
                    onclick={() => handleSelectPersona(originalIndex)}
                >
                    <!-- Left Info: Avatar + Details -->
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                        <!-- Avatar Thumbnail -->
                        <div class="relative w-9 rounded-md overflow-hidden bg-darkbg shrink-0 border border-darkborderc/50 flex items-center justify-center {persona.largePortrait ? 'h-13' : 'h-9'} shadow-xs">
                            {#if persona.icon === ''}
                                <UserIcon size={18} class="text-textcolor2/60" />
                            {:else}
                                {#await getCharImage(persona.icon, 'css', { thumbnail: true })}
                                    <div class="w-full h-full bg-darkbg animate-pulse"></div>
                                {:then im}
                                    <div class="w-full h-full bg-cover bg-center" style={im}></div>
                                {/await}
                            {/if}
                        </div>

                        <!-- Name & Note Info -->
                        <div class="flex flex-col min-w-0 flex-1">
                            <div class="flex items-center gap-1.5">
                                <span class="font-bold text-xs sm:text-sm text-textcolor truncate leading-tight">
                                    {persona.name || 'New Persona'}
                                </span>
                                {#if isSelected}
                                    <span class="px-1.5 py-0.2 rounded-full text-[9px] bg-selected text-white font-medium shrink-0">
                                        선택됨
                                    </span>
                                {/if}
                            </div>
                            {#if persona.note}
                                <span class="text-[11px] text-textcolor2/80 truncate mt-0.5">
                                    {persona.note}
                                </span>
                            {/if}
                        </div>
                    </div>

                    <!-- Right Actions: Move to Folder + Edit Button -->
                    <div class="flex items-center gap-1 shrink-0">
                        <button
                            onclick={(e) => { e.stopPropagation(); movePersonaToFolderByIndex(originalIndex); }}
                            class="p-1.5 rounded-md text-textcolor2 hover:text-amber-400 hover:bg-darkbutton transition-colors cursor-pointer flex items-center justify-center"
                            title={language.moveToFolder || "Move to Folder"}
                            aria-label={language.moveToFolder || "Move to Folder"}
                        >
                            <FolderInputIcon size={15} />
                        </button>
                        <button
                            onclick={(e) => handleEditPersona(originalIndex, e)}
                            class="p-1.5 rounded-md text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors cursor-pointer flex items-center justify-center"
                            title={language.edit || "Edit"}
                            aria-label="Edit persona"
                        >
                            <PencilIcon size={15} />
                        </button>
                    </div>
                </div>
            {/snippet}

            {#snippet personaGridCard(persona: any, originalIndex: number)}
                {@const isSelected = originalIndex === personaStore.activeIndex}
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <div
                    class="group relative flex flex-col rounded-lg border overflow-hidden transition-all cursor-pointer active:scale-[0.98] {isSelected ? 'border-selected ring-2 ring-selected/70 shadow-sm bg-selected/10' : 'border-darkborderc/70 bg-darkbg/40 hover:bg-darkbutton/50 hover:border-textcolor/30'}"
                    role="button"
                    tabindex="0"
                    onclick={() => handleSelectPersona(originalIndex)}
                >
                    <!-- Avatar Image (Aspect Square for clean card layout) -->
                    <div class="relative w-full aspect-square bg-darkbg overflow-hidden flex items-center justify-center border-b border-darkborderc/40">
                        {#if persona.icon === ''}
                            <UserIcon size={32} class="text-textcolor2/40" />
                        {:else}
                            {#await getCharImage(persona.icon, persona.largePortrait ? 'lgcss' : 'css', { thumbnail: true })}
                                <div class="w-full h-full bg-darkbg animate-pulse"></div>
                            {:then im}
                                <div class="w-full h-full bg-cover bg-center" style={im}></div>
                            {/await}
                        {/if}

                        <!-- Selected Badge (Top-left) -->
                        {#if isSelected}
                            <div class="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-selected text-white text-[9px] font-bold shadow-xs flex items-center gap-0.5">
                                <CheckIcon size={10} />
                                <span>선택됨</span>
                            </div>
                        {/if}

                        <!-- Move to Folder Button (Top-right, below edit) -->
                        <button
                            onclick={(e) => { e.stopPropagation(); movePersonaToFolderByIndex(originalIndex); }}
                            class="absolute top-1 right-8 p-1 rounded bg-black/60 hover:bg-black/80 text-amber-300/90 hover:text-amber-200 backdrop-blur-xs transition-colors cursor-pointer"
                            title={language.moveToFolder || "Move to Folder"}
                            aria-label={language.moveToFolder || "Move to Folder"}
                        >
                            <FolderInputIcon size={13} />
                        </button>

                        <!-- Edit Button (Top-right) -->
                        <button
                            onclick={(e) => handleEditPersona(originalIndex, e)}
                            class="absolute top-1 right-1 p-1 rounded bg-black/60 hover:bg-black/80 text-white/90 hover:text-white backdrop-blur-xs transition-colors cursor-pointer"
                            title={language.edit || "Edit"}
                            aria-label="Edit persona"
                        >
                            <PencilIcon size={13} />
                        </button>
                    </div>

                    <!-- Name & Note Info -->
                    <div class="p-1.5 flex flex-col min-w-0 bg-darkbg/50">
                        <span class="font-bold text-xs text-textcolor truncate leading-tight">
                            {persona.name || 'New Persona'}
                        </span>
                        {#if persona.note}
                            <span class="text-[10px] text-textcolor2/80 truncate mt-0.5">
                                {persona.note}
                            </span>
                        {/if}
                    </div>
                </div>
            {/snippet}

            {#snippet folderHeader(folder: any, count: number)}
                <div class="flex items-center pl-2 pr-2 py-0.5 rounded-lg border border-darkborderc/40 bg-darkbg/30">
                    <button
                        class="grow flex items-center text-left hover:bg-textcolor/5 rounded-md pl-1.5 py-1.5 cursor-pointer"
                        onclick={() => toggleFolder(folder.id)}
                    >
                        {#if openFolders.has(folder.id)}
                            <ChevronDownIcon size={14} class="mr-1 text-textcolor2" />
                        {:else}
                            <ChevronRightIcon size={14} class="mr-1 text-textcolor2" />
                        {/if}
                        <FolderIcon size={14} class="mr-1.5 text-textcolor2" />
                        <span class="text-xs font-semibold text-textcolor">{folder.name}</span>
                        <span class="ml-1.5 text-[10px] text-textcolor2">({count})</span>
                    </button>
                    <button
                        class="p-1.5 rounded text-textcolor2/70 hover:text-textcolor transition-colors cursor-pointer"
                        onclick={() => renamePersonaFolder(folder.id)}
                        title={language.renameFolder}
                        aria-label={language.renameFolder}
                    >
                        <PencilIcon size={12} />
                    </button>
                    <button
                        class="p-1.5 rounded text-textcolor2/70 hover:text-draculared transition-colors cursor-pointer"
                        onclick={() => removePersonaFolder(folder.id)}
                        title={language.removeFolder}
                        aria-label={language.removeFolder}
                    >
                        <TrashIcon size={12} />
                    </button>
                </div>
            {/snippet}

            {#if displayMode === 'list'}
                <!-- Persona Cards List (List View, Folder Grouped) -->
                <div class="flex flex-col gap-1.5 flex-1 min-h-0 overflow-y-auto pr-0.5">
                    {#each rootPersonas as { persona, originalIndex }}
                        {@render personaRow(persona, originalIndex)}
                    {/each}

                    {#each folderedPersonas as { folder, personas }}
                        {@render folderHeader(folder, personas.length)}
                        {#if openFolders.has(folder.id)}
                            <div class="flex flex-col gap-1.5 pl-3 border-l border-darkborderc/40">
                                {#each personas as { persona, originalIndex }}
                                    {@render personaRow(persona, originalIndex)}
                                {/each}
                            </div>
                        {/if}
                    {/each}

                    {#if filteredPersonas.length === 0}
                        <div class="py-10 text-center text-xs text-textcolor2 flex flex-col items-center gap-2">
                            <SearchIcon size={20} class="opacity-40" />
                            <span>No personas match "{searchQuery}"</span>
                        </div>
                    {/if}
                </div>
            {:else}
                <!-- Persona Image Grid (Grid View, Folder Grouped) -->
                <div class="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto pr-0.5">
                    <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 content-start">
                        {#each rootPersonas as { persona, originalIndex }}
                            {@render personaGridCard(persona, originalIndex)}
                        {/each}
                    </div>

                    {#each folderedPersonas as { folder, personas }}
                        {@render folderHeader(folder, personas.length)}
                        {#if openFolders.has(folder.id)}
                            <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 pl-3 content-start">
                                {#each personas as { persona, originalIndex }}
                                    {@render personaGridCard(persona, originalIndex)}
                                {/each}
                            </div>
                        {/if}
                    {/each}

                    {#if filteredPersonas.length === 0}
                        <div class="py-10 text-center text-xs text-textcolor2 flex flex-col items-center gap-2">
                            <SearchIcon size={20} class="opacity-40" />
                            <span>No personas match "{searchQuery}"</span>
                        </div>
                    {/if}
                </div>
            {/if}
        </div>
    {:else}
        <!-- EDIT VIEW -->
        <div class="flex flex-col gap-3 w-full flex-1 min-h-0">
            <!-- Edit Header / Navigation Bar -->
            <div class="flex items-center justify-between pb-2 border-b border-darkborderc shrink-0">
                <button
                    onclick={goBackToList}
                    class="flex items-center gap-1 text-xs sm:text-sm font-medium text-textcolor hover:text-selected transition-colors cursor-pointer py-1 px-2 -ml-2 rounded-lg hover:bg-darkbutton"
                    aria-label="Back to persona list"
                >
                    <ArrowLeft size={16} />
                    <span>{language.goback || '목록'}</span>
                </button>

                <span class="font-bold text-xs sm:text-sm text-textcolor truncate max-w-[180px]">
                    {selectedPersona?.name || 'Persona'}
                </span>

                <button
                    onclick={goBackToList}
                    class="px-2.5 py-0.5 rounded-md bg-selected text-white text-xs font-semibold hover:bg-selected/90 transition-colors cursor-pointer shadow-xs"
                >
                    완료
                </button>
            </div>

            <!-- Edit Form Body (Scrollable) -->
            <div class="flex flex-col gap-3 flex-1 min-h-0 overflow-y-auto pr-0.5 pb-2">
                <!-- Top Card: Avatar + Name + Note -->
                <div class="p-3 rounded-xl border border-darkborderc bg-darkbg/35 flex flex-col sm:flex-row items-center sm:items-start gap-3">
                    <!-- Avatar Button -->
                    <div class="flex flex-col items-center gap-1.5 shrink-0">
                        <button
                            onclick={() => selectUserImg()}
                            class="group relative rounded-xl overflow-hidden border-2 border-darkborderc bg-darkbg hover:border-selected transition-all shadow-sm shrink-0 cursor-pointer {selectedPersona?.largePortrait ? 'w-20 h-28' : 'w-20 h-20'}"
                            title="Change Avatar"
                        >
                            {#if selectedPersonaIcon === ''}
                                <div class="w-full h-full flex items-center justify-center text-textcolor2/60 bg-darkbutton/50">
                                    <UserIcon size={32} />
                                </div>
                            {:else}
                                {#await getCharImage(selectedPersonaIcon, selectedPersona?.largePortrait ? 'lgcss' : 'css')}
                                    <div class="w-full h-full bg-darkbg animate-pulse"></div>
                                {:then im}
                                    <div class="w-full h-full" style={im}></div>
                                {/await}
                            {/if}

                            <!-- Hover/Active Overlay -->
                            <div class="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-0.5 text-white text-[10px] font-medium">
                                <CameraIcon size={16} />
                                <span>Change</span>
                            </div>
                        </button>

                        <div class="flex items-center gap-1">
                            <button 
                                onclick={() => selectUserImg()}
                                class="px-2 py-0.5 rounded bg-darkbutton hover:bg-darkbutton/80 text-textcolor text-[11px] font-medium transition-colors cursor-pointer"
                            >
                                이미지 선택
                            </button>
                            {#if selectedPersonaIcon !== ''}
                                <button 
                                    onclick={removeUserImg}
                                    class="px-2 py-0.5 rounded hover:bg-draculared/20 text-textcolor2 hover:text-draculared text-[11px] font-medium transition-colors cursor-pointer"
                                >
                                    삭제
                                </button>
                            {/if}
                        </div>
                    </div>

                    <!-- Name & Note Inputs -->
                    <div class="flex flex-col gap-2 min-w-0 flex-1 w-full">
                        <div>
                            <span class="block text-[11px] font-semibold text-textcolor2 mb-0.5">{language.name}</span>
                            <TextInput 
                                marginBottom={false} 
                                size="sm" 
                                placeholder="User" 
                                bind:value={selectedPersona.name}

                                fullwidth
                            />
                        </div>

                        {#if settingsStore.state.personaNote}
                            <div>
                                <span class="block text-[11px] font-semibold text-textcolor2 mb-0.5">{language.note}</span>
                                <TextInput 
                                marginBottom={false} 
                                size="sm" 
                                bind:value={selectedPersona.note}

                                placeholder="식별용 메모 (예: 현대물 전용 등)" 
                                fullwidth
                            />
                            </div>
                        {/if}

                        <!-- Large Portrait Checkbox -->
                        {#if selectedPersona}
                            <div class="pt-0.5">
                                <Check bind:check={selectedPersona.largePortrait} name={language.largePortrait || "세로형 큰 이미지"} />
                            </div>
                        {/if}
                    </div>
                </div>

                <!-- Description / Prompt Card -->
                <div class="p-3 rounded-xl border border-darkborderc bg-darkbg/35 flex flex-col gap-1.5">
                    <span class="block text-[11px] font-semibold text-textcolor2 shrink-0">{language.description}</span>
                    <div class="w-full h-36">
                        <TextAreaInput 
                            autocomplete="off" 
                            height={"full"} 
                            bind:value={selectedPersona.personaPrompt}

                            placeholder={`페르소나에 대한 설명이나 프롬프트를 입력하세요.\n예: [{{user}}는 활발하고 정의감이 넘치는 모험가이다.]`} 
                            fullwidth
                        />
                    </div>
                </div>

                <!-- Action Buttons Card -->
                <div class="p-3 rounded-xl border border-darkborderc bg-darkbg/35 flex flex-col gap-2">
                    <span class="block text-[11px] font-semibold text-textcolor2 shrink-0">페르소나 관리</span>
                    <div class="grid grid-cols-2 gap-1.5">
                        <Button onclick={exportUserPersona} size="sm">
                            <span class="flex items-center justify-center gap-1.5 w-full text-xs">
                                <DownloadIcon size={13} />
                                <span>{language.export}</span>
                            </span>
                        </Button>
                        <Button onclick={importUserPersona} size="sm">
                            <span class="flex items-center justify-center gap-1.5 w-full text-xs">
                                <UploadIcon size={13} />
                                <span>{language.import}</span>
                            </span>
                        </Button>
                        <Button onclick={duplicateCurrentPersona} size="sm">
                            <span class="flex items-center justify-center gap-1.5 w-full text-xs">
                                <CopyIcon size={13} />
                                <span>복제</span>
                            </span>
                        </Button>
                        {#if personaStore.list.length > 1}
                            <Button styled="danger" size="sm" onclick={deleteCurrentPersona}>
                                <span class="flex items-center justify-center gap-1.5 w-full text-xs">
                                    <TrashIcon size={13} />
                                    <span>{language.remove}</span>
                                </span>
                            </Button>
                        {/if}
                    </div>
                </div>
            </div>
        </div>
    {/if}
</div>
{:else}
    <div class="flex-1 flex items-center justify-center text-textcolor2">Loading personas...</div>
{/if}
