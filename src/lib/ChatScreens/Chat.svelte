<script lang="ts">
    import { ArrowLeft, ArrowLeftRightIcon, ArrowRight, BookmarkIcon, BotIcon, CopyIcon, DownloadIcon, FileText, PowerOff, GitBranch, HamburgerIcon, LanguagesIcon, MenuIcon, PencilIcon, RefreshCcwIcon, SplitIcon, TrashIcon, UserIcon, Volume2Icon, Scissors } from "@lucide/svelte"
    import { aiLawApplies, changeChatTo, foldChatToMessage, getFileSrc } from "src/ts/globalApi.svelte"
    import { chatTargetFromIndexes, requireChatTargetFromIndexes, type ChatExecutionTarget } from "src/ts/chatTarget"
    import { ColorSchemeTypeStore } from "src/ts/gui/colorscheme"
    import { longpress } from "src/ts/gui/longtouch"
    import { getModelInfo } from "src/ts/model/modellist"
    import { risuChatParser } from "src/ts/process/scripts"
    import { ReloadChatPointer, CurrentTriggerIdStore, popupStore } from 'src/ts/stores.svelte'
    import { characterStore, settingsStore, messageStore } from 'src/ts/stores/domain'
    import { ConnectionOpenStore } from 'src/ts/sync/multiuserState'
    import { capitalize, getUserIcon, getUserName, sleep } from "src/ts/util"
    import { onDestroy, onMount } from "svelte"
    import { type Unsubscriber } from "svelte/store"
    import { v4 as uuidv4, v4 } from 'uuid'
    import { language } from "../../lang"
    import { alertClear, alertConfirm, alertInput, alertNormal, alertRequestData, alertWait } from "../../ts/alert"
    import { ParseMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import type { Message, MessageGenerationInfo, StreamingDisplayOptimizationMode } from "../../ts/storage/database/schema";import { HideIconStore, ReloadGUIPointer } from "../../ts/stores.svelte"
    import AutoresizeArea from "../UI/GUI/TextAreaResizable.svelte"
    import ChatBody from './ChatBody.svelte'
    import PopupButton from "../UI/PopupButton.svelte";
    import PartialEditController from './PartialEditController.svelte';
    import { preLoadChat } from "../../ts/process/coldstorage.svelte"
    import { openLogExporterFrom, openLogExporterSingle } from "src/ts/logexporter/index"
    import { getSqlBranchStorage } from "src/ts/storage/sql/sqlStorageFactory"

    let translating = $state(false)
    let editMode = $state(false)
    let statusMessage:string = $state('')
    let retranslate = $state(false)
    let editTranslationMode = $state(false)
    let editTranslationText = $state('')
    let bodyRoot:HTMLElement|null = $state(null)
    interface Props {
        message?: string;
        name?: string;
        largePortrait?: boolean;
        isLastMemory: boolean;
        img?: string|Promise<string>;
        idx?: number;
        scriptIdx?: number;
        messageGenerationInfo?: MessageGenerationInfo|null;
        rerollIcon?: boolean|'dynamic';
        role?: string;
        totalLength?: number;
        onReroll?: (messageIndex?: number) => void | Promise<void>;
        unReroll?: (messageIndex?: number) => void | Promise<void>;
        character?: simpleCharacterArgument|string|null;
        firstMessage?: boolean;
        altGreeting?: boolean;
        currentPage?: number;
        totalPages?: number;
        isComment?: boolean;
        disabled?: boolean | 'allBefore';
        isOptimizedStreamingMessage?: boolean;
        streamingOptimizationMode?: StreamingDisplayOptimizationMode;
        rawStreamingText?: string;
        hideButtons?: boolean;
        targetCharacterIndex?: number;
        targetChatIndex?: number;
        sourceMessage?: Message;
        chatTarget?: ChatExecutionTarget;
    }

    let {
        message = $bindable(''),
        name = '',
        largePortrait = false,
        isLastMemory,
        img = '',
        idx = -1,
        scriptIdx = idx,
        rerollIcon = false,
        messageGenerationInfo = null,
        role = null,
        totalLength = 0,
        onReroll = () => {},
        unReroll = () => {},
        character = null,
        firstMessage = false,
        altGreeting = false,
        currentPage = 1,
        totalPages = 1,
        isComment = false,
        disabled = false,
        isOptimizedStreamingMessage = false,
        streamingOptimizationMode = 'off',
        rawStreamingText = message,
        hideButtons = false,
        targetCharacterIndex = characterStore.selectedId,
        targetChatIndex = characterStore.characters[targetCharacterIndex]?.chatPage ?? 0,
        sourceMessage,
        chatTarget,
    }: Props = $props();

    let effectiveChatTarget = $derived(
        chatTarget ?? chatTargetFromIndexes(targetCharacterIndex, targetChatIndex) ?? undefined
    )

    let msgDisplay = $state('')
    let translated = $state(false)
    let partialEditEnabled = $state(true)
    let renderedSourceMessage = $derived(
        sourceMessage ?? characterStore.characters[targetCharacterIndex]?.chats?.[targetChatIndex]?.message?.[idx]
    )

    export function updateStreamingDisplay(state: {
        isOptimizedStreamingMessage: boolean
        streamingOptimizationMode: StreamingDisplayOptimizationMode
        rawStreamingText: string
    }){
        isOptimizedStreamingMessage = state.isOptimizedStreamingMessage
        streamingOptimizationMode = state.streamingOptimizationMode
        rawStreamingText = state.rawStreamingText
    }

    function findChatIndex(): { characterIndex: number; chatIndex: number } {
        const characterIndex = targetCharacterIndex
        const char = characterStore.characters[characterIndex]
        const chatIndex = targetChatIndex ?? 0
        return { characterIndex, chatIndex }
    }

    async function ensureFullMessageIndex(): Promise<number> {
        const { characterIndex, chatIndex } = findChatIndex()
        const character = characterStore.characters[characterIndex]
        const chat = character?.chats?.[chatIndex]
        const messageId = chat?.message?.[idx]?.chatId
        if (!chat || chat.messagesFullyLoaded !== false) return idx

        await preLoadChat(characterIndex, chatIndex, { full: true })
        if (!messageId) return idx
        return chat.message.findIndex((item) => item.chatId === messageId)
    }

    async function rerollAtCurrentMessage(direction: 'previous'|'next') {
        // Reroll is keyed by the visible message ID. Expanding a paged chat to
        // its full history here made the button block for seconds on Android.
        const targetIndex = idx
        if (direction === 'previous') {
            await unReroll(targetIndex)
        } else {
            await onReroll(targetIndex)
        }
    }

    async function rm(e:MouseEvent, rec?:boolean){
        const targetIndex = await ensureFullMessageIndex()
        if (targetIndex < 0) return
        const char = characterStore.characters[targetCharacterIndex]
        const currentChat = char?.chats?.[targetChatIndex]
        if (!currentChat || !currentChat.message) return

        if(e.shiftKey){
            const deletedIds = (currentChat.message.slice(targetIndex).map((m) => m.chatId).filter(Boolean)) as string[]
            currentChat.message = currentChat.message.slice(0, targetIndex)
            if (currentChat.id && deletedIds.length > 0) {
                await messageStore.deleteMessages(currentChat.id, deletedIds)
            }
            return
        }

        const rm = settingsStore.state.askRemoval ? await alertConfirm(language.removeChat) : true
        if(rm){
            if(settingsStore.state.instantRemove || rec){
                const r = await alertConfirm(language.instantRemoveConfirm)
                if(!r){
                    const deletedIds = (currentChat.message.slice(targetIndex).map((m) => m.chatId).filter(Boolean)) as string[]
                    currentChat.message = currentChat.message.slice(0, targetIndex)
                    if (currentChat.id && deletedIds.length > 0) {
                        await messageStore.deleteMessages(currentChat.id, deletedIds)
                    }
                }
                else{
                    const targetMessage = currentChat.message[targetIndex]
                    currentChat.message.splice(targetIndex, 1)
                    if (currentChat.id && targetMessage?.chatId) {
                        await messageStore.deleteMessage(currentChat.id, targetMessage.chatId)
                    }
                }
            }
            else{
                const targetMessage = currentChat.message[targetIndex]
                currentChat.message.splice(targetIndex, 1)
                if (currentChat.id && targetMessage?.chatId) {
                    await messageStore.deleteMessage(currentChat.id, targetMessage.chatId)
                }
            }
        }
    }

    async function saveEditedMessage(newData: string, createBranch = false){
        const targetIndex = createBranch ? idx : await ensureFullMessageIndex()
        if (targetIndex < 0) return
        const char = characterStore.characters[targetCharacterIndex]
        const currentChat = char?.chats?.[targetChatIndex]
        const currentMessage = currentChat?.message?.[targetIndex]
        if (!currentChat || !currentMessage || currentMessage.data === newData) return

        if (createBranch) {
            currentChat.id ??= v4()
            const storage = await getSqlBranchStorage()
            const branches = await storage.listChatBranches(currentChat.id)
            const parentBranchId = currentChat.activeBranchId
                ?? branches.find((branch) => branch.reason === 'root')?.id
            const forkMessageId = currentChat.message[targetIndex - 1]?.chatId
            const branch = await storage.createChatBranch({
                id: v4(),
                chatId: currentChat.id,
                parentBranchId,
                forkMessageId,
                reason: 'manual',
                createdAt: Date.now(),
            })
            const editedMessage = {
                ...$state.snapshot(currentMessage),
                chatId: v4(),
                data: newData,
            }
            currentChat.activeBranchId = branch.id
            currentChat.message.splice(
                targetIndex,
                currentChat.message.length - targetIndex,
                editedMessage,
            )
            currentChat.messageTotal = (currentChat.messageOffset ?? 0) + currentChat.message.length
            currentChat.messagesFullyLoaded = (currentChat.messageOffset ?? 0) === 0
            await messageStore.appendMessage(currentChat.id, editedMessage)
            return
        }

        currentMessage.data = newData
        if (currentChat.id) {
            await messageStore.updateMessage(currentChat.id, currentMessage)
        }
    }

    async function edit(createBranch = false){
        await saveEditedMessage(message, createBranch)
    }

    function handlePartialEditSave(e: CustomEvent<{ newData: string }>) {
        if (idx >= 0) {
            message = e.detail.newData
            displaya(e.detail.newData)
            void saveEditedMessage(e.detail.newData, false)
        }
    }

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: renderedSourceMessage?.role ?? role ?? null,
            }
            return cbsConditions
        }
        catch(e){
            return {
                firstmsg: firstMessage ?? false,
                chatRole: null,
            }
        }
    }

    async function getTranslationCacheKey(): Promise<string> {
        if(settingsStore.state.translateBeforeHTMLFormatting){
            return msgDisplay
        }
        if(!settingsStore.state.legacyTranslation){
            return await ParseMarkdown(msgDisplay, character, 'pretranslate', scriptIdx, getCbsCondition(), effectiveChatTarget)
        }
        return await ParseMarkdown(msgDisplay, character, 'notrim', scriptIdx, getCbsCondition(), effectiveChatTarget)
    }

    async function loadTranslationForEdit() {
        const key = await getTranslationCacheKey()
        const { getLLMCache } = await import('../../ts/translator/translator')
        const cached = await getLLMCache(key)
        editTranslationText = cached ?? ''
        editTranslationMode = true
    }

    async function saveTranslationEdit() {
        const key = await getTranslationCacheKey()
        const { setLLMCache } = await import('../../ts/translator/translator')
        await setLLMCache(key, editTranslationText)
        editTranslationMode = false
    }

    function displaya(message:string){
        msgDisplay = risuChatParser(message, {chara: name, chatID: scriptIdx, rmVar: true, visualize: true, cbsConditions: getCbsCondition(), chatTarget: effectiveChatTarget})
    }

    const setStatusMessage = (message:string, timeout:number = 0)=>{
        statusMessage = message
        if(timeout === 0) return
        setTimeout(() => {
            statusMessage = ''
        }, timeout)
    }


    let blankMessage = $derived((message === '{{none}}' || message === '{{blank}}' || message === '') && idx === -1 || isComment)
    let displayMessage = $derived(isOptimizedStreamingMessage ? rawStreamingText : message)
    let renderRawStreaming = $derived(isOptimizedStreamingMessage && streamingOptimizationMode === 'strong')

    function updateDisplayedMessage(){
        if(renderRawStreaming){
            return
        }
        displaya(displayMessage)
    }

    $effect.pre(() => {
        updateDisplayedMessage()
    });

    const unsubscribers:Unsubscriber[] = []

    onMount(()=>{
        unsubscribers.push(ReloadGUIPointer.subscribe((v) => {
            updateDisplayedMessage()
        }))
    })

    onDestroy(()=>{
        unsubscribers.forEach(u => u())
    })

    function RenderGUIHtml(html:string){
        try {
            const parser = new DOMParser()
            const doc = parser.parseFromString(risuChatParser(html ?? '', {chatID: scriptIdx, cbsConditions: getCbsCondition(), chatTarget: effectiveChatTarget}), 'text/html')
            return doc.body   
        } catch (error) {
            const placeholder = document.createElement('div')
            return placeholder
        }
    }

    async function handleButtonTriggerWithin(event: UIEvent) {
        if (hideButtons) return
        const target = event.target as HTMLElement
        const origin = target.closest('[risu-trigger], [risu-btn]')
        if (!origin) {
            return
        }

        const characterIndex = targetCharacterIndex
        const character = characterStore.characters?.[characterIndex]
        if (!character) {
            return
        }

        await preLoadChat(characterIndex, targetChatIndex, { full: true })
        const currentChar = characterStore.characters?.[characterIndex]
        const currentChat = currentChar?.chats?.[targetChatIndex]
        if(!currentChar || currentChar.type === 'group' || !currentChat){
            return
        }

        const triggerName = origin.getAttribute('risu-trigger')
        const triggerId = origin.getAttribute('risu-id')
        const btnEvent = origin.getAttribute('risu-btn')
        const executionTarget = requireChatTargetFromIndexes(characterIndex, targetChatIndex)

        const triggerResult = triggerName
            ? await import('src/ts/process/triggers').then(({ runTrigger }) =>
                runTrigger(currentChar, 'manual', {
                    chat: currentChat,
                    target: executionTarget,
                    manualName: triggerName,
                    triggerId: triggerId || undefined,
                }))
            : btnEvent
                ? await import('src/ts/process/scriptings').then(({ runLuaButtonTrigger }) =>
                    runLuaButtonTrigger(currentChar, btnEvent, executionTarget))
                : null

        if(triggerResult?.chat) {
            currentChar.chats[targetChatIndex] = triggerResult.chat
            ReloadChatPointer.update((v) => {
                v[scriptIdx] = (v[scriptIdx] ?? 0) + 1
                return v
            })
        }
        
        if(triggerName && triggerId) {
            setTimeout(() => {
                CurrentTriggerIdStore.set(null)
            }, 100) // Small delay to allow display mode to complete
        }
    }

    let isBookmarked = $derived(
        characterStore.characters[targetCharacterIndex]
            ?.chats?.[targetChatIndex]
            ?.bookmarks?.includes(characterStore.characters[targetCharacterIndex]?.chats?.[targetChatIndex]?.message?.[idx]?.chatId) ?? false
    );

    async function toggleBookmark() {
        const chat = characterStore.characters[targetCharacterIndex].chats[targetChatIndex];
        
        if(!chat.message[idx]) return;

        let messageId = chat.message[idx]?.chatId;
        const messageContent = chat.message[idx]?.data;

        if (!messageId) {
            messageId = uuidv4();
            chat.message[idx].chatId = messageId;
        }

        chat.bookmarks ??= [];
        chat.bookmarkNames ??= {};

        const bookmarkIndex = chat.bookmarks.indexOf(messageId);

        if (bookmarkIndex > -1) {
            chat.bookmarks.splice(bookmarkIndex, 1);
            delete chat.bookmarkNames[messageId];
        } else {
            chat.bookmarks.push(messageId);

            const msgSender = chat.message[idx]?.role === 'user' ? getUserName() : name;
            const newName= await alertInput(language.bookmarkAskNameOrDefault, [], chat.bookmarkNames[messageId] || '');

            if (newName && newName.trim() !== '') {
                chat.bookmarkNames[messageId] = newName;
            } else {
                let defaultName;

                const blacklist = ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '-', '=', '[', ']', '{', '}', '|', ';', ':', '"', "'", ',', '.', '<', '>', '/', '?'];
                let lines = messageContent.split('\n');
                lines = lines.splice(Math.floor(lines.length * 0.5));
                for (const line of lines) {
                    if (line && !blacklist.some(char => line.startsWith(char))) {
                        defaultName = line.trim().slice(0, 50) + '...';
                        break;
                    }
                }
                if (!defaultName) {
                    defaultName = messageContent.slice(0, 50) + '...';
                }
                chat.bookmarkNames[messageId] = msgSender + '| ' + defaultName;
            }
        }

        chat.bookmarks = [...chat.bookmarks];
    }

    function getMaxWidth(): string {
        switch (settingsStore.state.chatLimitSize) {
            //Unlimited
            case -1:
                return '100%'
            
            //Small
            case 0:
               return '600px'

            //Normal
            case 1:
                return '800px'
            
            //Huge
            case 2:
               return '1200px'
            
            default:
                return '100%'
        }
    }
</script>


{#snippet genInfo()}
    {#if !hideButtons}
    <div class="flex flex-col items-end">
        {#if messageGenerationInfo && (settingsStore.state.requestInfoInsideChat || aiLawApplies())}
            <button class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1
                    hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center" 
                    onclick={() => {
                        const currentGenerationInfo = idx >= 0 ? 
                            characterStore.characters[targetCharacterIndex].chats[targetChatIndex].message[idx].generationInfo :
                            messageGenerationInfo

                        alertRequestData({
                            genInfo: currentGenerationInfo,
                            idx: idx,
                        })
                    }}
            >
                <BotIcon size={20} />
                <span class="ml-1">
                    {capitalize(getModelInfo(messageGenerationInfo.model).shortName)}
                </span>
            </button>
        {/if}
        {#if settingsStore.state.translatorType === 'llm' && translated}
            <button class="text-sm p-1 text-textcolor2 border-darkborderc float-end mr-2 my-1
                            hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center"
                    onclick={() => {
                        retranslate = true
                    }}
            >
                <RefreshCcwIcon size={20} />
                <span class="ml-1">
                    {language.retranslate}
                </span>
            </button>
            <button class={"text-sm p-1 border-darkborderc float-end mr-2 my-1 hover:ring-darkbutton hover:ring-3 rounded-md hover:text-textcolor transition-all flex justify-center items-center " + (editTranslationMode ? 'text-blue-400' : 'text-textcolor2')}
                    onclick={() => {
                        if(editTranslationMode){
                            saveTranslationEdit()
                        } else {
                            loadTranslationForEdit()
                        }
                    }}
            >
                <PencilIcon size={20} />
                <span class="ml-1">
                    {editTranslationMode ? language.editTranslationSave : language.editTranslation}
                </span>
            </button>
        {/if}
    </div>
    {/if}
{/snippet}

{#snippet textBox()}
    {#if editTranslationMode}
        <AutoresizeArea bind:value={editTranslationText} handleLongPress={() => {
            saveTranslationEdit()
        }} />
    {:else if editMode}
        <AutoresizeArea bind:value={message} handleLongPress={() => {
            editMode = false
        }} />
    {:else if isComment}
        <div class="w-full flex justify-center text-textcolor2 italic mb-12">

            {#if msgDisplay.startsWith('{{specialcomment')}
                {@const parts = msgDisplay.split('::')}
                {@const type = parts[1]}

                {#if type === 'branchedfrom'}
                    {#if hideButtons}
                        <span class="text-blue-500">
                            <GitBranch size={20} class="inline-block mr-1" />
                            {language.branchedText.replace("{}", parts[3] ?? '')}
                        </span>
                    {:else}
                        <button class="text-blue-500 hover:underline"
                            onclick={() => {
                                console.log(parts)
                                changeChatTo(parts[2] ?? '')
                                foldChatToMessage(parts[4])
                            }}
                        >
                            <GitBranch size={20} class="inline-block mr-1" />
                            {language.branchedText.replace("{}", parts[3] ?? '')}
                        </button>
                    {/if}
                {/if}
            {:else}
                {msgDisplay}
            {/if}
        </div>
    {:else if blankMessage}
        <div class="w-full flex justify-center text-textcolor2 italic mb-12">
            {language.noMessage}
        </div>
    {:else}
        {@const chatReloadPointer = $ReloadGUIPointer + ($ReloadChatPointer[idx] ?? 0)}
        {@const totalLengthPointer = (idx > totalLength - 6) ? totalLength : 0}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span class="text chat-width chattext prose minw-0"
            class:prose-invert={$ColorSchemeTypeStore === 'dark'}
            bind:this={bodyRoot}
            onclick={() => {
            if(!hideButtons && settingsStore.state.clickToEdit && idx > -1 && !isOptimizedStreamingMessage){
                editMode = true
            }
        }}
            style:font-size="{0.875 * (settingsStore.state.zoomsize / 100)}rem"
            style:line-height="{(settingsStore.state.lineHeight ?? 1.25) * (settingsStore.state.zoomsize / 100)}rem"
        >
            {#key `${totalLengthPointer}|${chatReloadPointer}`}
                <ChatBody
                    {character}
                    {firstMessage}
                    idx={scriptIdx}
                    {msgDisplay}
                    {name}
                    {bodyRoot}
                    modelShortName={
                        messageGenerationInfo ? getModelInfo(messageGenerationInfo?.model).shortName : ''
                    }
                    role={role ?? null}
                    bind:translated={translated}
                    bind:translating={translating}
                    bind:retranslate={retranslate}
                    {renderRawStreaming}
                    {rawStreamingText}
                    chatTarget={effectiveChatTarget} />
            {/key}
            {#if !hideButtons && idx >= 0 && !editMode && !isOptimizedStreamingMessage && partialEditEnabled && (settingsStore.state.enableBlockPartialEdit || settingsStore.state.enableDragPartialEdit)}
                <PartialEditController
                    messageData={message}
                    chatIndex={idx}
                    {bodyRoot}
                    blockEditEnabled={settingsStore.state.enableBlockPartialEdit}
                    dragEditEnabled={settingsStore.state.enableDragPartialEdit}
                    on:save={handlePartialEditSave}
                />
            {/if}
        </span>
    {/if}
{/snippet}

{#snippet iconButtons(options:{applyTextColors?:boolean} = {})}
    {#if !hideButtons}
    <div class="grow flex items-center justify-end" class:text-textcolor2={options?.applyTextColors !== false}>
        {#if isComment}
            <button
                class="flex items-center hover:text-blue-500 transition-colors button-icon-remove"
                onclick={async (e) => {
                    await rm(e, true)
                }}
            >
                <TrashIcon size={20} />

            </button>
        {:else}
            <span class="text-xs">{statusMessage}</span>
            <div class="flex items-center ml-2 gap-2">
                {@render translationButton()}
                {#if window.innerWidth >= 640}
                    {@render majorIconButtonsBody(false)}
                    {#if characterStore.characters[targetCharacterIndex]}
                        <PopupButton>
                            {@render minorIconButtonsBody(true)}
                        </PopupButton>
                    {/if}
                {:else}
                    {#if characterStore.characters[targetCharacterIndex]}
                        <PopupButton>
                            {@render majorIconButtonsBody(true)}
                            {@render minorIconButtonsBody(true)}
                        </PopupButton>
                    {:else}
                        {@render majorIconButtonsBody(false)}
                    {/if}
                {/if}
                {@render rerolls()}

            </div>
        {/if}
    </div>
    {/if}
{/snippet}


{#snippet majorIconButtonsBody(showNames:boolean)}
    {#if settingsStore.state.useChatCopy && !blankMessage}
    <button class="flex items-center hover:text-blue-500 transition-colors button-icon-copy" onclick={async ()=>{
        const copyText = renderRawStreaming
            ? risuChatParser(rawStreamingText, {chara: name, chatID: scriptIdx, rmVar: true, visualize: true, cbsConditions: getCbsCondition(), chatTarget: effectiveChatTarget})
            : msgDisplay
        if(window.navigator.clipboard.write){
            try {
                alertWait(language.loading)
                const root = document.querySelector(':root') as HTMLElement;

                const parser = new DOMParser()
                const doc = parser.parseFromString(
                    await ParseMarkdown(copyText, characterStore.characters[targetCharacterIndex], 'normal', scriptIdx, getCbsCondition(), effectiveChatTarget)
                , 'text/html')
                
                doc.querySelectorAll('mark').forEach((el) => {
                    const d = el.getAttribute('risu-mark')
                    if(d === 'quote1' || d === 'quote2'){
                        const newEle = document.createElement('div')
                        newEle.textContent = el.textContent
                        newEle.setAttribute('style', `background: transparent; color: ${
                            root.style.getPropertyValue('--FontColorQuote' + d.slice(-1))
                        };`)
                        el.replaceWith(newEle)
                        return
                    }
                })
                doc.querySelectorAll('p').forEach((el) => {
                    el.setAttribute('style', `color: ${root.style.getPropertyValue('--FontColorStandard')};`)
                })
                doc.querySelectorAll('em').forEach((el) => {
                    el.setAttribute('style', `font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalic')};`)
                })
                doc.querySelectorAll('strong').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; color: ${root.style.getPropertyValue('--FontColorBold')};`)
                })
                doc.querySelectorAll('em strong').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalicBold')};`)
                })
                doc.querySelectorAll('strong em').forEach((el) => {
                    el.setAttribute('style', `font-weight: bold; font-style: italic; color: ${root.style.getPropertyValue('--FontColorItalicBold')};`)
                })
                
                const imgs = doc.querySelectorAll('img')
                for(const img of imgs){
                    img.setAttribute('alt', 'from Risuai')
                    const url = img.getAttribute('src')
                    
                    img.setAttribute('style', `
                        max-width: 100%;
                        margin: 10px 0;
                        border-radius: 8px;
                        box-shadow: rgba(0,0,0,0.1) 0px 2px 8px;
                        display: block;
                        margin-left: auto;
                        margin-right: auto;
                    `)
                    
                    if(url && (url.startsWith('http://asset.localhost') || url.startsWith('https://asset.localhost') || url.startsWith('https://sv.risuai') || url.startsWith('data:') || url.startsWith('http') || url.startsWith('/'))){
                        try {
                            let fetchUrl = url
                            if(url.startsWith('/')) {
                                fetchUrl = window.location.origin + url
                            }
                            
                            const data = await fetch(fetchUrl)
                            if (data.ok) {
                                const canvas = document.createElement('canvas')
                                const ctx = canvas.getContext('2d')
                                const imgElement = new Image()
                                imgElement.crossOrigin = 'anonymous'
                                imgElement.src = await data.blob().then((b) => new Promise((resolve, reject) => {
                                    const reader = new FileReader()
                                    reader.onload = () => resolve(reader.result as string)
                                    reader.onerror = reject
                                    reader.readAsDataURL(b)
                                }))
                                await new Promise((resolve) => {
                                    imgElement.onload = resolve
                                })
                                canvas.width = imgElement.width
                                canvas.height = imgElement.height
                                ctx.drawImage(imgElement, 0, 0)
                                const dataURL = canvas.toDataURL('image/jpeg', 0.6)
                                img.setAttribute('src', dataURL)
                            }
                        } catch (error) {
                            console.error('Image error:', error)
                        }
                    }
                }

                let iconDataUrl = ''
                let hasValidImage = false
                
                try {
                    const iconImage = (await getFileSrc(characterStore.characters[targetCharacterIndex].image ?? '', { thumbnail: true })) ?? ''
                    
                    if(iconImage && (iconImage.startsWith('http://asset.localhost') || iconImage.startsWith('https://asset.localhost') || iconImage.startsWith('https://sv.risuai') || iconImage.startsWith('data:') || iconImage.startsWith('http') || iconImage.startsWith('/'))){
                        if(iconImage.startsWith('data:')){
                            iconDataUrl = iconImage
                            hasValidImage = true
                        } else {
                            const data = await fetch(iconImage)
                            if (data.ok) {
                                const canvas = document.createElement('canvas')
                                const ctx = canvas.getContext('2d')
                                const img = new Image()
                                img.crossOrigin = 'anonymous'
                                img.src = await data.blob().then((b) => new Promise((resolve, reject) => {
                                    const reader = new FileReader()
                                    reader.onload = () => resolve(reader.result as string)
                                    reader.onerror = reject
                                    reader.readAsDataURL(b)
                                }))
                                await new Promise((resolve, reject) => {
                                    img.onload = () => {
                                        canvas.width = img.width
                                        canvas.height = img.height
                                        ctx.drawImage(img, 0, 0)
                                        iconDataUrl = canvas.toDataURL('image/jpeg', 0.9)
                                        hasValidImage = true
                                        resolve(true)
                                    }
                                    img.onerror = () => {
                                        hasValidImage = false
                                        resolve(false)
                                    }
                                })
                            }
                        }
                    }
                } catch (error) {
                    console.error('Icon error:', error)
                    hasValidImage = false
                }

                const isUserMessage = role === 'user'
                const displayName = isUserMessage ? getUserName() : name
                const modelInfo = messageGenerationInfo ? capitalize(getModelInfo(messageGenerationInfo.model).shortName) : (isUserMessage ? 'User' : 'AI')
                
                let finalIconDataUrl = iconDataUrl
                let finalHasValidImage = hasValidImage
                
                if (isUserMessage) {
                    finalHasValidImage = false
                    const userIcon = getUserIcon()
                    if (userIcon) {
                        try {
                            const userIconSrc = await getFileSrc(userIcon)
                            if (userIconSrc && (userIconSrc.startsWith('http://asset.localhost') || userIconSrc.startsWith('https://asset.localhost') || userIconSrc.startsWith('https://sv.risuai') || userIconSrc.startsWith('data:') || userIconSrc.startsWith('http') || userIconSrc.startsWith('/'))) {
                                if (userIconSrc.startsWith('data:')) {
                                    finalIconDataUrl = userIconSrc
                                    finalHasValidImage = true
                                } else {
                                    const data = await fetch(userIconSrc)
                                    if (data.ok) {
                                        const canvas = document.createElement('canvas')
                                        const ctx = canvas.getContext('2d')
                                        const img = new Image()
                                        img.crossOrigin = 'anonymous'
                                        img.src = await data.blob().then((b) => new Promise((resolve, reject) => {
                                            const reader = new FileReader()
                                            reader.onload = () => resolve(reader.result as string)
                                            reader.onerror = reject
                                            reader.readAsDataURL(b)
                                        }))
                                        await new Promise((resolve, reject) => {
                                            img.onload = () => {
                                                canvas.width = img.width
                                                canvas.height = img.height
                                                ctx.drawImage(img, 0, 0)
                                                finalIconDataUrl = canvas.toDataURL('image/jpeg', 0.9)
                                                finalHasValidImage = true
                                                resolve(true)
                                            }
                                            img.onerror = () => {
                                                finalHasValidImage = false
                                                resolve(false)
                                            }
                                        })
                                    }
                                }
                            }
                        } catch (error) {
                            console.error('User icon error:', error)
                            finalHasValidImage = false
                        }
                    }
                }
                
                const html = `<div style="font-family: 'Segoe UI', Roboto, Arial, sans-serif; color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; line-height: 1.6; max-width: 600px; margin: 1rem auto; background: ${root.style.getPropertyValue('--risu-theme-bgcolor')}; border-radius: 12px; box-shadow: 0px 4px 12px rgba(0,0,0,0.15); overflow: hidden;">
<div style="padding: 20px;">
<div style="display: flex; flex-direction: column; align-items: center; margin-bottom: 1rem; text-align: center;">
    ${finalHasValidImage ? `<img style="width: 80px; height: 80px; border-radius: 50%; border: 3px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')}; margin-bottom: 0.75rem; object-fit: cover;" src="${finalIconDataUrl}" alt="profile">` : ''}
    <h3 style="color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; font-weight: 600; font-size: 1.5rem; margin: 0 0 0.5rem 0;">${displayName}</h3>
    ${!isUserMessage ? `<span style="display: inline-block; border-radius: 16px; font-size: 0.8rem; padding: 0.25rem 0.75rem; background: ${root.style.getPropertyValue('--risu-theme-darkbg')}; color: ${root.style.getPropertyValue('--risu-theme-textcolor')}; border: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')};">${modelInfo}</span>` : ''}
</div>
<div style="border-top: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')}; padding-top: 1rem;">
    ${doc.body.innerHTML}
</div>
<div style="text-align: center; margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid ${root.style.getPropertyValue('--risu-theme-darkborderc')};">
    <span style="font-size: 0.75rem; color: ${root.style.getPropertyValue('--risu-theme-textcolor2')}; opacity: 0.7;">From Risuai</span>
</div>
</div>
</div>`

                await window.navigator.clipboard.write([
                    new ClipboardItem({
                        'text/plain': new Blob([copyText], {type: 'text/plain'}),
                        'text/html': new Blob([html], {type: 'text/html'})
                    })
                ])
                alertNormal(language.copied)
                return
            }
            catch (e) {
                alertClear()
                window.navigator.clipboard.writeText(copyText).then(() => {
                    setStatusMessage(language.copied)
                })
            }
        }
        window.navigator.clipboard.writeText(copyText).then(() => {
            setStatusMessage(language.copied)
        })
    }}>
        <CopyIcon size={20}/>
        {#if showNames}
            <span class="ml-1">{language.copy}</span>
        {/if}
    </button>    
{/if}
{#if (idx > -1 || (firstMessage && !blankMessage)) && !renderRawStreaming}
    <button class="flex items-center hover:text-blue-500 transition-colors button-icon-export-from" onclick={() => {
        openLogExporterFrom(idx)
    }} title="이 메시지부터 로그 내보내기">
        <DownloadIcon size={20}/>
        {#if showNames}
            <span class="ml-1">여기서부터</span>
        {/if}
    </button>
    <button class="flex items-center hover:text-blue-500 transition-colors button-icon-export-single" onclick={() => {
        openLogExporterSingle(idx)
    }} title="이 메시지만 내보내기">
        <FileText size={20}/>
        {#if showNames}
            <span class="ml-1">이 메시지만</span>
        {/if}
    </button>
{/if}
{#if idx > -1}
    {#if characterStore.characters[targetCharacterIndex].type !== 'group' && characterStore.characters[targetCharacterIndex].ttsMode !== 'none' && (characterStore.characters[targetCharacterIndex].ttsMode)}
        <button class="flex items-center hover:text-blue-500 transition-colors button-icon-tts" onclick={async ()=>{
            const { sayTTS } = await import('src/ts/process/tts')
            return sayTTS(null, isOptimizedStreamingMessage ? rawStreamingText : message)
        }}>
            <Volume2Icon size={20}/>
            {#if showNames}
                <span class="ml-1">TTS</span>
            {/if}
        </button>
    {/if}
    {#if !$ConnectionOpenStore}
        <button class="flex items-center hover:text-blue-500 transition-colors button-icon-remove" onclick={(e) => rm(e, false)} use:longpress={(e) => rm(e, true)}>
            <TrashIcon size={20}/>

            {#if showNames}
                <span class="ml-1">{language.remove}</span>
            {/if}
        </button>
    {/if}
{/if}
{/snippet}

{#snippet translationButton(showNames = false)}
    {#if settingsStore.state.translator !== '' && !blankMessage && !isOptimizedStreamingMessage}
        <button class={"flex items-center cursor-pointer hover:text-blue-500 transition-colors button-icon-translate " + (translated ? 'text-blue-400':'')} class:translating={translating} onclick={async () => {
            translated = !translated
        }}>
            <LanguagesIcon />
            {#if showNames}
                <span class="ml-1">{language.translate}</span>
            {/if}
        </button>
    {/if}
    {#if idx > -1 && !isOptimizedStreamingMessage}
        <button
            title={language.edit}
            class={"flex items-center hover:text-blue-500 transition-colors button-icon-edit "+(editMode?'text-blue-400':'')}
            onclick={() => {
            if(!editMode){
                editMode = true
            }
            else{
                editMode = false
                void edit(false)
            }
        }}>
            <PencilIcon size={20}/>

            {#if showNames}
                <span class="ml-1">{language.edit}</span>
            {/if}
        </button>
        {#if editMode}
            <button
                title={`${language.edit} (${language.branch})`}
                class="flex items-center hover:text-blue-500 transition-colors button-icon-edit-branch"
                onclick={() => {
                    editMode = false
                    void edit(true)
                }}
            >
                <GitBranch size={20}/>
                {#if showNames}
                    <span class="ml-1">{language.edit} ({language.branch})</span>
                {/if}
            </button>
        {/if}
    {/if}
{/snippet}

{#snippet rerolls()}
    {#if rerollIcon || altGreeting}
        {#if settingsStore.state.swipe || altGreeting}
            <button class="flex items-center hover:text-blue-500 transition-colors button-icon-unreroll" class:dyna-icon={rerollIcon === 'dynamic'} onclick={() => rerollAtCurrentMessage('previous')}>
                <ArrowLeft size={22}/>
            </button>
            {#if firstMessage && settingsStore.state.swipe && settingsStore.state.showFirstMessagePages}
                <span class="flex items-center text-xs text-textcolor2">{currentPage}/{totalPages}</span>
            {/if}
            <button class="flex items-center hover:text-blue-500 transition-colors button-icon-reroll" class:dyna-icon={rerollIcon === 'dynamic'} onclick={() => rerollAtCurrentMessage('next')}>
                <ArrowRight size={22}/>
            </button>
        {:else}
            <button class="flex items-center hover:text-blue-500 transition-colors button-icon-reroll" class:dyna-icon={rerollIcon === 'dynamic'} onclick={() => rerollAtCurrentMessage('next')}>
                <RefreshCcwIcon size={20}/>
            </button>
        {/if}
    {/if}
{/snippet}

{#snippet minorIconButtonsBody(showNames:boolean)}
    
    {#if settingsStore.state.enableBookmark}
        <button class="flex items-center hover:text-blue-500 transition-colors button-icon-bookmark {isBookmarked ? 'text-yellow-400' : ''}" onclick={async () => {
            await sleep(1)
            toggleBookmark()
        }}>
            <BookmarkIcon size={20}/>
            {#if showNames}
                <span class="ml-1">{language.bookmark}</span>
            {/if}
        </button>
    {/if}

    <button class="flex items-center hover:text-blue-500 transition-colors" onclick={async () => {
        await sleep(1)
        const targetIndex = idx
        if (targetIndex < 0) return
        const char = characterStore.characters[targetCharacterIndex]
        const currentChat = char.chats[targetChatIndex]

        currentChat.id ??= v4()
        const currentMessage = currentChat.message[targetIndex]
        if(!currentMessage?.chatId) throw new Error('Cannot branch a message without a persistent message id')
        const storage = await getSqlBranchStorage()
        const branches = await storage.listChatBranches(currentChat.id)
        const parentBranchId = currentChat.activeBranchId
            ?? branches.find((branch) => branch.reason === 'root')?.id
        const branch = await storage.createChatBranch({
            id: v4(),
            chatId: currentChat.id,
            parentBranchId,
            forkMessageId: currentMessage.chatId,
            reason: 'manual',
            createdAt: Date.now(),
        })
        currentChat.activeBranchId = branch.id
        currentChat.message.splice(targetIndex + 1)
        currentChat.messageTotal = (currentChat.messageOffset ?? 0) + currentChat.message.length
        currentChat.messagesFullyLoaded = (currentChat.messageOffset ?? 0) === 0
    }}>
        <SplitIcon size={20}/>
        {#if showNames}
            <span class="ml-1">{language.branch}</span>
        {/if}
    </button>

    <button class="flex items-center hover:text-blue-500 transition-colors" onclick={async () => {
        await sleep(1)
        const char = characterStore.characters[targetCharacterIndex]
        const currentChat = char?.chats?.[targetChatIndex]
        if (currentChat?.message?.[idx]) {
            const currentMessage = currentChat.message[idx]
            currentMessage.disabled = !currentMessage.disabled
            if (currentChat.id) {
                void messageStore.updateMessage(currentChat.id, currentMessage)
            }
        }
    }}>
        <PowerOff size={20}/>
        {#if showNames}
            <span class="ml-1">{language.disableMessage}</span>
        {/if}
    </button>

    <button class="flex items-center hover:text-blue-500 transition-colors" onclick={async () => {
        await sleep(1)
        const char = characterStore.characters[targetCharacterIndex]
        const currentChat = char?.chats?.[targetChatIndex]
        if (currentChat?.message?.[idx]) {
            const currentMessage = currentChat.message[idx]
            currentMessage.disabled = currentMessage.disabled === 'allBefore' ? false : 'allBefore'
            if (currentChat.id) {
                void messageStore.updateMessage(currentChat.id, currentMessage)
            }
        }
    }}>
        <Scissors size={20}/>
        {#if showNames}
            <span class="ml-1">{language.disableAbove}</span>
        {/if}
    </button>
{/snippet}

{#snippet senderIcon(options:{rounded?:boolean,styleFix?:string} = {})}
    {#if !blankMessage && !$HideIconStore}
        {#if characterStore.characters[targetCharacterIndex]?.chaId === "§playground"}
        <div class="shadow-lg border-textcolor2 border flex justify-center items-center text-textcolor2" style={options?.styleFix ?? `height:${settingsStore.state.iconsize * 3.5 / 100}rem;width:${settingsStore.state.iconsize * 3.5 / 100}rem;min-width:${settingsStore.state.iconsize * 3.5 / 100}rem`}
            class:rounded-md={options?.rounded} class:rounded-full={options?.rounded}>
                {#if name === 'assistant'}
                    <BotIcon />
                {:else}
                    <UserIcon />
                {/if}
            </div>
        {:else}
            {#await img}
                <div class="shadow-lg bg-textcolor2" style={options?.styleFix ??`height:${settingsStore.state.iconsize * 3.5 / 100}rem;width:${settingsStore.state.iconsize * 3.5 / 100}rem;min-width:${settingsStore.state.iconsize * 3.5 / 100}rem`}
                class:rounded-md={!options?.rounded} class:rounded-full={options?.rounded}></div>
            {:then m}
                {#if largePortrait && (!options?.rounded)}
                    <div class="shadow-lg bg-textcolor2" style={m + (options?.styleFix ?? `height:${settingsStore.state.iconsize * 3.5 / 100 / 0.75}rem;width:${settingsStore.state.iconsize * 3.5 / 100}rem;min-width:${settingsStore.state.iconsize * 3.5 / 100}rem`)}
                    class:rounded-md={!options?.rounded} class:rounded-full={options?.rounded}></div>
                {:else}
                    <div class="shadow-lg bg-textcolor2" style={m + (options?.styleFix ?? `height:${settingsStore.state.iconsize * 3.5 / 100}rem;width:${settingsStore.state.iconsize * 3.5 / 100}rem;min-width:${settingsStore.state.iconsize * 3.5 / 100}rem`)}
                    class:rounded-md={!options?.rounded} class:rounded-full={options?.rounded}></div>
                {/if}
            {/await}
        {/if}
    {/if}
{/snippet}

{#snippet renderGuiHtmlPart(dom:HTMLElement)}
    {#if dom.tagName === 'IMG'}
        <img class={dom.getAttribute('class') ?? ''} alt="" style={dom.getAttribute('style') ?? ''} />
    {:else if dom.tagName === 'A'}
        <a target="_blank" rel="noreferrer" href={
            (dom.getAttribute('href') && dom.getAttribute('href').startsWith('https')) ? dom.getAttribute('href') : ''
        } class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </a>
    {:else if dom.tagName === 'SPAN'}
        <span class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </span>
    {:else if dom.tagName === 'DIV'}
        <div class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </div>
    {:else if dom.tagName === 'P'}
        <p class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </p>
    {:else if dom.tagName === 'H1'}
        <h1 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h1>
    {:else if dom.tagName === 'H2'}
        <h2 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h2>
    {:else if dom.tagName === 'H3'}
        <h3 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h3>
    {:else if dom.tagName === 'H4'}
        <h4 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h4>
    {:else if dom.tagName === 'H5'}
        <h5 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h5>
    {:else if dom.tagName === 'H6'}
        <h6 class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </h6>
    {:else if dom.tagName === 'UL'}
        <ul class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </ul>
    {:else if dom.tagName === 'OL'}
        <ol class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </ol>
    {:else if dom.tagName === 'LI'}
        <li class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </li>
    {:else if dom.tagName === 'TABLE'}
        <table class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </table>
    {:else if dom.tagName === 'TR'}
        <tr class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </tr>
    {:else if dom.tagName === 'TD'}
        <td class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </td>
    {:else if dom.tagName === 'TH'}
        <th class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </th>
    {:else if dom.tagName === 'HR'}
        <hr class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''} />
    {:else if dom.tagName === 'BR'}
        <br class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
    {:else if dom.tagName === 'CODE'}
        <code class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </code>
    {:else if dom.tagName === 'PRE'}
        <pre class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </pre>
    {:else if dom.tagName === 'BLOCKQUOTE'}
        <blockquote class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </blockquote>
    {:else if dom.tagName === 'EM'}
        <em class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </em>
    {:else if dom.tagName === 'STRONG'}
        <strong class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </strong>
    {:else if dom.tagName === 'U'}
        <u class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </u>
    {:else if dom.tagName === 'DEL'}
        <del class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </del>
    {:else if dom.tagName === 'BUTTON'}
        <button class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </button>
    {:else if dom.tagName === 'RISUTEXTBOX'}
        {@render textBox()}
    {:else if dom.tagName === 'RISUICON'}
        {@render senderIcon()}
    {:else if dom.tagName === 'RISUBUTTONS'}
        {@render iconButtons()}
    {:else if dom.tagName === 'RISUGENINFO'}
        {@render genInfo()}
    {:else if dom.tagName === 'STYLE'}
        <svelte:element this={'style'}>
            {dom.innerHTML}
        </svelte:element>
    {:else}
        <div class={dom.getAttribute('class') ?? ''} style={dom.getAttribute('style') ?? ''}>
            {@render renderChilds(dom)}
        </div>
    {/if}

    
{/snippet}

{#snippet renderChilds(dom:HTMLElement)}
    {#each dom.childNodes as node}
        {#if node.nodeType === Node.TEXT_NODE}
            {node.textContent}
        {:else if node.nodeType === Node.ELEMENT_NODE}
            {@render renderGuiHtmlPart((node as HTMLElement))}
        {/if}
    {/each}
{/snippet}


{#if disabled === true}
<div class="w-full border-t-2 border-dashed border-blue-500"></div>
{/if}
<div class="flex max-w-full justify-center risu-chat items-center"
     data-chat-index={idx}
     data-chat-id={renderedSourceMessage?.chatId ?? ''}
     style:border-top={isLastMemory ? `${settingsStore.state.memoryLimitThickness}px solid rgba(98, 114, 164, 0.7)` : ''}
     onclickcapture={handleButtonTriggerWithin}>
    <div class="text-textcolor mt-1 ml-4 mr-4 mb-1 p-2 bg-transparent grow border-t-gray-900 border-opacity/30 border-transparent flexium items-start" style:max-width={getMaxWidth()}>
        {#if settingsStore.state.theme === 'mobilechat' && !blankMessage}
            <div class={role === 'user' ? "flex items-start w-full justify-end" : "flex items-start w-full justify-start"}>
                {#if role !== 'user'}
                    {@render senderIcon({rounded: true})}
                {/if}
                <div class="flex flex-col max-w-[85%] sm:max-w-[75%] mx-2" class:items-end={role === 'user'}>
                    {#if role !== 'user' && name}
                        <span class="text-xs text-textcolor2 font-medium mb-1 ml-1">{name}</span>
                    {/if}
                    <div
                        class="rounded-2xl p-3 shadow-md border"
                        class:bg-darkbg={role !== 'user'}
                        class:border-darkborderc={role !== 'user'}
                        class:bg-selected={role === 'user'}
                        class:border-borderc={role === 'user'}
                        class:rounded-tl-none={role !== 'user'}
                        class:rounded-tr-none={role === 'user'}
                    >
                        <div class="text-textcolor">{@render textBox()}</div>
                        {#if renderedSourceMessage?.time}
                            <span class="text-xs text-textcolor2/80 mt-1 block" class:text-right={role === 'user'}>
                                {new Intl.DateTimeFormat(undefined, {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                    second: '2-digit',
                                    month: '2-digit',
                                    day: '2-digit',
                                    hour12: false
                                }).format(renderedSourceMessage.time)}
                            </span>
                        {/if}
                    </div>
                    {#if !hideButtons}
                        <div class="flex items-center mt-1 w-full" class:justify-end={role === 'user'}>
                            {#if role !== 'user'}
                                {@render genInfo()}
                            {/if}
                            {@render iconButtons()}
                        </div>
                    {/if}
                </div>
                {#if role === 'user'}
                    {@render senderIcon({rounded: true})}
                {/if}
            </div>
        {:else if settingsStore.state.theme === 'cardboard' && !blankMessage}
            <div class="w-full flex flex-col px-0 sm:px-4 py-4 relative">
                <div
                    class="rounded-xl shadow-xl border p-4 flex flex-col transition-colors relative {role === 'user' ? 'bg-selected/20 border-borderc/40' : 'bg-darkbg border-darkborderc'}"
                >
                    <div class="flex gap-4 mt-2 flex-col sm:flex-row">
                        <div class="flex flex-col items-center">
                            <div class="sm:h-96 sm:w-72 sm:min-w-72 w-48 h-64 overflow-hidden rounded-lg">
                                {@render senderIcon({rounded: false, styleFix:'height:100%;width:100%;object-fit:cover;'})}
                            </div>
                            <h2 class="text-base font-bold text-textcolor text-center mt-2 max-w-full text-ellipsis">{name}</h2>
                        </div>
                        {#if editMode}
                            <div class="grow flex flex-col">
                                <textarea class="grow h-138 sm:h-96 overflow-y-auto bg-darkbg/50 text-textcolor border border-darkborderc rounded-lg p-3 mb-2 resize-none message-edit-area focus:outline-hidden focus:border-borderc" bind:value={message}></textarea>
                                <div class="flex justify-end gap-2">
                                    <button class="text-sm px-3 py-1.5 text-textcolor2 border border-darkborderc hover:bg-darkbutton rounded-md hover:text-textcolor transition-all flex items-center gap-1" onclick={() => {
                                        editMode = false
                                        edit()
                                    }}>
                                        <PencilIcon size={16} />
                                        <span>{language.edit}</span>
                                    </button>
                                </div>
                            </div>
                        {:else}
                            <div class="grow h-138 sm:h-96 overflow-y-auto p-2 mb-2 sm:mb-0 pb-10 text-textcolor">
                                {@render textBox()}
                            </div>
                        {/if}
                    </div>
                    {#if !hideButtons}
                    <div class="absolute bottom-2 right-2 bg-darkbutton/90 backdrop-blur-xs px-2 py-1 rounded-lg border border-darkborderc text-textcolor2 shadow-md flex items-center gap-1">
                        {@render genInfo()}
                        {@render iconButtons()}
                    </div>
                    {/if}
                </div>
            </div>
        {:else if settingsStore.state.theme === 'customHTML' && !blankMessage}
            {@render renderGuiHtmlPart(RenderGUIHtml(settingsStore.state.guiHTML))}
        {:else}
            {@render senderIcon({rounded: settingsStore.state.roundIcons})}
            <span class="flex flex-col ml-4 w-full max-w-full min-w-0 text-black">
                <div class="flexium items-center chat-width">
                    {#if characterStore.characters[targetCharacterIndex]?.chaId === "§playground" && !blankMessage && renderedSourceMessage}
                        <span class="chat-width text-xl border-darkborderc flex items-center text-textcolor">
                            <span>{renderedSourceMessage.role === 'char' ? 'Assistant' : 'User'}</span>
                            {#if !hideButtons}
                            <button class="ml-2 text-textcolor2 hover:text-textcolor" onclick={() => {
                                const char = characterStore.characters[targetCharacterIndex]
                                const currentChat = char?.chats?.[targetChatIndex]
                                if (currentChat?.message?.[idx]) {
                                    const currentMessage = currentChat.message[idx]
                                    currentMessage.role = currentMessage.role === 'char' ? 'user' : 'char'
                                    if (currentChat.id) {
                                        void messageStore.updateMessage(currentChat.id, currentMessage)
                                    }
                                }
                                ReloadChatPointer.update((v) => {
                                    v[scriptIdx] = (v[scriptIdx] ?? 0) + 1
                                    return v
                                })
                            }}><ArrowLeftRightIcon size="18" /></button>
                            {/if}
                        </span>
                    {:else if !blankMessage && !$HideIconStore}
                        <div class="chat-width text-xl unmargin text-textcolor flex items-center">
                            <span>{name}</span>
                        </div>
                    {/if}
                    {@render iconButtons()}
                </div>
                {@render genInfo()}
                {@render textBox()}
            </span>
        {/if}
    </div>
</div>

{#if disabled}
<div class={{
    "w-full border-t-2 border-dashed": true,
    "border-blue-500": disabled === true,
    "border-amber-500": disabled === 'allBefore',
}}></div>
{/if}
