<script lang="ts">
    import { onMount } from 'svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import {
        closeCurrentDetachedTauriChatWindow,
        getCurrentTauriChatWindowDragPayload,
        parseTauriChatWindowTarget,
        serializeTauriChatDragPayload,
        TAURI_CHAT_DRAG_MIME,
        watchDetachedTauriChatDropAck,
        type TauriChatDragPayload,
    } from 'src/ts/tauriChatWindows';

    const TEXT_DRAG_PREFIX = 'risu-chat-tab:';
    const target = parseTauriChatWindowTarget(location.search);
    let dragPayload = $state<TauriChatDragPayload | null>(null);
    let character = $derived(
        target ? characterStore.characters.find((item) => item.chaId === target.characterId) : undefined,
    );
    let chat = $derived(
        target ? character?.chats?.find((item) => item.id === target.chatId) : undefined,
    );

    onMount(() => {
        if (!target) return;
        let disposed = false;
        let unlisten: (() => void) | undefined;
        void getCurrentTauriChatWindowDragPayload(target).then(async (payload) => {
            if (disposed || !payload) return;
            const cleanup = await watchDetachedTauriChatDropAck(payload, () => {
                void closeCurrentDetachedTauriChatWindow();
            });
            if (disposed) {
                cleanup();
                return;
            }
            unlisten = cleanup;
            dragPayload = payload;
        });
        return () => {
            disposed = true;
            unlisten?.();
        };
    });

    function startDrag(event: DragEvent) {
        if (!dragPayload || !event.dataTransfer) {
            event.preventDefault();
            return;
        }
        const serialized = serializeTauriChatDragPayload(dragPayload);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(TAURI_CHAT_DRAG_MIME, serialized);
        event.dataTransfer.setData('text/plain', `${TEXT_DRAG_PREFIX}${serialized}`);
    }
</script>

<div class="relative z-30 h-9 shrink-0 border-b border-darkborderc bg-darkbg/90 px-2 pt-1 backdrop-blur-sm">
    <button
        draggable={Boolean(dragPayload)}
        class="h-8 min-w-32 max-w-72 cursor-grab select-none rounded-t-md border border-b-0 border-darkborderc bg-selected px-3 text-left text-textcolor active:cursor-grabbing"
        class:opacity-60={!dragPayload}
        title="Drag this tab onto the main window tab bar, then release to dock it"
        ondragstart={startDrag}
    >
        <span class="block truncate text-xs font-medium">{character?.name || 'RisuAI'}</span>
        <span class="block truncate text-[10px] opacity-70">{chat?.name || 'Chat'}</span>
    </button>
</div>
