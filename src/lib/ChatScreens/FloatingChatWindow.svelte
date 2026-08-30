<script lang="ts">
    import { XIcon, Maximize2Icon } from '@lucide/svelte';
    import { getCharImage } from 'src/ts/characterImage';
    import { characterStore } from 'src/ts/stores/domain';
    import { selectedCharID } from 'src/ts/stores.svelte';
    import {
        floatingChatStore,
        closeFloatingChat,
        clampFloatingChat,
    } from 'src/ts/floatingChat.svelte';
    import DefaultChatScreen from './DefaultChatScreen.svelte';
    import { language } from 'src/lang';

    let pinnedCharacterIndex = $derived(
        floatingChatStore.open
            ? characterStore.characters.findIndex(
                  (character) => character.chaId === floatingChatStore.characterId,
              )
            : -1
    )
    let currentCharacter = $derived(
        pinnedCharacterIndex >= 0 ? characterStore.characters[pinnedCharacterIndex] : undefined
    )

    function expandToMainScreen() {
        const index = pinnedCharacterIndex
        closeFloatingChat()
        if (index >= 0) {
            selectedCharID.set(index)
        }
    }

    function close() {
        closeFloatingChat()
    }

    let dragTarget: HTMLElement | null = null
    type DragMode = 'move' | 'resize-bottom-right' | 'resize-bottom-left'
    let dragMode: DragMode = 'move'
    let dragStart = { pointerX: 0, pointerY: 0, x: 0, y: 0, width: 0, height: 0 }

    function startPointerMode(event: PointerEvent, mode: DragMode) {
        if ((event.target as HTMLElement).closest('button')) return
        dragMode = mode
        dragTarget = event.currentTarget as HTMLElement
        dragStart = {
            pointerX: event.clientX,
            pointerY: event.clientY,
            x: floatingChatStore.x,
            y: floatingChatStore.y,
            width: floatingChatStore.width,
            height: floatingChatStore.height,
        }
        event.preventDefault()
        dragTarget.setPointerCapture(event.pointerId)
    }

    function onPointerMove(event: PointerEvent) {
        if (!dragTarget) return
        const deltaX = event.clientX - dragStart.pointerX
        const deltaY = event.clientY - dragStart.pointerY
        if (dragMode === 'move') {
            floatingChatStore.x = dragStart.x + deltaX
            floatingChatStore.y = dragStart.y + deltaY
                clampFloatingChat()
        } else {
            if (dragMode === 'resize-bottom-right') {
                floatingChatStore.width = dragStart.width + deltaX
            } else {
                floatingChatStore.width = dragStart.width - deltaX
                floatingChatStore.x = dragStart.x + deltaX
            }
            floatingChatStore.height = dragStart.height + deltaY
            if (floatingChatStore.width !== dragStart.width) {
                // When clamped, keep the anchor edge fixed while resizing from the left.
                floatingChatStore.x = dragMode === 'resize-bottom-left' ? dragStart.x + (dragStart.width - floatingChatStore.width) : dragStart.x
            }
            clampFloatingChat()
        }
    }

    function stopPointer() {
        dragTarget = null
    }

    let characterName = $derived(currentCharacter?.name ?? '')
    let characterIconCss = $state('')
    $effect(() => {
        const character = currentCharacter
        let cancelled = false
        characterIconCss = ''
        if (character?.image) {
            getCharImage(character.image, 'css')
                .then((css) => {
                    if (!cancelled) characterIconCss = css ?? ''
                })
                .catch(() => {})
        }
        return () => {
            cancelled = true
        }
    })
</script>

<svelte:window onresize={() => { if (floatingChatStore.open) clampFloatingChat() }} />

{#if floatingChatStore.open}
    <section
        class="fixed z-40 flex flex-col rounded-lg overflow-hidden border border-darkborderc bg-bgcolor shadow-2xl"
        style="left:{floatingChatStore.x}px; top:{floatingChatStore.y}px; width:{floatingChatStore.width}px; height:{floatingChatStore.height}px;"
        data-floating-chat-window
    >
        <header
            class="shrink-0 h-9 flex items-center gap-2 px-2 bg-darkbg border-b border-darkborderc cursor-move select-none touch-none"
            role="toolbar"
            tabindex="-1"
            aria-label={language.floatingChatHeader}
            onpointerdown={(e) => startPointerMode(e, 'move')}
            onpointermove={onPointerMove}
            onpointerup={stopPointer}
            onpointercancel={stopPointer}
        >
            {#if characterIconCss.length > 2}
                <div class="w-6 h-6 rounded-full bg-cover bg-center shrink-0" style={characterIconCss}></div>
            {/if}
            <span class="text-sm text-textcolor truncate grow pointer-events-none">{characterName}</span>
            <button
                class="p-1 rounded text-textcolor2 hover:text-textcolor hover:bg-selected transition-colors"
                title={language.floatingChatExpand}
                aria-label={language.floatingChatExpand}
                onclick={expandToMainScreen}
            >
                <Maximize2Icon size={14} />
            </button>
            <button
                class="p-1 rounded text-textcolor2 hover:text-draculared transition-colors"
                title={language.floatingChatClose}
                aria-label={language.floatingChatClose}
                onclick={close}
            >
                <XIcon size={14} />
            </button>
        </header>
        <div class="grow min-h-0 relative overflow-hidden">
            {#if currentCharacter}
                <DefaultChatScreen pinnedCharacterIndex={pinnedCharacterIndex} showTabs={false} />
            {:else}
                <div class="w-full h-full flex items-center justify-center p-6 text-center text-textcolor2">
                    {language.floatingChatUnavailable}
                </div>
            {/if}
        </div>
        <div
            class="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize touch-none"
            role="separator"
            aria-label={language.floatingChatResize}
            onpointerdown={(e) => startPointerMode(e, 'resize-bottom-right')}
            onpointermove={onPointerMove}
            onpointerup={stopPointer}
            onpointercancel={stopPointer}
        ></div>
        <div
            class="absolute bottom-0 left-0 w-3 h-3 cursor-nesw-resize touch-none"
            role="separator"
            aria-label={language.floatingChatResize}
            onpointerdown={(e) => startPointerMode(e, 'resize-bottom-left')}
            onpointermove={onPointerMove}
            onpointerup={stopPointer}
            onpointercancel={stopPointer}
        ></div>
    </section>
{/if}