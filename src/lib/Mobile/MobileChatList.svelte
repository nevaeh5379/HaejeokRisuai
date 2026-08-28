<script lang="ts">
    import { v4 } from "uuid";
    import type { Chat, ChatFolder } from "../../ts/storage/schema";
    import { ReloadGUIPointer, selectedCharID, MobileSideBar, alertStore, openPersonaList, openPresetList } from 'src/ts/stores.svelte';
    import { characterStore, settingsStore, messageStore, presetStore } from 'src/ts/stores/domain';
    import {
        PlusIcon,
        SearchIcon,
        XIcon,
        MessageSquareIcon,
        MoreVerticalIcon,
        PencilIcon,
        CopyIcon,
        SplitIcon,
        DownloadIcon,
        TrashIcon,
        FolderIcon,
        FolderPlusIcon,
        ChevronDownIcon,
        ChevronRightIcon,
        HardDriveUploadIcon,
        SlidersHorizontalIcon,
        UserIcon,
        ToggleLeftIcon
    } from "@lucide/svelte";
    import { alertConfirm, alertInput, alertNormal, alertSelect } from "src/ts/alert";
    import { language } from "src/lang";
    import { changeChatTo, createChatCopyName } from "src/ts/globalApi.svelte";
    import { exportChat, importChat, exportAllChats } from "src/ts/characters";
    import { getCharImage } from "src/ts/characters";

    let chara = $derived(characterStore.characters[$selectedCharID]);
    let searchQuery = $state("");
    let selectedFolderFilter = $state<string>("all"); // 'all', 'none', or folder.id
    let collapsedFolders = $state<Record<string, boolean>>({});
    let activeActionChat = $state<{ chat: Chat; index: number } | null>(null);
    let activeFolderAction = $state<{ folder: ChatFolder; index: number } | null>(null);

    let activePersonaIcon = $derived(
        settingsStore.state.personas?.[settingsStore.state.selectedPersona]?.icon ||
        settingsStore.state.userIcon ||
        ''
    );
    let activePersonaName = $derived(
        settingsStore.state.personas?.[settingsStore.state.selectedPersona]?.name ||
        settingsStore.state.username ||
        'User'
    );
    let currentPresetName = $derived(
        presetStore.summaries?.[settingsStore.state.selectedPreset]?.name ||
        settingsStore.state.aiModel ||
        'Default Model'
    );

    let folders = $derived<ChatFolder[]>(chara?.chatFolders || []);
    let chats = $derived<Chat[]>(chara?.chats || []);
    let currentChatIndex = $derived(chara?.chatPage ?? 0);

    let normalizedSearch = $derived(searchQuery.trim().toLowerCase());

    // Filtered chats list
    let filteredChats = $derived.by(() => {
        if (!chara || !chara.chats) return [];
        return chara.chats.map((chat, index) => ({ chat, index })).filter(({ chat }) => {
            if (normalizedSearch) {
                const nameMatch = (chat.name || "").toLowerCase().includes(normalizedSearch);
                const noteMatch = (chat.note || "").toLowerCase().includes(normalizedSearch);
                if (!nameMatch && !noteMatch) return false;
            }
            if (selectedFolderFilter !== "all") {
                if (selectedFolderFilter === "none") {
                    if (chat.folderId) return false;
                } else if (chat.folderId !== selectedFolderFilter) {
                    return false;
                }
            }
            return true;
        });
    });

    // Group chats into folders for accordion view
    let unassignedChats = $derived(filteredChats.filter(({ chat }) => !chat.folderId));

    function getChatsInFolder(folderId: string) {
        return filteredChats.filter(({ chat }) => chat.folderId === folderId);
    }

    function toggleFolderCollapse(folderId: string) {
        collapsedFolders[folderId] = !collapsedFolders[folderId];
    }

    async function handleStartNewChat() {
        if (!chara) return;
        const len = chara.chats.length;
        const newChat: Chat = {
            message: [],
            note: '',
            name: `New Chat ${len + 1}`,
            localLore: [],
            id: v4(),
            folderId: selectedFolderFilter !== 'all' && selectedFolderFilter !== 'none' ? selectedFolderFilter : undefined
        };

        if (chara.type === 'group') {
            const { findCharacterbyId } = await import('src/ts/util');
            for (const c of chara.characters) {
                newChat.message.push({
                    chatId: v4(),
                    saying: c,
                    role: 'char',
                    data: findCharacterbyId(c)?.firstMessage || ''
                });
            }
        }

        chara.chats.unshift(newChat);
        if (newChat.id) {
            await messageStore.persistNewChat(chara.chaId, newChat.id, newChat.message);
        }
        changeChatTo(0);
        $ReloadGUIPointer += 1;
        $MobileSideBar = 0; // Return to chat immediately!
    }

    function handleSelectChat(chatIndex: number) {
        changeChatTo(chatIndex);
        $MobileSideBar = 0; // Return to chat!
    }

    async function handleRenameChat(chatIndex: number, currentName: string) {
        activeActionChat = null;
        const newName = await alertInput(language.name || "Rename Chat", undefined, currentName);
        if (newName && newName.trim() && chara) {
            chara.chats[chatIndex].name = newName.trim();
            characterStore.markCharacterDirty(chara.chaId);
            $ReloadGUIPointer += 1;
        }
    }

    async function handleDuplicateChat(chatIndex: number) {
        activeActionChat = null;
        if (!chara) return;
        const originalChat = chara.chats[chatIndex];
        if (!originalChat) return;

        const copyName = createChatCopyName(originalChat.name || "Chat", "Copy");
        const newChat: Chat = JSON.parse(JSON.stringify(originalChat));
        newChat.id = v4();
        newChat.name = copyName;

        chara.chats.splice(chatIndex + 1, 0, newChat);
        if (newChat.id) {
            await messageStore.persistNewChat(chara.chaId, newChat.id, newChat.message);
        }
        characterStore.markCharacterDirty(chara.chaId);
        $ReloadGUIPointer += 1;
        alertNormal("Chat duplicated");
    }

    async function handleBranchGraph(chat: Chat) {
        activeActionChat = null;
        chat.id ??= v4();
        alertStore.set({
            type: "branches",
            msg: chat.id
        });
    }

    async function handleExportSingleChat(chatIndex: number) {
        activeActionChat = null;
        await exportChat(chatIndex);
    }

    async function handleDeleteChat(chatIndex: number, chatName: string) {
        activeActionChat = null;
        if (!chara) return;
        if (chara.chats.length <= 1) {
            alertNormal("There must be at least one chat");
            return;
        }
        if (await alertConfirm(`Delete this chat? (${chatName})`)) {
            const isDeletingCurrent = chara.chatPage === chatIndex;
            chara.chats.splice(chatIndex, 1);
            if (isDeletingCurrent) {
                changeChatTo(Math.max(0, chatIndex - 1));
            } else if ((chara.chatPage ?? 0) > chatIndex) {
                chara.chatPage = (chara.chatPage ?? 0) - 1;
            }
            characterStore.markCharacterDirty(chara.chaId);
            $ReloadGUIPointer += 1;
        }
    }

    async function handleMoveToFolder(chatIndex: number) {
        activeActionChat = null;
        if (!chara) return;
        const chat = chara.chats[chatIndex];
        if (!chat) return;

        const options: string[] = ["(None / Root)", ...(chara.chatFolders || []).map(f => f.name || "Folder")];
        const res = await alertSelect(options, "Select Folder");
        const sel = parseInt(res, 10);
        if (isNaN(sel) || sel < 0) return;

        if (sel === 0) {
            chat.folderId = undefined;
        } else {
            const folder = chara.chatFolders[sel - 1];
            if (folder) {
                chat.folderId = folder.id;
            }
        }
        characterStore.markCharacterDirty(chara.chaId);
        $ReloadGUIPointer += 1;
    }

    async function handleCreateNewFolder() {
        if (!chara) return;
        const name = await alertInput("Create New Folder", undefined, "New Folder");
        if (!name || !name.trim()) return;

        chara.chatFolders ??= [];
        const newFolder: ChatFolder = {
            id: v4(),
            name: name.trim(),
            color: "#3b82f6",
            folded: false
        };
        chara.chatFolders.push(newFolder);
        characterStore.markCharacterDirty(chara.chaId);
        $ReloadGUIPointer += 1;
    }

    async function handleRenameFolder(folderIndex: number, currentName: string) {
        activeFolderAction = null;
        if (!chara || !chara.chatFolders) return;
        const newName = await alertInput("Rename Folder", undefined, currentName);
        if (newName && newName.trim()) {
            chara.chatFolders[folderIndex].name = newName.trim();
            characterStore.markCharacterDirty(chara.chaId);
            $ReloadGUIPointer += 1;
        }
    }

    async function handleDeleteFolder(folderIndex: number, folderId: string, folderName: string) {
        activeFolderAction = null;
        if (!chara || !chara.chatFolders) return;
        if (await alertConfirm(`Delete folder "${folderName}"? (Chats inside will move to root)`)) {
            // Unassign chats from folder
            for (const c of chara.chats) {
                if (c.folderId === folderId) {
                    c.folderId = undefined;
                }
            }
            chara.chatFolders.splice(folderIndex, 1);
            characterStore.markCharacterDirty(chara.chaId);
            $ReloadGUIPointer += 1;
        }
    }
</script>

<div class="w-full h-full flex flex-col bg-bgcolor text-textcolor overflow-hidden select-none">
    <!-- Top Action Bar & Search -->
    <div class="px-3 py-2.5 border-b border-darkborderc/60 bg-darkbg/50 backdrop-blur-sm flex flex-col gap-2 shrink-0 z-10">
        <!-- Main Primary Button: New Chat -->
        <div class="flex items-center gap-2">
            <button
                onclick={handleStartNewChat}
                class="flex-1 py-2.5 px-4 rounded-2xl bg-selected hover:bg-selected/90 text-white font-bold text-xs flex items-center justify-center gap-2 shadow-sm transition-all active:scale-[0.98]"
            >
                <PlusIcon size={16} />
                <span>{language.newChat || "New Chat"}</span>
            </button>

            <button
                onclick={handleCreateNewFolder}
                class="p-2.5 rounded-2xl bg-darkbutton border border-darkborderc hover:border-selected text-textcolor2 hover:text-textcolor transition-colors flex items-center justify-center shrink-0"
                title="Create Folder"
                aria-label="Create Folder"
            >
                <FolderPlusIcon size={16} />
            </button>

            <button
                onclick={importChat}
                class="p-2.5 rounded-2xl bg-darkbutton border border-darkborderc hover:border-selected text-textcolor2 hover:text-textcolor transition-colors flex items-center justify-center shrink-0"
                title="Import Chat"
                aria-label="Import Chat"
            >
                <HardDriveUploadIcon size={16} />
            </button>

            <button
                onclick={exportAllChats}
                class="p-2.5 rounded-2xl bg-darkbutton border border-darkborderc hover:border-selected text-textcolor2 hover:text-textcolor transition-colors flex items-center justify-center shrink-0"
                title="Export All Chats"
                aria-label="Export All Chats"
            >
                <DownloadIcon size={16} />
            </button>
        </div>

        <!-- Search Bar -->
        <div class="relative w-full flex items-center">
            <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none text-textcolor2">
                <SearchIcon size={14} />
            </div>
            <input
                placeholder="Search chats..."
                bind:value={searchQuery}
                class="w-full h-9 pl-8 pr-8 rounded-xl bg-darkbutton/60 border border-darkborderc text-textcolor placeholder-textcolor2/70 text-xs focus:outline-none focus:border-selected transition-colors"
            />
            {#if searchQuery}
                <button
                    onclick={() => { searchQuery = ""; }}
                    class="absolute inset-y-0 right-2 flex items-center text-textcolor2 hover:text-textcolor p-1"
                    aria-label="Clear search"
                >
                    <XIcon size={14} />
                </button>
            {/if}
        </div>

        <!-- Folder Filter Chips (if any folder exists) -->
        {#if folders.length > 0}
            <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-0.5 -mx-1 px-1">
                <button
                    onclick={() => { selectedFolderFilter = "all"; }}
                    class="px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 transition-colors border"
                    class:bg-selected={selectedFolderFilter === "all"}
                    class:text-white={selectedFolderFilter === "all"}
                    class:border-selected={selectedFolderFilter === "all"}
                    class:border-darkborderc={selectedFolderFilter !== "all"}
                    class:text-textcolor2={selectedFolderFilter !== "all"}
                >
                    All ({chats.length})
                </button>
                <button
                    onclick={() => { selectedFolderFilter = "none"; }}
                    class="px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 transition-colors border"
                    class:bg-selected={selectedFolderFilter === "none"}
                    class:text-white={selectedFolderFilter === "none"}
                    class:border-selected={selectedFolderFilter === "none"}
                    class:border-darkborderc={selectedFolderFilter !== "none"}
                    class:text-textcolor2={selectedFolderFilter !== "none"}
                >
                    Uncategorized ({chats.filter(c => !c.folderId).length})
                </button>
                {#each folders as folder}
                    <button
                        onclick={() => { selectedFolderFilter = selectedFolderFilter === folder.id ? "all" : folder.id; }}
                        class="px-2.5 py-1 rounded-full text-[11px] font-medium shrink-0 transition-colors border flex items-center gap-1.5"
                        class:bg-selected={selectedFolderFilter === folder.id}
                        class:text-white={selectedFolderFilter === folder.id}
                        class:border-selected={selectedFolderFilter === folder.id}
                        class:border-darkborderc={selectedFolderFilter !== folder.id}
                        class:text-textcolor2={selectedFolderFilter !== folder.id}
                    >
                        <span class="w-2 h-2 rounded-full" style="background-color: {folder.color || '#3b82f6'};"></span>
                        <span>{folder.name || "Folder"}</span>
                        <span class="text-[10px] opacity-75">({chats.filter(c => c.folderId === folder.id).length})</span>
                    </button>
                {/each}
            </div>
        {/if}
    </div>

    <!-- Main Chat List Content -->
    <div class="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-2.5 pb-24">
        {#if filteredChats.length === 0}
            <div class="w-full h-48 flex flex-col items-center justify-center text-center gap-2 text-textcolor2">
                <MessageSquareIcon size={32} class="opacity-40" />
                <span class="text-xs font-semibold">{searchQuery ? "No matching chats found" : "No chats available"}</span>
            </div>
        {:else}
            <!-- 1. Folder Groups (if browsing all and folders exist) -->
            {#if selectedFolderFilter === "all" && folders.length > 0}
                {#each folders as folder, folderIdx}
                    {@const folderChats = getChatsInFolder(folder.id)}
                    {#if folderChats.length > 0 || !searchQuery}
                        <div class="flex flex-col rounded-2xl border border-darkborderc/70 bg-darkbg/40 overflow-hidden shadow-xs">
                            <!-- Folder Header -->
                            <div
                                role="button"
                                tabindex="0"
                                onclick={() => toggleFolderCollapse(folder.id)}
                                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleFolderCollapse(folder.id); }}
                                class="w-full px-3 py-2.5 flex items-center justify-between bg-darkbg/80 hover:bg-darkbutton/50 transition-colors cursor-pointer"
                            >
                                <div class="flex items-center gap-2 min-w-0">
                                    {#if collapsedFolders[folder.id]}
                                        <ChevronRightIcon size={16} class="text-textcolor2 shrink-0" />
                                    {:else}
                                        <ChevronDownIcon size={16} class="text-textcolor2 shrink-0" />
                                    {/if}
                                    <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {folder.color || '#3b82f6'};"></span>
                                    <span class="font-bold text-xs text-textcolor truncate">{folder.name || "Folder"}</span>
                                    <span class="px-1.5 py-0.2 rounded-md bg-darkbutton text-textcolor2 text-[10px] font-semibold">{folderChats.length}</span>
                                </div>

                                <!-- svelte-ignore a11y_click_events_have_key_events -->
                                <!-- svelte-ignore a11y_no_static_element_interactions -->
                                <div onclick={(e) => e.stopPropagation()}>
                                    <button
                                        onclick={() => { activeFolderAction = { folder, index: folderIdx }; }}
                                        class="p-1 rounded-lg text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                                        aria-label="Folder options"
                                    >
                                        <MoreVerticalIcon size={15} />
                                    </button>
                                </div>
                            </div>

                            <!-- Folder Items -->
                            {#if !collapsedFolders[folder.id]}
                                <div class="divide-y divide-darkborderc/30 border-t border-darkborderc/40">
                                    {#each folderChats as { chat, index }}
                                        <div
                                            role="button"
                                            tabindex="0"
                                            onclick={() => handleSelectChat(index)}
                                            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectChat(index); }}
                                            class="w-full px-3 py-2.5 flex items-center justify-between gap-2.5 transition-colors cursor-pointer {index === currentChatIndex ? 'bg-selected/15 font-semibold text-selected' : 'hover:bg-darkbutton/40 text-textcolor'}"
                                        >
                                            <div class="flex items-center gap-2.5 min-w-0 flex-1">
                                                {#if index === currentChatIndex}
                                                    <span class="w-1.5 h-1.5 rounded-full bg-selected shrink-0"></span>
                                                {:else}
                                                    <MessageSquareIcon size={14} class="text-textcolor2/60 shrink-0" />
                                                {/if}
                                                <span class="text-xs truncate">{chat.name || `Chat ${index + 1}`}</span>
                                            </div>

                                            <!-- svelte-ignore a11y_click_events_have_key_events -->
                                            <!-- svelte-ignore a11y_no_static_element_interactions -->
                                            <div class="flex items-center gap-1.5 shrink-0" onclick={(e) => e.stopPropagation()}>
                                                <span class="text-[10px] text-textcolor2/70">{chat.message ? chat.message.length : 0} msgs</span>
                                                <button
                                                    onclick={() => { activeActionChat = { chat, index }; }}
                                                    class="p-1 rounded-lg text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                                                    aria-label="Chat options"
                                                >
                                                    <MoreVerticalIcon size={15} />
                                                </button>
                                            </div>
                                        </div>
                                    {/each}
                                </div>
                            {/if}
                        </div>
                    {/if}
                {/each}
            {/if}

            <!-- 2. Unassigned Chats or Filtered Chats -->
            <div class="flex flex-col gap-1.5">
                {#if selectedFolderFilter === "all" && folders.length > 0}
                    <span class="text-[11px] font-semibold text-textcolor2 px-1">Other Chats</span>
                {/if}
                {#each (selectedFolderFilter === "all" && folders.length > 0 ? unassignedChats : filteredChats) as { chat, index }}
                    <div
                        role="button"
                        tabindex="0"
                        onclick={() => handleSelectChat(index)}
                        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleSelectChat(index); }}
                        class="w-full px-3.5 py-3 rounded-2xl border transition-all cursor-pointer flex items-center justify-between gap-3 shadow-xs {index === currentChatIndex ? 'border-selected bg-selected/10 text-selected shadow-sm' : 'border-darkborderc bg-darkbg/40 hover:bg-darkbutton text-textcolor'}"
                    >
                        <div class="flex items-center gap-3 min-w-0 flex-1">
                            <div class="w-8 h-8 rounded-xl flex items-center justify-center shrink-0 {index === currentChatIndex ? 'bg-selected text-white' : 'bg-darkbutton text-textcolor2'}">
                                <MessageSquareIcon size={16} />
                            </div>
                            <div class="flex flex-col min-w-0 flex-1">
                                <span class="font-bold text-xs truncate leading-tight">{chat.name || `Chat ${index + 1}`}</span>
                                <div class="flex items-center gap-2 mt-0.5 text-[10px] text-textcolor2">
                                    <span>{chat.message ? chat.message.length : 0} messages</span>
                                    {#if index === currentChatIndex}
                                        <span class="px-1.5 py-0.2 rounded-full bg-selected/20 text-selected font-bold text-[9px]">Active</span>
                                    {/if}
                                </div>
                            </div>
                        </div>

                        <!-- Right Actions -->
                        <!-- svelte-ignore a11y_click_events_have_key_events -->
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div class="flex items-center gap-1 shrink-0" onclick={(e) => e.stopPropagation()}>
                            <button
                                onclick={() => { activeActionChat = { chat, index }; }}
                                class="p-1.5 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-darkbutton transition-colors"
                                aria-label="Chat options"
                            >
                                <MoreVerticalIcon size={16} />
                            </button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}

        <!-- Quick Persona & Model Cards -->
        <div class="mt-4 pt-3 border-t border-darkborderc/60 flex flex-col gap-2">
            <span class="text-[11px] font-semibold text-textcolor2 px-1 uppercase tracking-wider">Quick Switcher</span>
            
            <!-- Persona Card -->
            <button
                onclick={() => { openPersonaList.set(true); }}
                class="w-full p-2.5 rounded-2xl border border-darkborderc bg-darkbg/60 hover:border-selected transition-all flex items-center justify-between gap-3 text-left"
            >
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-full overflow-hidden bg-bgcolor border border-darkborderc shrink-0 flex items-center justify-center">
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
                    <div class="flex flex-col min-w-0">
                        <span class="text-[10px] text-textcolor2">Persona</span>
                        <span class="font-bold text-xs text-textcolor truncate">{activePersonaName}</span>
                    </div>
                </div>
                <ChevronRightIcon size={16} class="text-textcolor2 shrink-0" />
            </button>

            <!-- Model / Preset Card -->
            <button
                onclick={() => { openPresetList.set(true); }}
                class="w-full p-2.5 rounded-2xl border border-darkborderc bg-darkbg/60 hover:border-selected transition-all flex items-center justify-between gap-3 text-left"
            >
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-8 h-8 rounded-xl bg-blue-500/15 text-blue-400 border border-blue-500/20 shrink-0 flex items-center justify-center">
                        <SlidersHorizontalIcon size={16} />
                    </div>
                    <div class="flex flex-col min-w-0">
                        <span class="text-[10px] text-textcolor2">AI Model & Preset</span>
                        <span class="font-bold text-xs text-textcolor truncate">{currentPresetName}</span>
                    </div>
                </div>
                <ChevronRightIcon size={16} class="text-textcolor2 shrink-0" />
            </button>
        </div>
    </div>

    <!-- CHAT ACTIONS BOTTOM SHEET -->
    {#if activeActionChat}
        <div
            role="dialog"
            aria-modal="true"
            class="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-end justify-center p-0 sm:p-4"
        >
            <button
                type="button"
                tabindex="-1"
                class="fixed inset-0 z-0 bg-transparent cursor-default"
                onclick={() => { activeActionChat = null; }}
                aria-label="Close menu"
            ></button>

            <div
                class="relative z-10 w-full max-w-md bg-darkbg border border-darkborderc rounded-t-3xl sm:rounded-3xl p-4 flex flex-col gap-3 shadow-2xl pb-[max(env(safe-area-inset-bottom),20px)]"
            >
                <div class="flex items-center justify-between border-b border-darkborderc/60 pb-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <div class="w-8 h-8 rounded-xl bg-selected/15 text-selected flex items-center justify-center shrink-0">
                            <MessageSquareIcon size={16} />
                        </div>
                        <span class="font-bold text-sm text-textcolor truncate">{activeActionChat.chat.name || "Chat"}</span>
                    </div>
                    <button
                        onclick={() => { activeActionChat = null; }}
                        class="p-1 text-textcolor2 hover:text-textcolor rounded-lg"
                    >
                        <XIcon size={18} />
                    </button>
                </div>

                <div class="flex flex-col gap-1">
                    <!-- 1. Open Chat -->
                    <button
                        onclick={() => {
                            if (activeActionChat) {
                                handleSelectChat(activeActionChat.index);
                                activeActionChat = null;
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-xs font-semibold transition-colors"
                    >
                        <MessageSquareIcon size={16} class="text-selected" />
                        <span>Open Chat</span>
                    </button>

                    <!-- 2. Rename Chat -->
                    <button
                        onclick={() => {
                            if (activeActionChat) {
                                void handleRenameChat(activeActionChat.index, activeActionChat.chat.name || "Chat");
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-xs font-semibold transition-colors"
                    >
                        <PencilIcon size={16} class="text-amber-400" />
                        <span>Rename Chat</span>
                    </button>

                    <!-- 3. Duplicate Chat -->
                    <button
                        onclick={() => {
                            if (activeActionChat) {
                                void handleDuplicateChat(activeActionChat.index);
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-xs font-semibold transition-colors"
                    >
                        <CopyIcon size={16} class="text-blue-400" />
                        <span>Duplicate Chat</span>
                    </button>

                    <!-- 4. Branch Graph -->
                    <button
                        onclick={() => {
                            if (activeActionChat) {
                                void handleBranchGraph(activeActionChat.chat);
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-xs font-semibold transition-colors"
                    >
                        <SplitIcon size={16} class="text-teal-400" />
                        <span>Branch Tree</span>
                    </button>

                    <!-- 5. Move to Folder -->
                    {#if folders.length > 0}
                        <button
                            onclick={() => {
                                if (activeActionChat) {
                                    void handleMoveToFolder(activeActionChat.index);
                                }
                            }}
                            class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-xs font-semibold transition-colors"
                        >
                            <FolderIcon size={16} class="text-purple-400" />
                            <span>Move to Folder</span>
                        </button>
                    {/if}

                    <!-- 6. Export Chat -->
                    <button
                        onclick={() => {
                            if (activeActionChat) {
                                void handleExportSingleChat(activeActionChat.index);
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-xs font-semibold transition-colors"
                    >
                        <DownloadIcon size={16} class="text-emerald-400" />
                        <span>Export Chat</span>
                    </button>

                    <!-- 7. Delete Chat -->
                    <button
                        onclick={() => {
                            if (activeActionChat) {
                                void handleDeleteChat(activeActionChat.index, activeActionChat.chat.name || "Chat");
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-draculared/10 text-draculared text-xs font-semibold transition-colors"
                    >
                        <TrashIcon size={16} />
                        <span>Delete Chat</span>
                    </button>
                </div>
            </div>
        </div>
    {/if}

    <!-- FOLDER ACTIONS BOTTOM SHEET -->
    {#if activeFolderAction}
        <div
            role="dialog"
            aria-modal="true"
            class="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] flex items-end justify-center p-0 sm:p-4"
        >
            <button
                type="button"
                tabindex="-1"
                class="fixed inset-0 z-0 bg-transparent cursor-default"
                onclick={() => { activeFolderAction = null; }}
                aria-label="Close menu"
            ></button>

            <div
                class="relative z-10 w-full max-w-md bg-darkbg border border-darkborderc rounded-t-3xl sm:rounded-3xl p-4 flex flex-col gap-3 shadow-2xl pb-[max(env(safe-area-inset-bottom),20px)]"
            >
                <div class="flex items-center justify-between border-b border-darkborderc/60 pb-3">
                    <div class="flex items-center gap-2.5 min-w-0">
                        <FolderIcon size={18} class="text-blue-400" />
                        <span class="font-bold text-sm text-textcolor truncate">{activeFolderAction.folder.name || "Folder"}</span>
                    </div>
                    <button
                        onclick={() => { activeFolderAction = null; }}
                        class="p-1 text-textcolor2 hover:text-textcolor rounded-lg"
                    >
                        <XIcon size={18} />
                    </button>
                </div>

                <div class="flex flex-col gap-1">
                    <button
                        onclick={() => {
                            if (activeFolderAction) {
                                void handleRenameFolder(activeFolderAction.index, activeFolderAction.folder.name || "Folder");
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darkbutton text-textcolor text-xs font-semibold transition-colors"
                    >
                        <PencilIcon size={16} class="text-amber-400" />
                        <span>Rename Folder</span>
                    </button>

                    <button
                        onclick={() => {
                            if (activeFolderAction) {
                                void handleDeleteFolder(activeFolderAction.index, activeFolderAction.folder.id, activeFolderAction.folder.name || "Folder");
                            }
                        }}
                        class="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-draculared/10 text-draculared text-xs font-semibold transition-colors"
                    >
                        <TrashIcon size={16} />
                        <span>Delete Folder</span>
                    </button>
                </div>
            </div>
        </div>
    {/if}
</div>

<style>
    .no-scrollbar::-webkit-scrollbar {
        display: none;
    }
    .no-scrollbar {
        -ms-overflow-style: none;
        scrollbar-width: none;
    }
</style>
