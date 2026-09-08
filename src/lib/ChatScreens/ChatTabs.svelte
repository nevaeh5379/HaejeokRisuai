<script module lang="ts">
    import type { TauriChatDragPayload } from 'src/ts/tauriChatWindows';

    let tauriChatTabDrag: {
        payload: TauriChatDragPayload;
        sourceGroupId: string;
        dropped: boolean;
        transferred: boolean;
    } | null = null;
    let lastWorkspaceSnapshotKey = '';
</script>

<script lang="ts">
    import { PlusIcon, XIcon } from '@lucide/svelte';
    import { onDestroy } from 'svelte';
    import { MobileGUI, selectedCharID } from 'src/ts/stores.svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { activeGenerationChatIds } from 'src/ts/process/chatRuntimeState';
    import { isTauri, isTauriMacOS } from 'src/ts/platform';
    import { alertError } from 'src/ts/alert';
    import { RISU_CHAT_TAB_DRAG_TYPE } from 'src/ts/dragTypes';
    import {
        clearActiveTauriChatDragPayload,
        clearTauriChatDockPreview,
        completeCurrentTauriTabTransfer,
        createTauriChatDragPayload,
        getActiveTauriChatDragPayload,
        getCurrentChatWorkspaceWindowId,
        findTauriWorkspaceWindowUnderCursor,
        isCurrentTauriCursorOutsideWindow,
        moveCurrentTauriWorkspaceWindowToCursor,
        moveTabToNewTauriWorkspaceWindow,
        openChatInNewTauriWindow,
        parseTauriChatDragPayload,
        publishActiveTauriChatDragPayload,
        publishCurrentTauriChatWorkspaceState,
        requestTauriChatTabTransferToWindow,
        resolveTauriOutsideTabDropAction,
        serializeTauriChatDragPayload,
        TAURI_CHAT_DRAG_MIME,
        updateTauriChatDockPreview,
    } from 'src/ts/tauriChatWindows';
    import {
        chatTabsStore,
        navigateToChatTab,
        type ChatTab,
    } from 'src/ts/chatTabs.svelte';

    interface Props {
        groupId: string;
        reserveSidebarSpace?: boolean;
        allowSplit?: boolean;
    }

    let { groupId, reserveSidebarSpace = false, allowSplit = false }: Props = $props();
    let showTabs = $derived(settingsStore.state.showChatTabs ?? true);
    let groupTabs = $derived(chatTabsStore.tabsForGroup(groupId));
    let reserveMacOSTrafficLights = $derived(
        isTauriMacOS &&
        getCurrentChatWorkspaceWindowId() !== 'main' &&
        chatTabsStore.groups[0]?.id === groupId,
    );
    let selectedCharacter = $derived(characterStore.characters[$selectedCharID]);
    let selectedChat = $derived(
        selectedCharacter?.chats?.[selectedCharacter.chatPage ?? 0],
    );
    let contextMenu = $state<{ tabId: string; x: number; y: number } | null>(null);
    let drag: {
        tabId: string;
        sourceGroupId: string;
        pointerId: number;
        pointerType: string;
        startX: number;
        startY: number;
        x: number;
        y: number;
        source: HTMLElement;
        active: boolean;
        targetGroupId?: string;
        targetIndex?: number;
        ghost?: HTMLElement;
        marker?: HTMLElement;
        holdTimer?: ReturnType<typeof setTimeout>;
        previousUserSelect?: string;
        detaching?: boolean;
    } | null = null;
    let suppressClickTabId: string | null = null;
    let detachedDropActive = $state(false);
    let nativeDragMarker: HTMLElement | undefined;
    let dockPreviewTimer: ReturnType<typeof setInterval> | null = null;
    let dockPreviewUpdatePromise: Promise<void> | null = null;

    onDestroy(() => {
        clearTabDrag();
        stopTauriDockPreview();
    });

    $effect(() => {
        if (chatTabsStore.focusedGroupId !== groupId) return;
        const characterId = selectedCharacter?.chaId;
        const chatId = selectedChat?.id;
        if (characterId && chatId) {
            chatTabsStore.syncActiveTarget(characterId, chatId, groupId);
        }
    });

    $effect(() => {
        if (!isTauri) return;
        const snapshotKey = JSON.stringify(chatTabsStore.snapshot());
        if (snapshotKey === lastWorkspaceSnapshotKey) return;
        lastWorkspaceSnapshotKey = snapshotKey;
        void publishCurrentTauriChatWorkspaceState();
    });

    function getTabLabel(tab: ChatTab) {
        const character = characterStore.characters.find((item) => item.chaId === tab.characterId);
        const chat = character?.chats?.find((item) => item.id === tab.chatId);
        return {
            characterName: character?.name || 'RisuAI',
            chatName: chat?.name || 'Chat',
        };
    }

    function addTab() {
        chatTabsStore.focusGroup(groupId);
        chatTabsStore.addFromCurrent(groupId);
    }

    async function closeTab(event: Event, tab: ChatTab) {
        event.stopPropagation();
        const result = chatTabsStore.close(tab.id);
        if (result.activeChanged && result.activeTab) {
            await navigateToChatTab(result.activeTab.id);
        }
    }

    function openContextMenu(event: MouseEvent, tab: ChatTab) {
        event.preventDefault();
        if ($MobileGUI) return;
        event.stopPropagation();
        contextMenu = {
            tabId: tab.id,
            x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
            y: Math.max(8, Math.min(event.clientY, window.innerHeight - 320)),
        };
        void navigateToChatTab(tab.id);
    }

    async function openInNewWindow(tab: ChatTab) {
        contextMenu = null;
        const label = getTabLabel(tab);
        try {
            await openChatInNewTauriWindow(
                tab,
                `${label.characterName} · ${label.chatName} - RisuAI`,
                label,
            );
        } catch (error) {
            console.error("[ChatTabs] Failed to open Tauri chat window", error);
            alertError(error);
        }
    }

    async function splitRight(tabId: string) {
        const tab = chatTabsStore.splitRight(tabId);
        contextMenu = null;
        if (tab) await navigateToChatTab(tab.id);
    }

    async function moveTab(tabId: string, direction: -1 | 1) {
        const tab = chatTabsStore.moveToAdjacentGroup(tabId, direction);
        contextMenu = null;
        if (tab) await navigateToChatTab(tab.id);
    }

    function selectTab(event: MouseEvent, tabId: string) {
        if (suppressClickTabId === tabId) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        void navigateToChatTab(tabId);
    }

    function startTabDrag(event: PointerEvent, tab: ChatTab) {
        if (isTauri && event.pointerType === 'mouse') return;
        if (event.button !== 0 || (event.target as HTMLElement).closest('[data-tab-close]')) return;
        clearTabDrag();
        drag = {
            tabId: tab.id,
            sourceGroupId: tab.groupId,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            startX: event.clientX,
            startY: event.clientY,
            x: event.clientX,
            y: event.clientY,
            source: event.currentTarget as HTMLElement,
            active: false,
        };
        if (event.pointerType !== 'mouse') {
            drag.holdTimer = setTimeout(() => activateTabDrag(), 180);
        }
    }

    function activateTabDrag() {
        if (!drag || drag.active) return;
        drag.active = true;
        contextMenu = null;
        drag.source.classList.add('chat-tab-chosen');
        try {
            drag.source.setPointerCapture?.(drag.pointerId);
        } catch {
            // The pointer may have been cancelled between the hold timer and activation.
        }
        const rect = drag.source.getBoundingClientRect();
        const ghost = drag.source.cloneNode(true) as HTMLElement;
        ghost.removeAttribute('id');
        ghost.classList.add('chat-tab-dragging');
        ghost.style.position = 'fixed';
        ghost.style.left = '0';
        ghost.style.top = '0';
        ghost.style.width = `${rect.width}px`;
        ghost.style.height = `${rect.height}px`;
        ghost.style.pointerEvents = 'none';
        ghost.style.zIndex = '200';
        ghost.style.opacity = '0.9';
        document.body.appendChild(ghost);
        drag.previousUserSelect = document.body.style.userSelect;
        document.body.style.userSelect = 'none';
        drag.ghost = ghost;
        updateTabDropTarget();
    }

    function moveTabDrag(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        drag.x = event.clientX;
        drag.y = event.clientY;
        const distance = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
        if (!drag.active) {
            if (drag.pointerType !== 'mouse') {
                if (distance > 8) clearTabDrag();
                return;
            }
            if (distance < 5) return;
            activateTabDrag();
        }
        event.preventDefault();
        updateTabDropTarget();
    }

    function updateTabDropTarget() {
        if (!drag?.active) return;
        drag.ghost?.style.setProperty('transform', `translate(${drag.x + 12}px, ${drag.y + 12}px)`);
        drag.marker?.classList.remove('chat-tab-drop-before');
        drag.marker = undefined;
        drag.targetGroupId = undefined;
        drag.targetIndex = undefined;

        const pointed = document.elementFromPoint(drag.x, drag.y) as HTMLElement | null;
        const list = pointed?.closest<HTMLElement>('[data-chat-tab-list]');
        const targetGroupId = list?.dataset.groupId;
        if (!list || !targetGroupId) return;
        const tabs = Array.from(list.querySelectorAll<HTMLElement>('[data-chat-tab-id]'))
            .filter((item) => item.dataset.chatTabId !== drag!.tabId);
        let targetIndex = tabs.findIndex((item) => drag!.x < item.getBoundingClientRect().left + item.offsetWidth / 2);
        if (targetIndex < 0) targetIndex = tabs.length;
        const marker = tabs[targetIndex] ?? list.querySelector<HTMLElement>('[data-tab-add]');
        marker?.classList.add('chat-tab-drop-before');
        drag.marker = marker ?? undefined;
        drag.targetGroupId = targetGroupId;
        drag.targetIndex = targetIndex;
    }

    async function detachDraggedTab() {
        if (!isTauri || !drag?.active || drag.targetGroupId || drag.detaching) return;
        const activeDrag = drag;
        const tab = chatTabsStore.tabs.find((item) => item.id === activeDrag.tabId);
        if (!tab) return;

        activeDrag.detaching = true;
        const sourceWindowId = getCurrentChatWorkspaceWindowId();
        const action = resolveTauriOutsideTabDropAction(
            sourceWindowId,
            chatTabsStore.tabs.length,
            null,
        );
        if (action === 'move-current-window') {
            await moveCurrentTauriWorkspaceWindowToCursor();
            clearTabDrag();
            return;
        }
        const label = getTabLabel(tab);
        try {
            await openChatInNewTauriWindow(
                tab,
                `${label.characterName} · ${label.chatName} - RisuAI`,
                label,
            );
            const result = chatTabsStore.detach(tab.id);
            clearTabDrag();
            if (result.becameEmpty) {
                selectedCharID.set(-1);
            } else if (result.activeChanged && result.activeTab) {
                await navigateToChatTab(result.activeTab.id);
            }
        } catch (error) {
            activeDrag.detaching = false;
            console.error('[ChatTabs] Failed to detach Tauri chat tab', error);
            clearTabDrag();
            alertError(error);
        }
    }

    async function stopTabDrag(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const completed = drag.active;
        const activeDrag = drag;
        const { tabId, sourceGroupId, targetGroupId, targetIndex } = activeDrag;
        if (completed) suppressClickTabId = tabId;

        if (
            completed &&
            isTauri &&
            !activeDrag.detaching &&
            (!targetGroupId || targetIndex === undefined)
        ) {
            try {
                if (await isCurrentTauriCursorOutsideWindow()) {
                    await detachDraggedTab();
                    setTimeout(() => { suppressClickTabId = null; }, 0);
                    return;
                }
            } catch (error) {
                console.error('[ChatTabs] Failed to inspect Tauri tab drop position', error);
            }
        }

        clearTabDrag();
        if (completed) setTimeout(() => { suppressClickTabId = null; }, 0);
        if (!completed || !targetGroupId || targetIndex === undefined) return;
        const moved = chatTabsStore.moveTab(tabId, targetGroupId, targetIndex);
        if (moved && sourceGroupId !== targetGroupId) await navigateToChatTab(moved.id);
    }

    function clearTabDrag() {
        if (!drag) return;
        if (drag.holdTimer) clearTimeout(drag.holdTimer);
        drag.marker?.classList.remove('chat-tab-drop-before');
        drag.source.classList.remove('chat-tab-chosen');
        drag.ghost?.remove();
        document.body.style.userSelect = drag.previousUserSelect ?? '';
        drag = null;
    }

    function closeOthers(tabId: string) {
        chatTabsStore.closeOthers(tabId);
        contextMenu = null;
    }

    function readWorkspaceDragPayload(dataTransfer: DataTransfer | null) {
        if (!dataTransfer) return null;
        const custom = dataTransfer.getData(TAURI_CHAT_DRAG_MIME);
        if (custom) return parseTauriChatDragPayload(custom);
        const active = getActiveTauriChatDragPayload();
        return active?.sourceWindowId === getCurrentChatWorkspaceWindowId() ? null : active;
    }

    function canAcceptWorkspaceDrag(dataTransfer: DataTransfer | null) {
        if (!isTauri || !dataTransfer) return false;
        if (Array.from(dataTransfer.types).some(
            (type) => type === TAURI_CHAT_DRAG_MIME || type === RISU_CHAT_TAB_DRAG_TYPE,
        )) return true;
        const active = getActiveTauriChatDragPayload();
        return Boolean(active && active.sourceWindowId !== getCurrentChatWorkspaceWindowId());
    }

    function stopTauriDockPreview() {
        if (dockPreviewTimer) clearInterval(dockPreviewTimer);
        dockPreviewTimer = null;
        const payload = tauriChatTabDrag?.payload;
        if (payload) void clearTauriChatDockPreview(payload);
    }

    function startTauriDockPreview(payload: TauriChatDragPayload) {
        stopTauriDockPreview();
        const update = async () => {
            if (dockPreviewUpdatePromise || tauriChatTabDrag?.payload.transferId !== payload.transferId) return;
            dockPreviewUpdatePromise = (async () => {
                try {
                    await updateTauriChatDockPreview(payload);
                } catch (error) {
                    console.debug('[ChatTabs] Failed to update Tauri dock preview', error);
                }
            })();
            try {
                await dockPreviewUpdatePromise;
            } finally {
                dockPreviewUpdatePromise = null;
            }
        };
        void update();
        dockPreviewTimer = setInterval(() => void update(), 100);
    }

    function startTauriMainTabDrag(event: DragEvent, tab: ChatTab) {
        if (!isTauri || !event.dataTransfer) {
            event.preventDefault();
            return;
        }
        clearTabDrag();
        contextMenu = null;
        const payload = createTauriChatDragPayload(tab);
        const state = {
            payload,
            sourceGroupId: tab.groupId,
            dropped: false,
            transferred: false,
        };
        tauriChatTabDrag = state;
        suppressClickTabId = tab.id;
        const serialized = serializeTauriChatDragPayload(payload);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(RISU_CHAT_TAB_DRAG_TYPE, serialized);
        event.dataTransfer.setData(TAURI_CHAT_DRAG_MIME, serialized);
        publishActiveTauriChatDragPayload(payload);
        startTauriDockPreview(payload);
        (event.currentTarget as HTMLElement).classList.add('chat-tab-chosen');

    }

    function clearNativeTabDropMarker() {
        nativeDragMarker?.classList.remove('chat-tab-drop-before');
        nativeDragMarker = undefined;
    }

    function updateNativeTabDropTarget(
        list: HTMLElement,
        clientX: number,
        sourceTabId?: string,
    ) {
        clearNativeTabDropMarker();
        const tabs = Array.from(list.querySelectorAll<HTMLElement>('[data-chat-tab-id]'))
            .filter((item) => item.dataset.chatTabId !== sourceTabId);
        let targetIndex = tabs.findIndex(
            (item) => clientX < item.getBoundingClientRect().left + item.offsetWidth / 2,
        );
        if (targetIndex < 0) targetIndex = tabs.length;
        const marker = tabs[targetIndex] ?? list.querySelector<HTMLElement>('[data-tab-add]');
        marker?.classList.add('chat-tab-drop-before');
        nativeDragMarker = marker ?? undefined;
        return targetIndex;
    }

    async function endTauriMainTabDrag(event: DragEvent, tab: ChatTab) {
        const state = tauriChatTabDrag;
        (event.currentTarget as HTMLElement).classList.remove('chat-tab-chosen');
        clearNativeTabDropMarker();
        if (!state || state.payload.tab.id !== tab.id) return;
        tauriChatTabDrag = null;
        if (dockPreviewTimer) clearInterval(dockPreviewTimer);
        dockPreviewTimer = null;

        try {
            if (state.dropped || state.transferred) return;
            if (!(await isCurrentTauriCursorOutsideWindow())) return;

            const targetWindowId = await findTauriWorkspaceWindowUnderCursor(
                state.payload.sourceWindowId,
            );
            const action = resolveTauriOutsideTabDropAction(
                state.payload.sourceWindowId,
                chatTabsStore.tabs.length,
                targetWindowId,
            );
            if (action === 'transfer' && targetWindowId) {
                const accepted = await requestTauriChatTabTransferToWindow(
                    state.payload,
                    targetWindowId,
                );
                if (accepted) {
                    state.transferred = true;
                    await completeCurrentTauriTabTransfer(state.payload);
                }
                return;
            }
            if (action === 'move-current-window') {
                await moveCurrentTauriWorkspaceWindowToCursor();
                return;
            }

            const label = getTabLabel(tab);
            const created = await moveTabToNewTauriWorkspaceWindow(
                tab,
                `${label.characterName} · ${label.chatName} - RisuAI`,
                label,
            );
            if (created) {
                state.transferred = true;
                await completeCurrentTauriTabTransfer(state.payload);
            }
        } catch (error) {
            console.error('[ChatTabs] Failed to detach Tauri workspace tab', error);
            alertError(error);
        } finally {
            if (dockPreviewUpdatePromise) await dockPreviewUpdatePromise;
            await clearTauriChatDockPreview(state.payload);
            clearActiveTauriChatDragPayload(state.payload.transferId);
            setTimeout(() => { suppressClickTabId = null; }, 0);
        }
    }

    function dragTabListOver(event: DragEvent) {
        if (!canAcceptWorkspaceDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const sourceTabId = tauriChatTabDrag?.payload.tab.id;
        updateNativeTabDropTarget(event.currentTarget as HTMLElement, event.clientX, sourceTabId);
        detachedDropActive = !tauriChatTabDrag;
    }

    function leaveTabListDrag(event: DragEvent) {
        const list = event.currentTarget as HTMLElement;
        const next = event.relatedTarget as Node | null;
        if (next && list.contains(next)) return;
        clearNativeTabDropMarker();
        detachedDropActive = false;
    }

    async function dropTabList(event: DragEvent) {
        if (!isTauri || !canAcceptWorkspaceDrag(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        detachedDropActive = false;
        const localState = tauriChatTabDrag;
        const payload = readWorkspaceDragPayload(event.dataTransfer);
        const sourceTabId = localState?.payload.tab.id ?? payload?.tab.id;
        const targetIndex = updateNativeTabDropTarget(
            event.currentTarget as HTMLElement,
            event.clientX,
            sourceTabId,
        );
        clearNativeTabDropMarker();

        if (localState) {
            const moved = chatTabsStore.moveTab(
                localState.payload.tab.id,
                groupId,
                targetIndex,
            );
            localState.dropped = Boolean(moved);
            if (moved && localState.sourceGroupId !== groupId) {
                await navigateToChatTab(moved.id);
            }
            return;
        }

        // Cross-window ownership transfer is resolved by the source window on
        // dragend using native window hit-testing. WKWebView does not reliably
        // preserve custom MIME/drop callbacks across macOS windows.
        if (!payload) return;
    }

    function closeToRight(tabId: string) {
        chatTabsStore.closeToRight(tabId);
        contextMenu = null;
    }
</script>

<svelte:window
    onclick={() => { contextMenu = null }}
    onpointermove={moveTabDrag}
    onpointerup={stopTabDrag}
    onpointercancel={clearTabDrag}
/>

{#if showTabs}
    <div
        data-chat-tab-list
        data-group-id={groupId}
        role="tablist"
        tabindex="-1"
        data-tauri-drag-region={isTauriMacOS ? "true" : undefined}
        ondragover={dragTabListOver}
        ondragleave={leaveTabListDrag}
        ondrop={(event) => void dropTabList(event)}
        class="rs-chat-tab-list shrink-0 h-10 flex items-end gap-1 pr-2 pt-1 overflow-x-auto bg-darkbg/70 border-b border-darkborderc backdrop-blur-sm"
        class:ring-2={detachedDropActive}
        class:ring-blue-500={detachedDropActive}
        class:pl-14={!$MobileGUI && reserveSidebarSpace}
        class:pl-2={$MobileGUI || !reserveSidebarSpace}
        class:ring-1={!$MobileGUI && chatTabsStore.focusedGroupId === groupId && chatTabsStore.groups.length > 1}
        class:ring-textcolor2={!$MobileGUI && chatTabsStore.focusedGroupId === groupId && chatTabsStore.groups.length > 1}
        class:macos-aux-titlebar-tabs={reserveMacOSTrafficLights}
    >
        {#each groupTabs as tab (tab.id)}
            {@const label = getTabLabel(tab)}
            {@const active = chatTabsStore.getGroup(groupId)?.activeTabId === tab.id}
            {@const generating = $activeGenerationChatIds.has(tab.chatId)}
            <button
                data-chat-tab-id={tab.id}
                data-active={active}
                class="rs-chat-tab group h-9 min-w-32 max-w-56 px-2 rounded-t-md flex items-center gap-2 border border-b-0 border-darkborderc transition-colors cursor-grab active:cursor-grabbing select-none"
                class:bg-selected={active}
                class:bg-bgcolor={!active}
                class:text-textcolor={active}
                class:text-textcolor2={!active}
                title={`${label.characterName} · ${label.chatName}`}
                draggable={isTauri}
                onclick={(event) => selectTab(event, tab.id)}
                ondragstart={(event) => startTauriMainTabDrag(event, tab)}
                ondragend={(event) => void endTauriMainTabDrag(event, tab)}
                onpointerdown={(event) => startTabDrag(event, tab)}
                oncontextmenu={(event) => openContextMenu(event, tab)}
            >
                {#if generating}
                    <span class="w-3 h-3 shrink-0 rounded-full border-2 border-current border-r-transparent animate-spin"></span>
                {:else if tab.unread}
                    <span class="w-2 h-2 shrink-0 rounded-full bg-green-500"></span>
                {/if}
                <span class="min-w-0 flex-1 text-left leading-tight">
                    <span class="block truncate text-xs font-medium">{label.characterName}</span>
                    <span class="block truncate text-[10px] opacity-70">{label.chatName}</span>
                </span>
                {#if chatTabsStore.tabs.length > 1}
                    <span
                        data-tab-close
                        role="button"
                        tabindex="0"
                        class="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100 hover:bg-black/20"
                        onclick={(event) => void closeTab(event, tab)}
                        onkeydown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                void closeTab(event, tab);
                            }
                        }}
                        aria-label="Close chat tab"
                    >
                        <XIcon size={14} />
                    </span>
                {/if}
            </button>
        {/each}
        <button
            data-tab-add
            class="h-8 w-8 mb-0.5 shrink-0 flex items-center justify-center rounded-md text-textcolor2 hover:text-textcolor hover:bg-selected transition-colors"
            title="New chat tab"
            aria-label="New chat tab"
            onclick={addTab}
        >
            <PlusIcon size={17} />
        </button>
    </div>
{/if}

{#if contextMenu && showTabs}
    {@const menuTab = chatTabsStore.tabs.find((tab) => tab.id === contextMenu?.tabId)}
    {#if menuTab}
        <div
            role="menu"
            tabindex="-1"
            class="fixed z-[100] w-52 rounded-md border border-darkborderc bg-darkbg py-1 text-sm text-textcolor shadow-2xl"
            style:left={`${contextMenu.x}px`}
            style:top={`${contextMenu.y}px`}
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
            oncontextmenu={(event) => event.preventDefault()}
        >
            {#if isTauri}
                <button class="w-full px-3 py-2 text-left hover:bg-selected" onclick={() => void openInNewWindow(menuTab)}>새 창에서 열기</button>
                <div class="my-1 border-t border-darkborderc"></div>
            {/if}
            {#if allowSplit && chatTabsStore.canSplit()}
                <button class="w-full px-3 py-2 text-left hover:bg-selected" onclick={() => void splitRight(menuTab.id)}>오른쪽으로 분할</button>
                <div class="my-1 border-t border-darkborderc"></div>
            {/if}
            {#if chatTabsStore.hasAdjacentGroup(menuTab.groupId, -1)}
                <button class="w-full px-3 py-2 text-left hover:bg-selected" onclick={() => void moveTab(menuTab.id, -1)}>왼쪽 그룹으로 이동</button>
            {/if}
            {#if chatTabsStore.hasAdjacentGroup(menuTab.groupId, 1)}
                <button class="w-full px-3 py-2 text-left hover:bg-selected" onclick={() => void moveTab(menuTab.id, 1)}>오른쪽 그룹으로 이동</button>
            {/if}
            {#if chatTabsStore.groups.length > 1}
                <div class="my-1 border-t border-darkborderc"></div>
            {/if}
            <button class="w-full px-3 py-2 text-left hover:bg-selected" onclick={() => closeOthers(menuTab.id)}>다른 탭 닫기</button>
            <button class="w-full px-3 py-2 text-left hover:bg-selected" onclick={() => closeToRight(menuTab.id)}>오른쪽 탭 닫기</button>
            <button class="w-full px-3 py-2 text-left hover:bg-selected" onclick={(event) => void closeTab(event, menuTab)}>닫기</button>
        </div>
    {/if}
{/if}

<style>
    :global(.chat-tab-chosen) {
        opacity: 0.45;
    }

    :global(.chat-tab-dragging) {
        cursor: grabbing;
        box-shadow: 0 8px 24px rgb(0 0 0 / 0.35);
    }

    :global(.chat-tab-drop-before) {
        box-shadow: -3px 0 0 var(--risu-theme-textcolor2);
    }

    :global(html[data-risu-chat-dock-preview='true'] [data-chat-tab-list]) {
        outline: 2px solid rgb(59 130 246);
        outline-offset: -2px;
        box-shadow: inset 0 -2px 0 rgb(59 130 246 / 0.7);
    }
</style>
