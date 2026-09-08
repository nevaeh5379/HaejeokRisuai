<script lang="ts">
    import { onMount } from 'svelte';
    import { alertError } from 'src/ts/alert';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import {
        parseTauriChatWindowTarget,
        startDetachedTauriChatWindowDrag,
        watchDetachedTauriChatWindowDocking,
    } from 'src/ts/tauriChatWindows';

    const target = parseTauriChatWindowTarget(location.search);
    let character = $derived(
        target ? characterStore.characters.find((item) => item.chaId === target.characterId) : undefined,
    );
    let chat = $derived(
        target ? character?.chats?.find((item) => item.id === target.chatId) : undefined,
    );

    onMount(() => {
        if (!target) return;
        let unlisten: (() => void) | undefined;
        void watchDetachedTauriChatWindowDocking(target).then((cleanup) => {
            unlisten = cleanup;
        });
        return () => unlisten?.();
    });

    async function startDrag(event: PointerEvent) {
        if (event.button !== 0) return;
        event.preventDefault();
        try {
            await startDetachedTauriChatWindowDrag();
        } catch (error) {
            console.error('[DetachedChatHeader] Failed to drag Tauri window', error);
            alertError(error);
        }
    }
</script>

<div
    class="relative z-30 h-9 shrink-0 border-b border-darkborderc bg-darkbg/90 px-2 pt-1 backdrop-blur-sm"
>
    <button
        class="h-8 min-w-32 max-w-72 cursor-grab select-none rounded-t-md border border-b-0 border-darkborderc bg-selected px-3 text-left text-textcolor active:cursor-grabbing"
        title="Drag this tab onto the main window tab bar to dock it"
        onpointerdown={startDrag}
    >
        <span class="block truncate text-xs font-medium">{character?.name || 'RisuAI'}</span>
        <span class="block truncate text-[10px] opacity-70">{chat?.name || 'Chat'}</span>
    </button>
</div>
