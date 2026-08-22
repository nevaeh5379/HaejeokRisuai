<script lang="ts">

    import Suggestion from './Suggestion.svelte';
    import { CameraIcon, DatabaseIcon, DicesIcon, GlobeIcon, ImagePlusIcon, LanguagesIcon, Laugh, MenuIcon, MicOffIcon, PackageIcon, Plus, RefreshCcwIcon, ReplyIcon, Send, StepForwardIcon, XIcon, BrainIcon, ArrowDown, SparkleIcon } from "@lucide/svelte";
    import { selectedCharID, PlaygroundStore, createSimpleCharacter, hypaV3ModalOpen, ScrollToMessageStore, additionalChatMenu, additionalFloatingActionButtons, easyPanelStore, chatPanelStore, startupPhase } from "../../ts/stores.svelte";
    import { tick } from 'svelte';
    import Chat from "./Chat.svelte";
    import { type Message } from "../../ts/storage/database.svelte";
    import { characterStore, settingsStore, personaStore, messageStore, presetStore } from 'src/ts/stores/domain';
    import { getCharImage } from "../../ts/characters";
    import { chatProcessStage, doingChat, sendChat } from "../../ts/process/index.svelte";
    import { sleep } from "../../ts/util";
    import { language } from "../../lang";
    import { isExpTranslator, translate } from "../../ts/translator/translator";
    import { alertError, alertNormal, alertWait, showHypaV2Alert } from "../../ts/alert";
    import sendSound from '../../etc/send.mp3'
    import { processScript } from "src/ts/process/scripts";
    import CreatorQuote from "./CreatorQuote.svelte";
    import { stopTTS } from "src/ts/process/tts";
    import MainMenu from '../UI/MainMenu.svelte';
    import AssetInput from './AssetInput.svelte';
    import { aiLawApplies, chatFoldedState, chatFoldedStateMessageIndex, downloadFile } from 'src/ts/globalApi.svelte';
    import { runTrigger } from 'src/ts/process/triggers';
    import { v4 } from 'uuid';
    import { PreUnreroll, Prereroll } from 'src/ts/process/prereroll';
    import { processMultiCommand } from 'src/ts/process/command';
    import { postChatFile } from 'src/ts/process/files/multisend';
    import { getInlayAsset } from 'src/ts/process/files/inlays';
    import { ConnectionOpenStore } from 'src/ts/sync/multiuserState';
    import { coldStorageHeader, preLoadChat } from 'src/ts/process/coldstorage.svelte';
    import Chats from './Chats.svelte';
    import Button from '../UI/GUI/Button.svelte';
    import PluginDefinedIcon from '../Others/PluginDefinedIcon.svelte';
    import { getAdditionalChatLoadPages, getInitialChatLoadPages } from 'src/ts/chatLoadPages';
    import { getMimeType } from 'src/ts/media';
    import { compactChatMessages } from 'src/ts/stores/domain/messageStore.svelte';

    const loadPlaygroundMenu = () => import('../Playground/PlaygroundMenu.svelte').then(m => m.default);
    
    interface Props {
        openModuleList?: boolean;
        openChatList?: boolean;
        customStyle?: string;
    }

    let messageInput:string = $state('')
    let messageInputTranslate:string = $state('')
    let openMenu = $state(false)
    let loadPages = $state(getInitialChatLoadPages(settingsStore.state))
    let autoMode = $state(false)
    let rerolls:Message[][] = []
    let rerollid = -1
    let lastCharId = -1
    let lastChatPage = -1
    let doingChatInputTranslate = false
    let toggleStickers:boolean = $state(false)
    let fileInput:string[] = $state([])
    let showNewMessageButton = $state(false)
    let chatsInstance: any = $state()
    let isScrollingToMessage = $state(false)
    let loadingOlderMessages = $state(false)
    let { openModuleList = $bindable(false), openChatList = $bindable(false), customStyle = '' }: Props = $props();
    let currentCharacter = $derived(characterStore.characters[$selectedCharID])
    let currentChat = $derived(currentCharacter?.chats[currentCharacter.chatPage]?.message ?? [])

    function scrollToBottom() {
        chatsInstance?.scrollToLatestMessage();
    }

    async function loadOlderMessages() {
        if (loadingOlderMessages) return
        const chat = currentCharacter?.chats?.[currentCharacter.chatPage]
        if (!chat?.id || !chat.messageOffset) return

        loadingOlderMessages = true
        try {
            const added = await characterStore.loadOlderChatMessages(
                chat.id,
                Math.max(getAdditionalChatLoadPages(settingsStore.state), 24),
            )
            if (added > 0) loadPages += getAdditionalChatLoadPages(settingsStore.state)
        } finally {
            loadingOlderMessages = false
        }
    }
    $effect(() => {
        if(ScrollToMessageStore.value !== -1){
            const index = ScrollToMessageStore.value
            ScrollToMessageStore.value = -1
            scrollToMessage(index)
        }
    })

    async function scrollToMessage(index: number){
        // Forces the loading of past messages not rendered on the screen
        isScrollingToMessage = true
        try {
            const totalMessages = currentChat.length
            const neededLoadPages = totalMessages - index + 5

            if(loadPages < neededLoadPages){
                loadPages = neededLoadPages
                await tick()
            }

            let element: Element | null = null;
            // Poll for element existence (max 5 seconds)
            for(let i = 0; i < 50; i++){
                element = document.querySelector(`[data-chat-index="${index}"]`)
                if(element) break;
                await sleep(100)
            }

            const preIndex = Math.max(0, index - 3)
            const preElement = document.querySelector(`[data-chat-index="${preIndex}"]`)
            if(preElement){
                preElement.scrollIntoView({behavior: "instant", block: "start"})
            } else {
                element?.scrollIntoView({behavior: "instant", block: "start"})
            }
            await sleep(50)

            if(element){
                // Wait for images to load to prevent layout shift
                const chatContainer = document.querySelector('.default-chat-screen');
                if(chatContainer) {
                    const images = Array.from(chatContainer.querySelectorAll('img'));
                    const promises = images.map(img => {
                        if (img.complete) return Promise.resolve();
                        return new Promise(resolve => {
                            img.onload = () => resolve(null);
                            img.onerror = () => resolve(null);
                        });
                    });
                    // Wait for all images or timeout after 4 seconds
                    await Promise.race([
                        Promise.all(promises),
                        sleep(4000)
                    ]);
                }

                element.scrollIntoView({behavior: "instant", block: "start"})
                
                // Small delay and scroll again to ensure position is correct after any final layout adjustments
                await sleep(50)
                element.scrollIntoView({behavior: "instant", block: "start"})

                element.classList.add('ring-2', 'ring-blue-500')
                setTimeout(() => {
                    element.classList.remove('ring-2', 'ring-blue-500')
                }, 2000)
            }
        } finally {
            isScrollingToMessage = false
        }
    }

    function getCurrentTurnUserIndex(messages: Message[]): number {
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === 'user') {
                return i
            }
        }
        return -1
    }

    async function send(){
        return sendMain(false)
    }
    async function sendContinue(){
        return sendMain(true)
    }

    async function sendMain(continueResponse:boolean) {
        let selectedChar = $selectedCharID
        if($doingChat){
            return
        }
        const currentChatPage = characterStore.characters[selectedChar]?.chatPage ?? 0
        await preLoadChat(selectedChar, currentChatPage, { full: true })
        if(lastCharId !== selectedChar || lastChatPage !== currentChatPage){
            rerolls = []
            rerollid = -1
        }

        const activeChat = characterStore.characters[selectedChar].chats[currentChatPage]
        let cha = activeChat.message

        if(messageInput.startsWith('/')){
            const commandProcessed = await processMultiCommand(messageInput)
            if(commandProcessed !== false){
                messageInput = ''
                if (activeChat.id) void compactChatMessages(activeChat.id)
                return
            }
        }

        if(fileInput.length > 0){
            for(const file of fileInput){
                messageInput += `{{inlayed::${file}}}`
            }
            fileInput = []
        }

        if(messageInput === ''){
            if(characterStore.characters[selectedChar].type !== 'group'){
                if(cha.length === 0 || cha[cha.length - 1].role !== 'user'){
                    if(settingsStore.state.useSayNothing){
                        cha.push({
                            role: 'user',
                            data: '*says nothing*',
                            name: $ConnectionOpenStore ? settingsStore.state.username : null
                        })
                    }
                }
            }
        }
        else{
            const char = characterStore.characters[selectedChar]
            if(char.type === 'character'){
                let triggerResult = await runTrigger(char,'input', {chat: char.chats[char.chatPage]})
                if(triggerResult){
                    cha = triggerResult.chat.message
                }

                cha.push({
                    role: 'user',
                    data: await processScript(char,messageInput,'editinput'),
                    time: Date.now(),
                    name: $ConnectionOpenStore ? settingsStore.state.username : null
                })
            }
            else{
                cha.push({
                    role: 'user',
                    data: messageInput,
                    time: Date.now(),
                    name: $ConnectionOpenStore ? settingsStore.state.username : null
                })
            }
        }
        messageInput = ''
        messageInputTranslate = ''
        characterStore.characters[selectedChar].chats[currentChatPage].message = cha
        rerolls = []
        await sleep(10)
        updateInputSizeAll()
        await sendChatMain(continueResponse)

    }

    async function reroll() {
        const selectedChar = $selectedCharID
        const currentChatPage = characterStore.characters[selectedChar]?.chatPage ?? 0
        await preLoadChat(selectedChar, currentChatPage, { full: true })
        if($doingChat){
            return
        }
        if(lastCharId !== selectedChar || lastChatPage !== currentChatPage){
            rerolls = []
            rerollid = -1
        }
        const activeChat = characterStore.characters[selectedChar]?.chats?.[currentChatPage]
        if(!activeChat){
            return
        }
        const msgs = activeChat.message
        const genId = msgs.at(-1)?.generationInfo?.generationId
        if(genId){
            const r = Prereroll(genId)
            if(r){
                msgs[msgs.length - 1].data = r
                return
            }
        }
        const lastUserIdx = getCurrentTurnUserIndex(msgs)
        if(rerollid < rerolls.length - 1){
            if(Array.isArray(rerolls[rerollid + 1])){
                rerollid += 1
                const rerollData = safeStructuredClone(rerolls[rerollid])
                activeChat.message = [...msgs.slice(0, lastUserIdx + 1), ...rerollData]
            }
            return
        }
        if(rerolls.length === 0){
            rerolls.push(safeStructuredClone(msgs.slice(lastUserIdx + 1)))
            rerollid = rerolls.length - 1
        }
        if(msgs.length === 0){
            return
        }
        openMenu = false
        activeChat.message = msgs.slice(0, lastUserIdx + 1)
        await sendChatMain()
    }

    async function unReroll() {
        const selectedChar = $selectedCharID
        const currentChatPage = characterStore.characters[selectedChar]?.chatPage ?? 0
        await preLoadChat(selectedChar, currentChatPage, { full: true })
        if($doingChat){
            return
        }
        if(lastCharId !== selectedChar || lastChatPage !== currentChatPage){
            rerolls = []
            rerollid = -1
        }
        const activeChat = characterStore.characters[selectedChar]?.chats?.[currentChatPage]
        if(!activeChat){
            return
        }
        const msgs = activeChat.message
        const genId = msgs.at(-1)?.generationInfo?.generationId
        if(genId){
            const r = PreUnreroll(genId)
            if(r){
                msgs[msgs.length - 1].data = r
                return
            }
        }
        if(rerollid <= 0){
            return
        }
        if(Array.isArray(rerolls[rerollid - 1])){
            rerollid -= 1
            const rerollData = safeStructuredClone(rerolls[rerollid])
            const lastUserIdx = getCurrentTurnUserIndex(msgs)
            activeChat.message = [...msgs.slice(0, lastUserIdx + 1), ...rerollData]
        }
    }

    let abortController:null|AbortController = null

    async function sendChatMain(continued:boolean = false) {

        const targetChat = characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage]
        targetChat.preventMessageCompaction = true
        let previousLength = targetChat.message.length
        messageInput = ''
        abortController = new AbortController()
        try {
            await sendChat(-1, {
                signal:abortController.signal,
                continue:continued
            })
            if(previousLength < characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message.length){
                rerolls.push(safeStructuredClone(characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message).slice(previousLength))
                rerollid = rerolls.length - 1
            }
        } catch (error) {
            console.error(error)
            alertError(error)
        } finally {
            targetChat.preventMessageCompaction = false
        }
        lastCharId = $selectedCharID
        lastChatPage = characterStore.characters[$selectedCharID]?.chatPage ?? 0
        $doingChat = false
        if (targetChat.id) compactChatMessages(targetChat.id)
        if(settingsStore.state.playMessage){
            const audio = new Audio(sendSound);
            audio.play().catch(() => {});
        }
    }

    function abortChat(){
        if(abortController){
            abortController.abort()
        }
    }

    async function runAutoMode() {
        if(autoMode){
            autoMode = false
            return
        }
        const selectedChar = $selectedCharID
        autoMode = true
        while(autoMode){
            await sendChatMain()
            if(selectedChar !== $selectedCharID){
                autoMode = false
            }
        }
    }

    let { userIconPortrait, currentUsername, userIcon } = $derived.by(() => {
        const bindedPersona = characterStore.characters?.[$selectedCharID]?.chats?.[characterStore.characters?.[$selectedCharID]?.chatPage]?.bindedPersona

        if(bindedPersona && (personaStore.list ?? settingsStore.state?.personas)){
            const persona = (personaStore.list ?? settingsStore.state?.personas)?.find((p: any) => p.id === bindedPersona)
            if(persona){
                return {
                    currentUsername: persona.name,
                    userIconPortrait: persona.largePortrait ?? false,
                    userIcon: persona.icon
                }
            }
        }

        const selectedPersonaIndex = personaStore.activeIndex ?? settingsStore.state?.selectedPersona ?? 0
        const selectedPersona = (personaStore.list ?? settingsStore.state?.personas)?.[selectedPersonaIndex]
        return {
            currentUsername: selectedPersona?.name ?? settingsStore.state?.username ?? '',
            userIconPortrait: selectedPersona?.largePortrait ?? false,
            userIcon: selectedPersona?.icon ?? settingsStore.state?.userIcon ?? ''
        }
    })

    let inputHeight = $state("44px")
    let inputEle:HTMLTextAreaElement = $state()
    let inputTranslateHeight = $state("44px")
    let inputTranslateEle:HTMLTextAreaElement = $state()

    function updateInputSizeAll() {
        updateInputSize()
        updateInputTranslateSize()
    }

    function updateInputTranslateSize() {
        if(inputTranslateEle) {
            inputTranslateEle.style.height = "0";
            inputTranslateHeight = (inputTranslateEle.scrollHeight) + "px";
            inputTranslateEle.style.height = inputTranslateHeight
        }
    }
    function updateInputSize() {
        if(inputEle){
            inputEle.style.height = "0";
            inputHeight = (inputEle.scrollHeight) + "px";
            inputEle.style.height = inputHeight
        }
    }

    $effect.pre(() => {
        updateInputSizeAll()
    });

    async function updateInputTransateMessage(reverse: boolean) {
        if(!settingsStore.state.useAutoTranslateInput){
            return
        }
        if(isExpTranslator()){
            if(!reverse){
                messageInputTranslate = ''
                return
            }
            if(messageInputTranslate === '') {
                messageInput = ''
                return
            }
            const lastMessageInputTranslate = messageInputTranslate
            await sleep(1500)
            if(lastMessageInputTranslate === messageInputTranslate){
                translate(reverse ? messageInputTranslate : messageInput, reverse).then((translatedMessage) => {
                    if(translatedMessage){
                        if(reverse)
                            messageInput = translatedMessage
                        else
                            messageInputTranslate = translatedMessage
                    }
                })
            }
            return

        }
        if(reverse && messageInputTranslate === '') {
            messageInput = ''
            return
        }
        if(!reverse && messageInput === '') {
            messageInputTranslate = ''
            return
        }
        translate(reverse ? messageInputTranslate : messageInput, reverse).then((translatedMessage) => {
            if(translatedMessage){
                if(reverse)
                    messageInput = translatedMessage
                else
                    messageInputTranslate = translatedMessage
            }
        })
    }

    async function screenShot(){
        try {
            loadPages = Infinity
            const html2canvas = await import('html-to-image');
            const chats = document.querySelectorAll('.default-chat-screen .risu-chat')
            alertWait("Taking screenShot...")
            let canvases:HTMLCanvasElement[] = []

            for(const chat of chats){
                const cnv = await html2canvas.toCanvas(chat as HTMLElement)
                alertWait("Taking screenShot... "+canvases.length+"/"+chats.length)
                canvases.push(cnv)
            }

            canvases.reverse()

            alertWait("Merging images...")

            let mergedCanvas = document.createElement('canvas');
            mergedCanvas.width = 0;
            mergedCanvas.height = 0;
            let mergedCtx = mergedCanvas.getContext('2d');

            let totalHeight = 0;
            let maxWidth = 0;
            for(let i = 0; i < canvases.length; i++) {
                let canvas = canvases[i];
                totalHeight += canvas.height;
                maxWidth = Math.max(maxWidth, canvas.width);

                mergedCanvas.width = maxWidth;
                mergedCanvas.height = totalHeight;
            }

            mergedCtx.fillStyle = 'var(--risu-theme-bgcolor)'
            mergedCtx.fillRect(0, 0, maxWidth, totalHeight);
            let indh = 0
            for(let i = 0; i < canvases.length; i++) {
                let canvas = canvases[i];
                indh += canvas.height
                mergedCtx.drawImage(canvas, 0, indh - canvas.height);
                canvases[i].remove();
            }

            if(mergedCanvas){
                await downloadFile(`chat-${v4()}.png`, Buffer.from(mergedCanvas.toDataURL('png').split(',').at(-1), 'base64'))
                mergedCanvas.remove();
            }
            alertNormal(language.screenshotSaved)
            loadPages = getInitialChatLoadPages(settingsStore.state)
        } catch (error) {
            console.error(error)
            alertError("Error while taking screenshot")
        }
    }

    
</script>



<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="w-full h-full relative" style={customStyle} onclick={() => {
    openMenu = false
}}>
    
    {#if showNewMessageButton}
        {#if (settingsStore.state.newMessageButtonStyle === 'bottom-center' || !settingsStore.state.newMessageButtonStyle)}
            <button class="absolute bottom-16 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors" onclick={scrollToBottom}>
                <ArrowDown size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if settingsStore.state.newMessageButtonStyle === 'bottom-right'}
            <button class="absolute bottom-20 right-4 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors" onclick={scrollToBottom}>
                <ArrowDown size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if settingsStore.state.newMessageButtonStyle === 'bottom-left'}
            <button class="absolute bottom-20 left-4 bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors" onclick={scrollToBottom}>
                <ArrowDown size={16} />
                <span>{language.newMessage}</span>
            </button>
        {/if}

        {#if settingsStore.state.newMessageButtonStyle === 'floating-circle'}
            <button class="absolute bottom-36 right-4 bg-blue-500 text-white w-12 h-12 rounded-full shadow-lg z-50 flex items-center justify-center hover:bg-blue-600 transition-colors" onclick={scrollToBottom} title="4. 원형 (우하단)">
                <ArrowDown size={20} />
            </button>
        {/if}

        {#if settingsStore.state.newMessageButtonStyle === 'right-center'}
            <button class="absolute top-1/2 right-2 -translate-y-1/2 bg-blue-500 text-white px-2 py-3 rounded-l-lg shadow-lg z-50 flex flex-col items-center gap-1 hover:bg-blue-600 transition-colors" onclick={scrollToBottom}>
                <ArrowDown size={14} />
                <span class="text-xs writing-mode-vertical">{language.newMessage}</span>
            </button>
        {/if}

        {#if settingsStore.state.newMessageButtonStyle === 'top-bar'}
            <button class="absolute top-2 left-1/2 -translate-x-1/2 bg-blue-500 text-white px-6 py-1.5 rounded-full shadow-lg z-50 flex items-center gap-2 hover:bg-blue-600 transition-colors text-sm" onclick={scrollToBottom}>
                <ArrowDown size={14} />
                <span>{language.newMessage}</span>
            </button>
        {/if}
    {/if}
    {#if isScrollingToMessage}
        <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/50 text-white text-xl font-bold backdrop-blur-sm">
            Loading...
        </div>
    {/if}
    {#if $selectedCharID < 0}
        {#if $PlaygroundStore === 0}
            <MainMenu />
        {:else}
            {#await loadPlaygroundMenu() then PlaygroundMenu}
                <PlaygroundMenu />
            {/await}
        {/if}
    {:else}
        <div class="h-full w-full flex flex-col-reverse overflow-y-auto relative default-chat-screen" onscroll={async (e) => {
            //@ts-expect-error scrollHeight/clientHeight/scrollTop don't exist on EventTarget, but target is HTMLElement here
            const scrolled = (e.target.scrollHeight - e.target.clientHeight + e.target.scrollTop)
            if(scrolled < 100){
                const chat = characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage]
                if(chat.message.length > loadPages){
                    loadPages += getAdditionalChatLoadPages(settingsStore.state)
                } else if ((chat.messageOffset ?? 0) > 0) {
                    await loadOlderMessages()
                }
            }
            const chatTarget = e.target as HTMLElement;
            const chatsContainer = (settingsStore.state.fixedChatTextarea && chatTarget.children[1]) ? chatTarget.children[1] : chatTarget.children[0];
            const lastEl = chatsContainer?.firstElementChild;
            const isAtBottom = lastEl ? lastEl.getBoundingClientRect().top <= chatTarget.getBoundingClientRect().bottom + 100 : true;
            if(isAtBottom){
                showNewMessageButton = false;
            }
        }}>
            <div
                    class="{settingsStore.state.fixedChatTextarea ? 'sticky pt-2 pb-2 right-0 bottom-0 bg-bgcolor' : 'mt-2 mb-2'} flex items-stretch w-full"
                    style="{settingsStore.state.fixedChatTextarea ? 'z-index:29;' : ''}"
            >
                {#if settingsStore.state.useChatSticker && currentCharacter.type !== 'group'}
                    <div onclick={()=>{toggleStickers = !toggleStickers}}
                         class={"ml-4 bg-textcolor2 flex justify-center items-center  w-12 h-12 rounded-md hover:bg-blue-500 transition-colors "+(toggleStickers ? 'text-green-500':'text-textcolor')}>
                        <Laugh/>
                    </div>
                {/if}

                <textarea class="peer text-input-area focus:border-textcolor transition-colors outline-hidden text-textcolor p-2 min-w-0 border border-r-0 bg-transparent rounded-md rounded-r-none input-text text-xl grow ml-4 border-darkborderc resize-none overflow-y-hidden overflow-x-hidden max-w-full placeholder:text-sm"
                          bind:value={messageInput}
                          bind:this={inputEle}
                          onkeydown={(e) => {
                        if(e.key.toLocaleLowerCase() === "enter" && !e.isComposing){
                            if(settingsStore.state.sendWithEnter && (!e.shiftKey)){
                                send()
                                e.preventDefault()
                            }else if(!settingsStore.state.sendWithEnter && e.shiftKey){
                                send()
                                e.preventDefault()
                            }
                        }
                        if(e.key.toLocaleLowerCase() === "m" && (e.ctrlKey)){
                            reroll()
                            e.preventDefault()
                        }
                    }}
                          onpaste={(e) => {
                        const items = e.clipboardData?.items
                        if(!items){
                            return
                        }
                        let canceled = false

                        for(const item of items){
                            if(item.kind === 'file' && item.type.startsWith('image')){
                                if(!canceled){
                                    e.preventDefault()
                                    canceled = true
                                }
                                const file = item.getAsFile()
                                if(file){
                                    const reader = new FileReader()
                                    reader.onload = async (e) => {
                                        const buf = e.target?.result as ArrayBuffer
                                        const uint8 = new Uint8Array(buf)
                                        const results = await postChatFile({
                                            name: file.name,
                                            data: uint8
                                        })
                                        if(!results) return
                                        for(const res of results){
                                            if(res?.type === 'asset'){
                                                fileInput.push(res.data)
                                            }
                                            if(res?.type === 'text'){
                                                messageInput += `{{file::${res.name}::${res.data}}}`
                                            }
                                        }
                                        updateInputSizeAll()
                                    }
                                    reader.readAsArrayBuffer(file)
                                }
                            }
                        }
                    }}
                          oninput={()=>{updateInputSizeAll();updateInputTransateMessage(false)}}
                          style:height={inputHeight}
                ></textarea>


                {#if $doingChat || doingChatInputTranslate}
                    <button
                            aria-labelledby="cancel"
                            class="peer-focus:border-textcolor  flex justify-center border-y border-darkborderc items-center text-textcolor p-3 hover:bg-blue-500 hover:text-white transition-colors" onclick={abortChat}
                            style:height={inputHeight}
                    >
                        <div class="loadmove chat-process-stage-{$chatProcessStage}" class:autoload={autoMode}></div>
                    </button>
                {:else if $startupPhase !== 'chat-ready'}
                    <button
                        onclick={async () => {
                            if (presetStore.activeStatus === 'error') {
                                await presetStore.retryActive()
                                if (presetStore.activePreset) $startupPhase = 'chat-ready'
                            }
                        }}
                        disabled={presetStore.activeStatus !== 'error'}
                        title={presetStore.error ?? 'Chat runtime is loading'}
                        class="flex justify-center border-y border-darkborderc items-center text-textcolor2 px-3 text-xs"
                        style:height={inputHeight}
                    >
                        {presetStore.activeStatus === 'error' ? 'Retry' : 'Loading…'}
                    </button>
                {:else}
                    <button
                            onclick={send}
                            class="flex justify-center border-y border-darkborderc items-center text-textcolor p-3 peer-focus:border-textcolor hover:bg-blue-500 hover:text-white transition-colors button-icon-send"
                            style:height={inputHeight}
                    >
                        <Send />
                    </button>
                {/if}
                {#if characterStore.characters[$selectedCharID]?.chaId !== '§playground'}
                    <button
                            onclick={(e) => {
                            openMenu = !openMenu
                            e.stopPropagation()
                        }}
                            class="peer-focus:border-textcolor mr-2 flex border-y border-r border-darkborderc justify-center items-center text-textcolor p-3 rounded-r-md hover:bg-blue-500 hover:text-white transition-colors"
                            style:height={inputHeight}
                    >
                        <MenuIcon />
                    </button>
                {:else}
                    <div onclick={(e) => {
                        const currentChat = characterStore.characters[$selectedCharID]?.chats?.[characterStore.characters[$selectedCharID]?.chatPage]
                        if (currentChat?.id) {
                            void messageStore.appendMessage(currentChat.id, {
                                role: 'char',
                                data: '',
                                chatId: v4()
                            })
                        }
                    }}
                         class="peer-focus:border-textcolor mr-2 flex border-y border-r border-darkborderc justify-center items-center text-textcolor p-3 rounded-r-md hover:bg-blue-500 hover:text-white transition-colors"
                         style:height={inputHeight}
                    >
                        <Plus />
                    </div>
                {/if}
            </div>
            {#if settingsStore.state.useAutoTranslateInput && characterStore.characters[$selectedCharID]?.chaId !== '§playground'}
                <div class="flex items-center mt-2 mb-2">
                    <label for='messageInputTranslate' class="text-textcolor ml-4">
                        <LanguagesIcon />
                    </label>
                    <textarea id = 'messageInputTranslate' class="text-textcolor rounded-md p-2 min-w-0 bg-transparent input-text text-xl grow ml-4 mr-2 border-darkbutton resize-none focus:bg-selected overflow-y-hidden overflow-x-hidden max-w-full"
                              bind:value={messageInputTranslate}
                              bind:this={inputTranslateEle}
                              onkeydown={(e) => {
                            if(e.key.toLocaleLowerCase() === "enter" && (!e.shiftKey)){
                                if(settingsStore.state.sendWithEnter){
                                    send()
                                    e.preventDefault()
                                }
                            }
                            if(e.key.toLocaleLowerCase() === "m" && (e.ctrlKey)){
                                reroll()
                                e.preventDefault()
                            }
                        }}
                              oninput={()=>{updateInputSizeAll();updateInputTransateMessage(true)}}
                              placeholder={language.enterMessageForTranslateToEnglish}
                              style:height={inputTranslateHeight}
                    ></textarea>
                </div>
            {/if}

            {#if fileInput.length > 0}
                <div class="flex items-center ml-4 flex-wrap p-2 m-2 border-darkborderc border rounded-md">
                    {#each fileInput as file, i}
                        {#await getInlayAsset(file) then inlayAsset}
                            <div class="relative">
                                {#if inlayAsset.type === 'image'}
                                    <img src={inlayAsset.data} alt="Inlay" class="max-w-48 max-h-48 border border-darkborderc">
                                {:else if inlayAsset.type === 'video'}
                                    <video controls class="max-w-48 max-h-48 border border-darkborderc">
                                        <source src={inlayAsset.data} type={inlayAsset.name ? getMimeType(inlayAsset.name) : 'video/mp4'} />
                                        <track kind="captions" />
                                        Your browser does not support the video tag.
                                    </video>
                                {:else if inlayAsset.type === 'audio'}
                                    <audio controls class="max-w-48 max-h-24 border border-darkborderc">
                                        <source src={inlayAsset.data} type={inlayAsset.name ? getMimeType(inlayAsset.name) : 'audio/mpeg'} />
                                        Your browser does not support the audio tag.
                                    </audio>
                                {:else}
                                    <div class="max-w-24 max-h-24">{file}</div>
                                {/if}
                                <button class="absolute -right-1 -top-1 p-1 bg-darkbg text-textcolor rounded-md transition-colors hover:text-draculared focus:text-draculared" onclick={() => {
                                    fileInput.splice(i, 1)
                                    updateInputSizeAll()
                                }}>
                                    <XIcon size={18} />
                                </button>
                            </div>
                        {/await}
                    {/each}
                </div>

            {/if}

            {#if toggleStickers}
                <div class="ml-4 flex flex-wrap">
                    <AssetInput currentCharacter={currentCharacter} onSelect={(additionalAsset)=>{
                        let fileType = 'img'
                        if(additionalAsset.length > 2 && additionalAsset[2]) {
                            const fileExtension = additionalAsset[2]
                            if(fileExtension === 'mp4' || fileExtension === 'webm')
                                fileType = 'video'
                            else if(fileExtension === 'mp3' || fileExtension === 'wav')
                                fileType = 'audio'
                        }
                        messageInput += `<span class='notranslate' translate='no'>{{${fileType}::${additionalAsset[0]}}}</span> *${additionalAsset[0]} added*`
                        updateInputSizeAll()
                    }}/>
                </div>
            {/if}

            {#if settingsStore.state.useAutoSuggestions}
                <Suggestion messageInput={(msg)=>messageInput=(
                    (settingsStore.state.subModel === "textgen_webui" || settingsStore.state.subModel === "mancer" || settingsStore.state.subModel.startsWith('local_')) && settingsStore.state.autoSuggestClean
                    ? msg.replace(/ +\(.+?\) *$| - [^"'*]*?$/, '')
                    : msg
                )} {send}/>
            {/if}

            {#if chatPanelStore.length > 0}
                <div class="mx-4 my-2 flex flex-col gap-2">
                    {#each chatPanelStore as panel (panel.id)}
                        <section class={`rounded-md border border-darkborderc bg-darkbg/80 p-3 text-textcolor ${panel.className ?? ''}`} data-plugin-chat-panel={panel.id}>
                            {@html panel.html}
                        </section>
                    {/each}
                </div>
            {/if}

            {#if characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message?.[0]?.data?.startsWith(coldStorageHeader) || characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].messagesLoaded === false || characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].detailsLoaded === false }
                {#await preLoadChat($selectedCharID, characterStore.characters[$selectedCharID].chatPage)}
                    <div class="w-full flex justify-center text-textcolor2 italic mb-12">
                        {language.loadingChatData}
                    </div>
                {:then a}
                    <div></div>
                {/await}
            {:else}

            {#if chatFoldedStateMessageIndex.index !== -1}
                <button class="w-full flex justify-center max-w-full p-4">
                    <Button className="max-w-xl w-full" onclick={() => {
                        loadPages += chatFoldedStateMessageIndex.index + 1
                        chatFoldedState.data = null
                    }}>
                        {language.loadMore}
                    </Button>
                </button>
            {/if}
            
            <Chats
                bind:this={chatsInstance}
                messages={currentChat}
                loadPages={loadPages}
                onReroll={reroll}
                unReroll={unReroll}
                currentCharacter={currentCharacter}
                currentUsername={currentUsername}
                userIcon={userIcon}
                userIconPortrait={userIconPortrait}
                bind:hasNewUnreadMessage={showNewMessageButton}
            />

            {#if characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message.length <= loadPages &&
                (characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].messageOffset ?? 0) === 0}
                {#if characterStore.characters[$selectedCharID].type !== 'group' }
                    <Chat
                        character={createSimpleCharacter(characterStore.characters[$selectedCharID])}
                        name={characterStore.characters[$selectedCharID].name}
                        message={characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].fmIndex === -1 ? characterStore.characters[$selectedCharID].firstMessage :
                            characterStore.characters[$selectedCharID].alternateGreetings[characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].fmIndex]}
                        role='char'
                        img={getCharImage(characterStore.characters[$selectedCharID].image, 'css')}
                        idx={-1}
                        altGreeting={characterStore.characters[$selectedCharID].alternateGreetings.length > 0}
                        largePortrait={characterStore.characters[$selectedCharID].largePortrait}
                        firstMessage={true}
                        onReroll={() => {
                            const cha = characterStore.characters[$selectedCharID]
                            const chat = characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage]
                            if(cha.type !== 'group'){
                                if (chat.fmIndex >= (cha.alternateGreetings.length - 1)){
                                    chat.fmIndex = -1
                                }
                                else{
                                    chat.fmIndex += 1
                                }
                            }
                            characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage] = chat
                        }}
                        unReroll={() => {
                            const cha = characterStore.characters[$selectedCharID]
                            const chat = characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage]
                            if(cha.type !== 'group'){
                                if (chat.fmIndex === -1){
                                    chat.fmIndex = (cha.alternateGreetings.length - 1)
                                }
                                else{
                                    chat.fmIndex -= 1
                                }
                            }
                            characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage] = chat
                        }}
                        isLastMemory={false}
                        currentPage={(characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].fmIndex ?? -1) + 2}
                        totalPages={characterStore.characters[$selectedCharID].alternateGreetings.length + 1}

                    />
                    {#if (aiLawApplies() && characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message.length === 0)}
                        <div class="ml-auto mr-auto mt-4 text-textcolor2 italic max-w-2/3 wrap-break-word text-center">
                            {language.aiGenerationWarning}
                        </div>
                    {/if}
                    {#if !characterStore.characters[$selectedCharID].removedQuotes && characterStore.characters[$selectedCharID].creatorNotes.length >= 2}
                        <CreatorQuote quote={characterStore.characters[$selectedCharID].creatorNotes} onRemove={() => {
                            const cha = characterStore.characters[$selectedCharID]
                            if(cha.type !== 'group'){
                                cha.removedQuotes = true
                            }
                            characterStore.characters[$selectedCharID] = cha
                        }} />
                    {/if}
                {/if}
            {/if}

            {/if}

            {#if openMenu}
                <div class="{settingsStore.state.fixedChatTextarea ? 'fixed' : 'absolute'} right-2 bottom-16 p-5 bg-darkbg flex flex-col gap-3 text-textcolor rounded-md" onclick={(e) => {
                    e.stopPropagation()
                }}>
                    {#if characterStore.characters[$selectedCharID].type === 'group'}
                        <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={runAutoMode}>
                            <DicesIcon />
                            <span class="ml-2">{language.autoMode}</span>
                        </div>
                    {/if}

                    
                    <!-- svelte-ignore block_empty -->
                    {#if characterStore.characters[$selectedCharID].ttsMode === 'webspeech' || characterStore.characters[$selectedCharID].ttsMode === 'elevenlab'}
                        <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={() => {
                            stopTTS()
                        }}>
                            <MicOffIcon />
                            <span class="ml-2">{language.ttsStop}</span>
                        </div>
                    {/if}

                    <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors"
                        class:text-textcolor2={(characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message.length < 2) || (characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message[characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message.length - 1].role !== 'char')}
                        onclick={() => {
                            if((characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message.length < 2) || (characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message[characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].message.length - 1].role !== 'char')){
                                return
                            }
                            sendContinue();
                        }}
                    >
                        <StepForwardIcon />
                        <span class="ml-2">{language.continueResponse}</span>
                    </div>


                    {#if settingsStore.state.showMenuChatList}
                        <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={() => {
                            openChatList = true
                            openMenu = false
                        }}>
                            <DatabaseIcon />
                            <span class="ml-2">{language.chatList}</span>
                        </div>
                    {/if}

                    
                    {#if settingsStore.state.enableRisuaiProTools}
                        <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={() => {
                            easyPanelStore.open = !easyPanelStore.open
                        }}>
                            <SparkleIcon />
                            <span class="ml-2">{language.easyPanel}</span>
                        </div>
                    {/if}

                    {#each additionalChatMenu as menu}
                        <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={() => {
                            menu.callback()
                            openMenu = false
                        }}>
                            <PluginDefinedIcon ico={menu} />
                            <span class="ml-2">{menu.name}</span>
                        </div>
                    {/each}

                    {#if settingsStore.state.showMenuHypaMemoryModal}
                        {#if (settingsStore.state.supaModelType !== 'none' && settingsStore.state.hypav2) || settingsStore.state.hypaV3}
                            <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={() => {
                                if (settingsStore.state.hypav2) {
                                    characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].hypaV2Data ??= {
                                        lastMainChunkID: 0,
                                        mainChunks: [],
                                        chunks: [],
                                    }
                                    showHypaV2Alert();
                                } else if (settingsStore.state.hypaV3) {
                                    $hypaV3ModalOpen = true
                                }

                                openMenu = false
                            }}>
                                <BrainIcon />
                                <span class="ml-2">
                                    {settingsStore.state.hypav2 ? language.hypaMemoryV2Modal : language.hypaMemoryV3Modal}
                                </span>
                            </div>
                        {/if}
                    {/if}
                    
                    {#if settingsStore.state.translator !== ''}
                        <div class={"flex items-center cursor-pointer "+ (settingsStore.state.useAutoTranslateInput ? 'text-green-500':'lg:hover:text-green-500')} onclick={() => {
                            settingsStore.state.useAutoTranslateInput = !settingsStore.state.useAutoTranslateInput
                        }}>
                            <GlobeIcon />
                            <span class="ml-2">{language.autoTranslateInput}</span>
                        </div>
                        
                    {/if}
            
                    <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={() => {
                        screenShot()
                    }}>
                        <CameraIcon />
                        <span class="ml-2">{language.screenshot}</span>
                    </div>

                    <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={async () => {
                        const results = await postChatFile(messageInput)
                        if(!results) return
                        for(const res of results){
                            if(res?.type === 'asset'){
                                fileInput.push(res.data)
                            }
                            if(res?.type === 'text'){
                                messageInput += `{{file::${res.name}::${res.data}}}`
                            }
                        }
                        updateInputSizeAll()
                    }}>

                        <ImagePlusIcon />
                        <span class="ml-2">{language.postFile}</span>
                    </div>


                    <div class={"flex items-center cursor-pointer "+ (settingsStore.state.useAutoSuggestions ? 'text-green-500':'lg:hover:text-green-500')} onclick={async () => {
                        settingsStore.state.useAutoSuggestions = !settingsStore.state.useAutoSuggestions
                    }}>
                        <ReplyIcon />
                        <span class="ml-2">{language.autoSuggest}</span>
                    </div>


                    <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={() => {
                        characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].modules ??= []
                        openModuleList = true
                        openMenu = false
                    }}>
                        <PackageIcon />
                        <span class="ml-2">{language.modules}</span>
                    </div>

                    {#if settingsStore.state.sideMenuRerollButton}
                        <div class="flex items-center cursor-pointer hover:text-green-500 transition-colors" onclick={reroll}>
                            <RefreshCcwIcon />
                            <span class="ml-2">{language.reroll}</span>
                        </div>
                    {/if}
                </div>

            {/if}
        </div>

    {/if}
</div>

{#if additionalFloatingActionButtons.length > 0}
    <div class="fixed top-4 right-4 flex flex-col gap-3 z-50">
        {#each additionalFloatingActionButtons as button}
            <button class="bg-blue-500 text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-2 hover:bg-blue-600 transition-colors" onclick={() => {
                button.callback()
            }}>
                <PluginDefinedIcon ico={button} />
            </button>
        {/each}
    </div>
{/if}
<style>

    .chat-process-stage-1{
        border-top: 0.4rem solid #60a5fa;
        border-left: 0.4rem solid #60a5fa;
    }

    .chat-process-stage-2{
        border-top: 0.4rem solid #db2777;
        border-left: 0.4rem solid #db2777;
    }

    .chat-process-stage-3{
        border-top: 0.4rem solid #34d399;
        border-left: 0.4rem solid #34d399;
    }

    .chat-process-stage-4{
        border-top: 0.4rem solid #8b5cf6;
        border-left: 0.4rem solid #8b5cf6;
    }

    .autoload{
        border-top: 0.4rem solid #10b981;
        border-left: 0.4rem solid #10b981;
    }

    @keyframes spin {
        
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
    }
</style>
