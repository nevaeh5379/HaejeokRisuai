<script lang="ts">
    import type { character, groupChat, Message, StreamingDisplayOptimizationMode } from 'src/ts/storage/database.svelte';
    import { mount, onDestroy, unmount } from 'svelte';
    import Chat from './Chat.svelte';
    import { getCharImage } from 'src/ts/characters';
    import { createSimpleCharacter, selectedCharID, ReloadChatPointer, ReloadGUIPointer } from 'src/ts/stores.svelte';
    import { characterStore, settingsStore } from 'src/ts/stores/domain';
    import { chatFoldedStateMessageIndex } from 'src/ts/globalApi.svelte';
    import { get } from 'svelte/store';
    import { getAbsoluteChatMessageIndex } from 'src/ts/chatLoadPages';
    
    const getCurrentChatRoomId = () => {
        const charId = get(selectedCharID);
        if (charId < 0) return null;
        const char = characterStore.characters[charId];
        if (!char) return null;
        return char.chats?.[char.chatPage]?.id ?? null;
    };

    let {
        messages,
        currentCharacter,
        onReroll = () => {},
        unReroll = () => {},
        currentUsername,
        userIcon,
        loadPages = messages.length,
        userIconPortrait,
        hasNewUnreadMessage = $bindable(false),
        hideButtons = false,
        renderFromBeginning = false,
    }:{
        messages: Message[]
        currentCharacter: character|groupChat
        onReroll?: () => void
        unReroll?: () => void
        currentUsername: string
        userIcon: string
        loadPages?: number
        userIconPortrait?: boolean
        hasNewUnreadMessage?: boolean
        hideButtons?: boolean
        renderFromBeginning?: boolean
    } = $props();

    let chatBody: HTMLDivElement;
    type ChatInstance = {
        updateStreamingDisplay?: (state: {
            isOptimizedStreamingMessage: boolean
            streamingOptimizationMode: StreamingDisplayOptimizationMode
            rawStreamingText: string
        }) => void
    }
    type RenderSignature = {
        data: string
        idx: number
        scriptIdx: number
        role: string
        name: string
        largePortrait: boolean
        disabled: Message['disabled']
        reloadPointer: number
        guiReloadPointer: number
        hideButtons: boolean
        isComment: boolean
        activeStreaming: boolean
        generationInfo: Message['generationInfo']
    }
    type RenderEntry = {
        signature: RenderSignature
        instance: ChatInstance
        element: HTMLDivElement
    }
    const renderEntries = new Map<string, RenderEntry>();

    const messageRenderKey = (message: Message, index: number) =>
        message.chatId ? `message:${message.chatId}` : `index:${index}`;

    const sameRenderSignature = (left: RenderSignature, right: RenderSignature) =>
        left.data === right.data &&
        left.idx === right.idx &&
        left.scriptIdx === right.scriptIdx &&
        left.role === right.role &&
        left.name === right.name &&
        left.largePortrait === right.largePortrait &&
        left.disabled === right.disabled &&
        left.reloadPointer === right.reloadPointer &&
        left.guiReloadPointer === right.guiReloadPointer &&
        left.hideButtons === right.hideButtons &&
        left.isComment === right.isComment &&
        left.activeStreaming === right.activeStreaming &&
        left.generationInfo === right.generationInfo;

    const clearChatBody = () => {
        renderEntries.forEach(({ instance }) => {
            try { unmount(instance); } catch (e) {}
        });
        renderEntries.clear();
        if (chatBody) {
            chatBody.innerHTML = '';
        }
    };

    const updateChatBody = () => {
        if(!chatBody){
            return
        }

        let nextKey: string | null = null;
        const currentKeys = new Set<string>();
        const charImage = getCharImage(currentCharacter.image, 'css', { thumbnail: true })
        const userImage = getCharImage(userIcon, 'css', { thumbnail: true })
        const simpleChar = createSimpleCharacter(currentCharacter);
        let loadStart = messages.length - 1
        let loadEnd = messages.length - (loadPages ?? messages.length)
        if(renderFromBeginning){
            loadStart = Math.min(messages.length - 1, Math.max(0, (loadPages ?? messages.length) - 1))
            loadEnd = 0
        }
        const currentChat = currentCharacter?.chats?.[currentCharacter.chatPage]
        const configuredPerformanceMode = settingsStore.state.streamingDisplayOptimizationMode ?? 'off';
        const performanceMode = currentChat?.isStreaming
            ? currentChat.activeStreamingDisplayOptimizationMode ?? configuredPerformanceMode
            : configuredPerformanceMode
        const activeStreamingIndex = performanceMode !== 'off' && currentChat?.isStreaming
            ? messages.length - 1
            : -1

        if(!renderFromBeginning && !hideButtons && chatFoldedStateMessageIndex.index !== -1){
            loadStart = chatFoldedStateMessageIndex.index
            loadEnd = Math.max(0, chatFoldedStateMessageIndex.index - (loadPages ?? messages.length))
        }

        const reloadPointerMap = get(ReloadChatPointer);

        for(let i=loadStart ; i >= loadEnd; i--){
            if(i < 0) break;
            const message = messages[i];
            const scriptIdx = getAbsoluteChatMessageIndex(i, currentChat?.messageOffset);
            const key = messageRenderKey(message, i);
            currentKeys.add(key);
            const messageLargePortrait = message.role === 'user' ? (userIconPortrait ?? false) : ((currentCharacter as character).largePortrait ?? false);
            const reloadPointer = reloadPointerMap[i] ?? 0;
            const activeStreamingMessage = i === activeStreamingIndex && message.role === 'char';
            const signature: RenderSignature = {
                data: activeStreamingMessage ? '' : message.data,
                idx: i,
                scriptIdx,
                role: message.role,
                name: message.role === 'user' ? currentUsername : (message.name || currentCharacter.name),
                largePortrait: messageLargePortrait,
                disabled: message.disabled,
                reloadPointer,
                guiReloadPointer: $ReloadGUIPointer,
                hideButtons,
                isComment: message.isComment ?? false,
                activeStreaming: activeStreamingMessage,
                generationInfo: message.generationInfo,
            };
            let entry = renderEntries.get(key);
            const needsMount = !entry || !sameRenderSignature(entry.signature, signature);
            if(needsMount){
                let element: HTMLDivElement;
                if(entry){
                    try { unmount(entry.instance); } catch (e) {}
                    element = entry.element;
                } else {
                    element = document.createElement('div');
                    element.classList.add('chat-message-container');
                    const nextElement = nextKey ? renderEntries.get(nextKey)?.element : null;
                    if(nextElement){
                        chatBody.insertBefore(element, nextElement.nextSibling);
                    } else {
                        chatBody.prepend(element);
                    }
                }
                const instance = mount(Chat, {
                    target: element,
                    props: {
                        message: message.data,
                        isLastMemory: false,
                        idx: i,
                        scriptIdx,
                        totalLength: messages.length,
                        img: message.role === 'user' ? userImage : charImage,
                        onReroll: onReroll,
                        unReroll: unReroll,
                        rerollIcon: 'dynamic',
                        character: simpleChar,
                        largePortrait: messageLargePortrait,
                        messageGenerationInfo: message.generationInfo,
                        role: message.role,
                        name: signature.name,
                        isComment: signature.isComment,
                        disabled: message.disabled ?? false,
                        isOptimizedStreamingMessage: activeStreamingMessage,
                        streamingOptimizationMode: performanceMode,
                        rawStreamingText: message.data,
                        hideButtons: hideButtons,
                    },
                })
                entry = { signature, instance, element };
                renderEntries.set(key, entry);
            } else {
                entry.instance.updateStreamingDisplay?.({
                    isOptimizedStreamingMessage: activeStreamingMessage,
                    streamingOptimizationMode: performanceMode,
                    rawStreamingText: message.data,
                })
            }
            nextKey = key;
        }

        for (const [key, entry] of renderEntries) {
            if (currentKeys.has(key)) continue;
            try { unmount(entry.instance); } catch (e) {}
            entry.element.remove();
            renderEntries.delete(key);
        }
    };

    onDestroy(() => {
        clearChatBody();
    })

    function checkIfAtBottom() {
        if (!chatBody || !chatBody.parentElement) return true;
        const sc = chatBody.parentElement;
        const lastEl = chatBody.firstElementChild;
        if (!lastEl) return true;
        const rect = lastEl.getBoundingClientRect();
        const scRect = sc.getBoundingClientRect();
        return rect.top <= scRect.bottom + 100;
    }

    export const scrollToLatestMessage = () => {
        if(!chatBody) return;
        hasNewUnreadMessage = false;
        const element = chatBody.firstElementChild;
        if(element){
             element.scrollIntoView({ behavior: 'instant', block: 'start' });
        }
    }

    let previousLength = 0;
    let previousChatRoomId: string | null = null;

    $effect(() => {
        if(!hideButtons){
            void $ReloadChatPointer; // Make $effect track targeted message reloads
            void $ReloadGUIPointer; // Make global script/UI reloads invalidate every rendered message
        }
        const currentChatRoomId = getCurrentChatRoomId();
        const isSameChat = currentChatRoomId === previousChatRoomId;
        if (!isSameChat) {
            clearChatBody();
        }
        const wasAtBottom = checkIfAtBottom();
        updateChatBody()
        
        // Only auto-scroll if it's the same chat and new messages were added
        if(!hideButtons && isSameChat && messages.length > previousLength){
            const lastMsg = messages[messages.length - 1];
            if(lastMsg && lastMsg.role === 'char' && settingsStore.state.autoScrollToNewMessage){
                if(renderFromBeginning){
                    hasNewUnreadMessage = true;
                } else if(wasAtBottom || settingsStore.state.alwaysScrollToNewMessage){
                    const element = chatBody.firstElementChild;
                    if(element){
                        setTimeout(() => {
                            element.scrollIntoView({ behavior: 'instant', block: 'start' });
                        }, 700);
                    }
                } else {
                    hasNewUnreadMessage = true;
                }
            }
        }
        previousLength = messages.length;
        previousChatRoomId = currentChatRoomId;
    })

</script>

<div class="flex flex-col-reverse" bind:this={chatBody}></div>
