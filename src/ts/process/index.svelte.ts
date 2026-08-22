import { get, writable } from "svelte/store";
import { type character, type MessageGenerationInfo, type Chat, type MessagePresetInfo, changeToPreset, setCurrentChat, type Message, type StreamingDisplayOptimizationMode } from "../storage/database.svelte";
import { settingsStore } from '../stores/domain/settingsStore.svelte';
import { characterStore } from '../stores/domain/characterStore.svelte';
import { presetStore } from '../stores/domain/presetStore.svelte';
import { messageStore } from '../stores/domain/messageStore.svelte';
import { CharEmotion, selectedCharID } from "../stores.svelte";
import { ChatTokenizer, tokenize, tokenizeNum } from "../tokenizer";
import { language } from "../../lang";
import { alertError, alertToast } from "../alert";
import { parseChatML } from "../parser/chatML";
import { loadLoreBookV3Prompt } from "./lorebook.svelte";
import { findCharacterbyId, getAuthorNoteDefaultText, getPersonaPrompt, getUserName, isLastCharPunctuation, trimUntilPunctuation, parseToggleSyntax, prebuiltAssetCommand } from "../util";
import { requestChatData } from "./request/request";
import { stableDiff } from "./stableDiff";
import { processScript, processScriptFull, risuChatParser } from "./scripts";
import { exampleMessage } from "./exampleMessages";
import { sayTTS } from "./tts";
import { supaMemory } from "./memory/supaMemory";
import { v4 } from "uuid";
import { groupOrder } from "./group";
import { runTrigger } from "./triggers";
import { HypaProcesser } from "./memory/hypamemory";
import { additionalInformations } from "./embedding/addinfo";
import { getInlayAsset } from "./files/inlays";
import { getGenerationModelString } from "./models/modelString";
import { connectionOpen, peerRevertChat, peerSafeCheck, peerSync } from "../sync/multiuser";
import { runInlayScreen } from "./inlayScreen";
import { addRerolls } from "./prereroll";
import { runImageEmbedding } from "./transformers";
import { hanuraiMemory } from "./memory/hanuraiMemory";
import { hypaMemoryV2 } from "./memory/hypav2";
import { runLuaEditTrigger } from "./scriptings";
import { getModelInfo, LLMFlags } from "../model/modellist";
import { hypaMemoryV3 } from "./memory/hypav3";
import { getModuleAssets, getModuleToggles } from "./modules";
import { readImage } from "../globalApi.svelte";
import { pluginV2 } from "../plugins/plugins.svelte";
import { preLoadChat } from "./coldstorage.svelte";

export interface OpenAIChat{
    role: 'system'|'user'|'assistant'|'function'
    content: string
    memo?:string
    name?:string
    removable?:boolean
    attr?:string[]
    multimodals?: MultiModal[]
    thoughts?: string[]
    cachePoint?: boolean
}

function findMessageIndexByChatId(chat: Chat, chatId?: string){
    if(!chatId){
        return -1
    }

    return chat.message.findIndex((message) => message.chatId === chatId)
}

async function runChatOutputListeners(char: any, chat: any, characterIndex: number, chatIndex: number, messageIndex: number){
    if(pluginV2.chatOutput.size === 0){
        return
    }

    const charSnapshot = $state.snapshot(char)
    const chatSnapshot = $state.snapshot(chat)
    for(const listener of pluginV2.chatOutput){
        try {
            await listener({
                char: charSnapshot,
                chat: chatSnapshot,
                characterIndex,
                chatIndex,
                messageIndex,
            })
        }
        catch(e) {
            console.error(e)
        }
    }
}

export interface MultiModal{
    type:'image'|'video'|'audio'|'signature'
    base64:string,
    height?:number,
    width?:number
}

export interface requestTokenPart{
    name:string
    tokens:number
}

export const doingChat = writable(false)
export const chatProcessStage = writable(0)
export const abortChat = writable(false)
export let requestTokenParts:{[key:string]:requestTokenPart[]} = {}
export let previewFormated:OpenAIChat[] = []
export let previewBody:string = ''

export async function sendChat(chatProcessIndex = -1,arg:{
    chatAdditonalTokens?:number,
    signal?:AbortSignal,
    continue?:boolean,
    usedContinueTokens?:number,
    preview?:boolean
    previewPrompt?:boolean
} = {}):Promise<boolean> {

    chatProcessStage.set(0)
    const abortSignal = arg.signal ?? (new AbortController()).signal
    if ((characterStore as any)?.ensureLoaded) {
        await (characterStore as any).ensureLoaded()
    }
    
    // NOTE: `throwError()` can be called before these are populated (e.g. HypaV3 early validation errors).
    // Keep them declared up-front to avoid TDZ ReferenceErrors in production builds.
    let selectedChar = -1
    let selectedChat = -1
    let currentChar:character
    let generationInfo:MessageGenerationInfo|undefined = undefined

    const stageTimings = {
        stage1Start: 0,
        stage2Start: 0,
        stage3Start: 0,
        stage4Start: 0,
        stage1Duration: 0,
        stage2Duration: 0,
        stage3Duration: 0,
        stage4Duration: 0
    }

    let isAborted = false
    let findCharCache:{[key:string]:character} = {}
    function findCharacterbyIdwithCache(id:string){
        const d = findCharCache[id]
        if(!!d){
            return d
        }
        else{
            const r = findCharacterbyId(id)
            findCharCache[id] = r
            return r
        }
    }


    function runCurrentChatFunction(chat:Chat){
        chat.message = chat.message.map((v) => {
            v.data = risuChatParser(v.data, {chara: currentChar, runVar: true})
            return v
        })
        return chat
    }

    function reformatContent(data:string){
        if(chatProcessIndex === -1){
            return data.trim()
        }
        return data.trim()
    }

    function throwError(error:string){
        if(!settingsStore.state?.inlayErrorResponse){
            alertError(error)
            return
        }

        try{
            const characters = characterStore.characters

            // Prefer already-resolved selection, but fall back to current store/db pointers.
            const sc = selectedChar >= 0 ? selectedChar : get(selectedCharID)
            const charRoom = characters?.[sc]
            if(!charRoom){
                alertError(error)
                return
            }
            const st = selectedChat >= 0 ? selectedChat : charRoom.chatPage
            const chatRoom = charRoom.chats?.[st]
            if(!chatRoom || !Array.isArray(chatRoom.message)){
                alertError(error)
                return
            }

            const messages = chatRoom.message
            const last = messages[messages.length - 1]
            const suffix = `\n\`\`\`risuerror\n${error}\n\`\`\``

            if(last?.role === 'char'){
                last.data += suffix
                return
            }

            const m:Message = {
                role: 'char',
                data: `\`\`\`risuerror\n${error}\n\`\`\``,
                time: Date.now(),
            }
            if(currentChar?.chaId){
                m.saying = currentChar.chaId
            }
            if(generationInfo){
                m.generationInfo = generationInfo
            }
            messages.push(m)
            return
        }
        catch(e){
            console.error(e)
            alertError(error)
            return
        }
    }

    let isDoing = get(doingChat)

    if(isDoing){
        if(chatProcessIndex === -1){
            return false
        }
    }
    doingChat.set(true)

    if(chatProcessIndex === -1 && settingsStore.state.presetChain){
        const names = settingsStore.state.presetChain.split(',').map((v) => v.trim())
        const randomSelect = Math.floor(Math.random() * names.length)
        const ele = names[randomSelect]

        const findId = presetStore.summaries.findIndex((v) => {
            return v.name === ele
        })

        if(findId === -1){
            alertToast(`Cannot find preset: ${ele}`)
        }
        else{
            await changeToPreset(findId, true)
        }
    }

    if(connectionOpen){
        chatProcessStage.set(4)
        const peerSafe = await peerSafeCheck()
        if(!peerSafe){
            peerRevertChat()
            doingChat.set(false)
            throwError(language.otherUserRequesting)
            return false
        }
        await peerSync()
        chatProcessStage.set(0)
    }

    settingsStore.state.statics.messages += 1
    selectedChar = get(selectedCharID)
    const nowChatroom = characterStore.characters[selectedChar]
    if (!nowChatroom) {
        doingChat.set(false)
        return false
    }
    nowChatroom.lastInteraction = Date.now()
    selectedChat = nowChatroom.chatPage
    // Prompt construction, scripts, and memory systems require absolute chat
    // history. The chat screen itself stays paged, but generation hydrates the
    // complete message list immediately before processing.
    await preLoadChat(selectedChar, selectedChat, { full: true })
    nowChatroom.chats[nowChatroom.chatPage].message = nowChatroom.chats[nowChatroom.chatPage].message.map((v) => {
        v.chatId = v.chatId ?? v4()
        return v
    })
    
    let promptInfo: MessagePresetInfo = {}
    let initialPresetNameForPromptInfo = null
    let initialPromptTogglesForPromptInfo: {
        key: string,
        value: string,
    }[] = []
    if(settingsStore.state.promptInfoInsideChat){
        initialPresetNameForPromptInfo = presetStore.activePreset?.name ?? ''
        initialPromptTogglesForPromptInfo = parseToggleSyntax(settingsStore.state.customPromptTemplateToggle + getModuleToggles())
            .flatMap(toggle => {
                const raw = settingsStore.state.globalChatVariables[`toggle_${toggle.key}`]
                if (toggle.type === 'select' || toggle.type === 'text') {
                    return [{ key: toggle.value, value: toggle.options[raw] }];
                }
                if (raw === '1') {
                    return [{ key: toggle.value, value: 'ON' }];
                }
                return [];
            })

        promptInfo = {
            promptName: initialPresetNameForPromptInfo,
            promptToggles: initialPromptTogglesForPromptInfo,
        }
    }

    let caculatedChatTokens = 0
    if(settingsStore.state.aiModel.startsWith('gpt')){
        caculatedChatTokens += 5
    }
    else{
        caculatedChatTokens += 3
    }

    if(nowChatroom.type === 'group'){
        if(chatProcessIndex === -1){
            const charNames =nowChatroom.characters.map((v) => findCharacterbyIdwithCache(v).name)

            const messages = nowChatroom.chats[nowChatroom.chatPage].message
            const lastMessage = messages[messages.length-1]
            let order = nowChatroom.characters.map((v,i) => {
                return {
                    id: v,
                    talkness: nowChatroom.characterActive[i] ? nowChatroom.characterTalks[i] : -1,
                    index: i
                }
            }).filter((v) => {
                return v.talkness > 0
            })
            if(!nowChatroom.orderByOrder){
                order = groupOrder(order, lastMessage?.data).filter((v) => {
                    if(v.id === lastMessage?.saying){
                        return false
                    }
                    return true
                })
            }
            for(let i=0;i<order.length;i++){
                const r = await sendChat(order[i].index, {
                    chatAdditonalTokens: caculatedChatTokens,
                    signal: abortSignal
                })
                if(!r){
                    return false
                }
            }
            return true
        }
        else{
            currentChar = findCharacterbyIdwithCache(nowChatroom.characters[chatProcessIndex])
            if(!currentChar){
                throwError(`cannot find character: ${nowChatroom.characters[chatProcessIndex]}`)
                return false
            }
        }
    }
    else{
        currentChar = nowChatroom
    }

    let chatAdditonalTokens = arg.chatAdditonalTokens ?? caculatedChatTokens
    const tokenizer = new ChatTokenizer(chatAdditonalTokens, settingsStore.state.aiModel.startsWith('gpt') ? 'noName' : 'name')
    let currentChat = runCurrentChatFunction(nowChatroom.chats[selectedChat])
    nowChatroom.chats[selectedChat] = currentChat
    let maxContextTokens = settingsStore.state.maxContext

    chatProcessStage.set(1)
    stageTimings.stage1Start = Date.now()
    let unformated = {
        'main':([] as OpenAIChat[]),
        'jailbreak':([] as OpenAIChat[]),
        'chats':([] as OpenAIChat[]),
        'lorebook':([] as OpenAIChat[]),
        'globalNote':([] as OpenAIChat[]),
        'authorNote':([] as OpenAIChat[]),
        'lastChat':([] as OpenAIChat[]),
        'description':([] as OpenAIChat[]),
        'postEverything':([] as OpenAIChat[]),
        'personaPrompt':([] as OpenAIChat[])
    }

    let promptTemplate = safeStructuredClone(settingsStore.state.promptTemplate)
    const usingPromptTemplate = !!promptTemplate
    if(promptTemplate){
        let hasPostEverything = false
        for(const card of promptTemplate){
            if(card.type === 'postEverything'){
                hasPostEverything = true
                break
            }
        }

        if(!hasPostEverything){
            promptTemplate.push({
                type: 'postEverything'
            })
        }
    }
    if(currentChar.utilityBot && (!(usingPromptTemplate && settingsStore.state.promptSettings.utilOverride))){
        promptTemplate = [
            {
              "type": "plain",
              "text": "",
              "role": "system",
              "type2": "main"
            },
            {
              "type": "description",
            },
            {
              "type": "lorebook",
            },
            {
              "type": "chat",
              "rangeStart": 0,
              "rangeEnd": "end"
            },
            {
              "type": "plain",
              "text": "",
              "role": "system",
              "type2": "globalNote"
            },
            {
                'type': "postEverything"
            }
        ]
    }

    if((!currentChar.utilityBot) && (!promptTemplate)){
        const mainp = currentChar.systemPrompt?.replaceAll('{{original}}', settingsStore.state.mainPrompt) || settingsStore.state.mainPrompt


        function formatPrompt(data:string){
            if(!data.startsWith('@@')){
                data = "@@system\n" + data
            }
            const parts = data.split(/@@@?(user|assistant|system)\n/);
  
            // Initialize empty array for the chat objects
            const chatObjects: OpenAIChat[] = [];
            
            // Loop through the parts array two elements at a time
            for (let i = 1; i < parts.length; i += 2) {
              const role = parts[i] as 'user' | 'assistant' | 'system';
              const content = parts[i + 1]?.trim() || '';
              chatObjects.push({ role, content });
            }

            return chatObjects;
        }

        unformated.main.push(...formatPrompt(risuChatParser(mainp + ((settingsStore.state.additionalPrompt === '' || (!settingsStore.state.promptPreprocess)) ? '' : `\n${settingsStore.state.additionalPrompt}`), {chara: currentChar})))
    
        if(settingsStore.state.jailbreakToggle){
            unformated.jailbreak.push(...formatPrompt(risuChatParser(settingsStore.state.jailbreak, {chara: currentChar})))
        }
    
        unformated.globalNote.push(...formatPrompt(risuChatParser(currentChar.replaceGlobalNote?.replaceAll('{{original}}', settingsStore.state.globalNote) || settingsStore.state.globalNote, {chara:currentChar})))
    }

    let baseDescriptionPrompt:OpenAIChat|null = null
    let beforeDescriptionPrompts:OpenAIChat[] = []
    let afterDescriptionPrompts:OpenAIChat[] = []

    if(currentChat.note){
        unformated.authorNote.push({
            role: 'system',
            content: risuChatParser(currentChat.note, {chara: currentChar})
        })
    }
    else if(getAuthorNoteDefaultText() !== ''){
        unformated.authorNote.push({
            role: 'system',
            content: risuChatParser(getAuthorNoteDefaultText(), {chara: currentChar})
        })
    }

    if(settingsStore.state.chainOfThought && (!(usingPromptTemplate && settingsStore.state.promptSettings.customChainOfThought))){
        unformated.postEverything.push({
            role: 'system',
            content: `<instruction> - before respond everything, Think step by step as a ai assistant how would you respond inside <Thoughts> xml tag. this must be less than 5 paragraphs.</instruction>`
        })
    }

    {
        let description = risuChatParser((settingsStore.state.promptPreprocess ? settingsStore.state.descriptionPrefix: '') + currentChar.desc, {chara: currentChar})

        const additionalInfo = await additionalInformations(currentChar, currentChat)

        if(additionalInfo){
            description += '\n\n' + risuChatParser(additionalInfo, {chara:currentChar})
        }

        if(currentChar.personality){
            description += risuChatParser("\n\nDescription of {{char}}: " + currentChar.personality, {chara: currentChar})
        }

        if(currentChar.scenario){
            description += risuChatParser("\n\nCircumstances and context of the dialogue: " + currentChar.scenario, {chara: currentChar})
        }

        baseDescriptionPrompt = {
            role: 'system',
            content: description
        }
        unformated.description.push(baseDescriptionPrompt)

        if(nowChatroom.type === 'group'){
            const systemMsg = `[Write the next reply only as ${currentChar.name}]`
            unformated.postEverything.push({
                role: 'system',
                content: systemMsg
            })
        }
    }

    const lorepmt = await loadLoreBookV3Prompt()

    const positionRegex = /{{position::(.+?)}}/g
    const replaceposition = (text:string):{text:string, replaced:boolean} => {
        let replaced = false
        const result = text.replace(positionRegex, (match, p1) => {
            replaced = true
            const posMatch = 'pt_' + p1
            const matchingPrompts: string[] = []
            for (const v of lorepmt.actives) {
                if (v.pos === posMatch) {
                    matchingPrompts.push(v.prompt)
                }
            }
            return matchingPrompts.join('\n')
        })
        return {text: result, replaced}
    }

    // maxDepth controls how many levels of nesting are resolved. Currently set to 5, adjust if needed.
    const resolvePosition = (text:string, maxDepth:number = 5) => {
        let result = text
        for(let i=0; i<maxDepth;i++) {
            const r = replaceposition(result)
            result = r.text
            if(!r.replaced) break
        }
        result = result.replace(positionRegex, '')
        return result
    }

    const normalActives = lorepmt.actives.filter(v => {
        return v.pos === '' && v.inject === null
    })
    console.log(normalActives)

    for(const lorebook of normalActives){
        unformated.lorebook.push({
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        })
    }

    const descActives = lorepmt.actives.filter(v => {
        return v.pos === 'after_desc' || v.pos === 'before_desc' || v.pos === 'personality' || v.pos === 'scenario'
    })

    for(const lorebook of descActives){
        const c = {
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        }
        if(lorebook.pos === 'before_desc'){
            beforeDescriptionPrompts.unshift(c)
            unformated.description.unshift(c)
        }
        else{
            afterDescriptionPrompts.push(c)
            unformated.description.push(c)
        }
    }

    if(settingsStore.state.personaPrompt){
        unformated.personaPrompt.push({
            role: 'system',
            content: risuChatParser(getPersonaPrompt(), {chara: currentChar})
        })
    }
    
    if(currentChar.inlayViewScreen){
        if(currentChar.viewScreen === 'emotion'){
            unformated.postEverything.push({
                role: 'system',
                content: currentChar.newGenData.emotionInstructions.replaceAll('{{slot}}', currentChar.emotionImages.map((v) => v[0]).join(', '))
            })
        }
        if(currentChar.viewScreen === 'imggen'){
            unformated.postEverything.push({
                role: 'system',
                content: currentChar.newGenData.instructions
            })
        }
    }

    const postEverythingLorebooks = lorepmt.actives.filter(v => {
        return v.pos === 'depth' && v.depth === 0 && v.role !== 'assistant'
    })
    for(const lorebook of postEverythingLorebooks){
        unformated.postEverything.push({
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        })
    }

    //Since assistant needs to be prefill, we need to add assistant lorebooks after user/system lorebooks
    const postEverythingAssistantLorebooks = lorepmt.actives.filter(v => {
        return v.pos === 'depth' && v.depth === 0 && v.role === 'assistant'
    })

    const injectionLorebooks = lorepmt.actives.filter(v => {
        return v.inject && !v.inject.lore
    })

    const injectionLorePosSet = new Set<string>()
    for(const lorebook of injectionLorebooks){
        injectionLorePosSet.add(lorebook.inject.location)
    }
    
    for(const lorebook of postEverythingAssistantLorebooks){
        unformated.postEverything.push({
            role: lorebook.role,
            content: risuChatParser(resolvePosition(lorebook.prompt), {chara: currentChar})
        })
    }

    //await tokenize currernt
    let currentTokens = settingsStore.state.maxResponse
    let supaMemoryCardUsed = false
    
    //for unexpected error
    currentTokens += 50
    
    const positionParser = (text:string, loc:string) => {
        console.log(injectionLorePosSet)
        if(injectionLorePosSet.has(loc)){
            const matchings = injectionLorebooks.filter(v => {
                return v.inject.location === loc
            })
            for(const lore of matchings){
                switch(lore.inject.operation){
                    case 'append':{
                        text += ' ' + lore.prompt
                        break
                    }
                    case 'prepend':{
                        text = lore.prompt + ' ' + text
                        break
                    }
                    case 'replace':{
                        text = text.replace(lore.inject.param, lore.prompt)
                        break
                    }
                }
            }
        }

        return resolvePosition(text)
    }

    let hasCachePoint = false
    const convertPromptRole = {
        "system": "system",
        "user": "user",
        "bot": "assistant",
    } as const

    function applyPromptBlockRole(chats:OpenAIChat[], role?: 'user'|'bot'|'system'){
        console.log("Applying ", chats, role)
        if(!role){
            return
        }
        for(const chat of chats){
            chat.role = convertPromptRole[role]
        }
    }

    function getDescriptionPrompts(role?: 'user'|'bot'|'system'){
        const pmt = [
            ...safeStructuredClone(beforeDescriptionPrompts),
            ...(baseDescriptionPrompt ? [safeStructuredClone(baseDescriptionPrompt)] : []),
            ...safeStructuredClone(afterDescriptionPrompts)
        ]
        if(baseDescriptionPrompt){
            applyPromptBlockRole([pmt[beforeDescriptionPrompts.length]], role)
        }
        return pmt
    }

    if(promptTemplate){
        const template = promptTemplate

        async function tokenizeChatArray(chats:OpenAIChat[]){
            for(const chat of chats){
                const tokens = await tokenizer.tokenizeChat(chat)
                currentTokens += tokens
            }
        }

        for(const card of template){
            switch(card.type){
                case 'persona':{
                    let pmt = safeStructuredClone(unformated.personaPrompt)
                    applyPromptBlockRole(pmt, card.role2)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)
                        }
                    }

                    await tokenizeChatArray(pmt)
                    break
                }
                case 'description':{
                    let pmt = getDescriptionPrompts(card.role2)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)
                        }
                    }

                    await tokenizeChatArray(pmt)
                    break
                }
                case 'authornote':{
                    let pmt = safeStructuredClone(unformated.authorNote)
                    applyPromptBlockRole(pmt, card.role2)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content || card.defaultText || '')
                        }
                    }

                    await tokenizeChatArray(pmt)
                    break
                }
                case 'lorebook':{
                    await tokenizeChatArray(unformated.lorebook)
                    break
                }
                case 'postEverything':{
                    await tokenizeChatArray(unformated.postEverything)
                    if(usingPromptTemplate && settingsStore.state.promptSettings.postEndInnerFormat){
                        await tokenizeChatArray([{
                            role: 'system',
                            content: settingsStore.state.promptSettings.postEndInnerFormat
                        }])
                    }
                    break
                }
                case 'plain':
                case 'jailbreak':
                case 'cot':{
                    if((!settingsStore.state.jailbreakToggle) && (card.type === 'jailbreak')){
                        continue
                    }
                    if((!settingsStore.state.chainOfThought) && (card.type === 'cot')){
                        continue
                    }

                    const posType = card.type === 'plain' ? card.type2 : card.type
                    let content = positionParser(card.text, posType)

                    if(card.type2 === 'globalNote'){
                        if(currentChar.replaceGlobalNote){
                            content = positionParser(currentChar.replaceGlobalNote, posType).replaceAll('{{original}}', content)
                        }
                        
                        if(currentChar.prebuiltAssetCommand && !card.text.includes('{{//@customimageinstruction}}')){
                            content += prebuiltAssetCommand
                        }
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else if(card.type2 === 'main'){
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else{
                        content = risuChatParser(content, {chara: currentChar, role: card.role})
                    }

                    const prompt:OpenAIChat ={
                        role: convertPromptRole[card.role],
                        content: content
                    }

                    await tokenizeChatArray([prompt])
                    break
                }
                case 'chatML':{
                    let prompts = parseChatML(card.text)
                    await tokenizeChatArray(prompts)
                    break
                }
                case 'chat':{
                    let start = card.rangeStart
                    let end = (card.rangeEnd === 'end') ? unformated.chats.length : card.rangeEnd
                    if(start === -1000){
                        start = 0
                        end = unformated.chats.length
                    }
                    if(start < 0){
                        start = unformated.chats.length + start
                        if(start < 0){
                            start = 0
                        }
                    }
                    if(end < 0){
                        end = unformated.chats.length + end
                        if(end < 0){
                            end = 0
                        }
                    }
                    
                    if(start >= end){
                        break
                    }
                    let chats = unformated.chats.slice(start, end)

                    if(usingPromptTemplate && settingsStore.state.promptSettings.sendChatAsSystem && (!card.chatAsOriginalOnSystem)){
                        chats = systemizeChat(chats)
                    }
                    await tokenizeChatArray(chats)
                    break
                }
                case 'memory':{
                    supaMemoryCardUsed = true
                    break
                }
                case 'cache':{
                    hasCachePoint = true
                    break
                }
            }
        }
    }
    else{
        for(const key in unformated){
            const chats = unformated[key] as OpenAIChat[]
            for(const chat of chats){
                currentTokens += await tokenizer.tokenizeChat(chat)
            }
        }
    }
    
    const examples = exampleMessage(currentChar, getUserName())

    for(const example of examples){
        currentTokens += await tokenizer.tokenizeChat(example)
    }

    let chats:OpenAIChat[] = examples

    if(!settingsStore.state.aiModel.startsWith('novelai') && !settingsStore.state?.promptSettings?.trimStartNewChat){
        chats.push({
            role: 'system',
            content: '[Start a new chat]',
            memo: "NewChat"
        })
    }

    
    let msReseted = false
    const makeMs = (currentChat:Chat) => {
        let mss:Message[] = []
        msReseted = false
        for(let i=currentChat.message.length -1;i>=0;i--){
            const d = currentChat.message[i]
            if(d.disabled === true){
                continue
            }
            if(d.disabled === 'allBefore'){
                msReseted = true
                break
            }
            mss.unshift(d)
        }
        return mss
    }

    let ms:Message[] = makeMs(currentChat)

    if(nowChatroom.type !== 'group' && !msReseted){
        const firstMsg = currentChat.fmIndex === -1 ? nowChatroom.firstMessage : nowChatroom.alternateGreetings[currentChat.fmIndex]

        const chat:OpenAIChat = {
            role: 'assistant',
            content: await (processScript(nowChatroom,
                risuChatParser(firstMsg, {chara: currentChar}),
            'editprocess'))
        }

        if(usingPromptTemplate && settingsStore.state.promptSettings.sendName){
            chat.content = `${currentChar.name}: ${chat.content}`
            chat.attr = ['nameAdded']
        }
        chats.push(chat)
        currentTokens += await tokenizer.tokenizeChat(chat)
    }
    
    console.log('Prepared messages for token calculation:', ms)

    const triggerResult = await runTrigger(currentChar, 'start', {chat: currentChat})
    if(triggerResult){
        currentChat = triggerResult.chat
        setCurrentChat(currentChat)
        ms = makeMs(currentChat)
        currentTokens += triggerResult.tokens
        if(triggerResult.stopSending){
            doingChat.set(false)
            return false
        }
    }

    let index = 0
    for(const msg of ms){
        let formatedChat = (await processScriptFull(nowChatroom,risuChatParser(msg.data, {chara: currentChar, role: msg.role}), 'editprocess', index, {
            chatRole: msg.role,
        })).data
        let name = ''
        if(msg.role === 'char'){
            if(msg.saying){
                name = `${findCharacterbyIdwithCache(msg.saying).name}`
            }
            else{
                name = `${currentChar.name}`
            }
        }
        else if(msg.role === 'user'){
            name = `${getUserName()}`
        }
        if(!msg.chatId){
            msg.chatId = v4()
        }
        let inlays:string[] = []
        if(msg.role === 'char'){
            formatedChat = formatedChat.replace(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g, (
                match: string,
                p1: string,
                p2: string
            ) => {
                if(p2 && p1 === 'inlayeddata'){
                    inlays.push(p2)
                }
                return ''
            })
        }
        else{
            const inlayMatch = formatedChat.match(/{{(inlay|inlayed|inlayeddata)::(.+?)}}/g)
            if(inlayMatch){
                for(const inlay of inlayMatch){
                    inlays.push(inlay)
                }
            }
        }

        let multimodal:MultiModal[] = []
        const modelinfo = getModelInfo(settingsStore.state.aiModel)
        if(inlays.length > 0){
            for(const inlay of inlays){
                const inlayName = inlay.replace('{{inlayed::', '').replace('{{inlay::', '').replace('}}', '').replace('{{inlayeddata::', '')
                const inlayData = await getInlayAsset(inlayName)
                if(inlayData?.type === 'image'){
                    if(modelinfo.flags.includes(LLMFlags.hasImageInput)){
                        multimodal.push({
                            type: 'image',
                            base64: inlayData.data,
                            width: inlayData.width,
                            height: inlayData.height
                        })
                    }
                    else{
                        const captionResult = await runImageEmbedding(inlayData.data) 
                        formatedChat += `[${captionResult[0].generated_text}]`
                    }
                }
                if(inlayData?.type === 'video' || inlayData?.type === 'audio'){
                    if(multimodal.length === 0){
                        multimodal.push({
                            type: inlayData.type,
                            base64: inlayData.data
                        })
                    }
                }
                if(inlayData?.type === 'signature'){
                    multimodal.push({
                        type: 'signature',
                        base64: inlayData.data
                    })
                }
                formatedChat = formatedChat.replace(inlay, '')
            }
        }

        let attr:string[] = []
        let role:'user'|'assistant'|'system' = msg.role === 'user' ? 'user' : 'assistant'

        if(
            (nowChatroom.type === 'group' && findCharacterbyIdwithCache(msg.saying).chaId !== currentChar.chaId) ||
            (nowChatroom.type === 'group' && settingsStore.state.groupOtherBotRole === 'assistant') ||
            (usingPromptTemplate && settingsStore.state.promptSettings.sendName)
        ){
            const form = settingsStore.state.groupTemplate || `<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`
            formatedChat = risuChatParser(form, {chara: findCharacterbyIdwithCache(msg.saying).name}).replace('{{slot}}', formatedChat)
            switch(settingsStore.state.groupOtherBotRole){
                case 'user':
                case 'assistant':
                case 'system':
                    role = settingsStore.state.groupOtherBotRole
                    break
                default:
                    role = 'assistant'
                    break
            }
        }
        let thoughts:string[] = []
        const maxThoughtDepth = settingsStore.state.promptSettings?.maxThoughtTagDepth ?? -1
        formatedChat = formatedChat.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (match, p1) => {
            if(maxThoughtDepth === -1 || (maxThoughtDepth - ms.length) <= index){
                thoughts.push(p1)
            }
            return ''
        })

        const assetPromises:Promise<void>[] = []
        formatedChat = formatedChat.replace(/\{\{asset_?prompt::(.+?)\}\}/gmsiu, (match, p1) => {
            const moduleAssets = getModuleAssets()
            const assets = (currentChar.additionalAssets ?? []).concat(moduleAssets)
            const asset = assets.find(v => {
                return v[0] === p1
            })
            if(asset){
                assetPromises.push((async () => {
                    const assetDataBuf = await readImage(asset[1])
                    multimodal.push({
                        type: "image",
                        base64: `data:image/png;base64,${Buffer.from(assetDataBuf).toString('base64')}`
                    })
                })())
            }
            else if(p1 === 'icon'){
                assetPromises.push((async () => {
                    const assetDataBuf = await readImage(currentChar.image ?? '')
                    multimodal.push({
                        type: "image",
                        base64: `data:image/png;base64,${Buffer.from(assetDataBuf).toString('base64')}`
                    })
                })())
            }
            return ''          
        })
        await Promise.all(assetPromises)

        const chat:OpenAIChat = {
            role: role,
            content: formatedChat,
            memo: msg.chatId,
            attr: attr,
            multimodals: multimodal,
            thoughts: thoughts
        }
        if(chat.multimodals.length === 0){
            delete chat.multimodals
        }
        chats.push(chat)
        currentTokens += await tokenizer.tokenizeChat(chat)
        index++
    }
    console.log(JSON.stringify(chats, null, 2))

    const depthPrompts = lorepmt.actives.filter(v => {
        return (v.pos === 'depth' && v.depth > 0) || v.pos === 'reverse_depth'
    })

    for(const depthPrompt of depthPrompts){
        const chat:OpenAIChat = {
            role: depthPrompt.role,
            content: risuChatParser(resolvePosition(depthPrompt.prompt), {chara: currentChar})
        }
        currentTokens += await tokenizer.tokenizeChat(chat)
    }
    
    if(nowChatroom.supaMemory && (settingsStore.state.supaModelType !== 'none' || settingsStore.state.hanuraiEnable || settingsStore.state.hypav2 || settingsStore.state.hypaV3)){
        stageTimings.stage1Duration = Date.now() - stageTimings.stage1Start
        chatProcessStage.set(2)
        stageTimings.stage2Start = Date.now()
        if(settingsStore.state.hanuraiEnable){
            const hn = await hanuraiMemory(chats, {
                currentTokens,
                maxContextTokens,
                tokenizer
            })

            if(hn === false){
                return false
            }

            chats = hn.chats
            currentTokens = hn.tokens
        }
        else if(settingsStore.state.hypav2){
            console.log("Current chat's hypaV2 Data: ", currentChat.hypaV2Data)
            const sp = await hypaMemoryV2(chats, currentTokens, maxContextTokens, currentChat, nowChatroom, tokenizer)
            if(sp.error){
                console.log(sp)
                throwError(sp.error)
                return false
            }
            chats = sp.chats
            currentTokens = sp.currentTokens
            currentChat.hypaV2Data = sp.memory ?? currentChat.hypaV2Data
            characterStore.characters[selectedChar].chats[selectedChat].hypaV2Data = currentChat.hypaV2Data

            currentChat = characterStore.characters[selectedChar].chats[selectedChat];
            console.log("[Expected to be updated] chat's HypaV2Data: ", currentChat.hypaV2Data)
        }
        else if(settingsStore.state.hypaV3){
            console.log("Current chat's hypaV3 Data: ", currentChat.hypaV3Data)
            const sp = await hypaMemoryV3(chats, currentTokens, maxContextTokens, currentChat, nowChatroom, tokenizer)
            if(sp.error){
                // Save new summary
                if (sp.memory) {
                    currentChat.hypaV3Data = sp.memory
                    characterStore.characters[selectedChar].chats[selectedChat].hypaV3Data = currentChat.hypaV3Data
                }
                console.log(sp)
                throwError(sp.error)
                return false
            }
            chats = sp.chats
            currentTokens = sp.currentTokens
            currentChat.hypaV3Data = sp.memory ?? currentChat.hypaV3Data
            characterStore.characters[selectedChar].chats[selectedChat].hypaV3Data = currentChat.hypaV3Data
    
            currentChat = characterStore.characters[selectedChar].chats[selectedChat];
            console.log("[Expected to be updated] chat's HypaV3Data: ", currentChat.hypaV3Data)
        }
        else{
            const sp = await supaMemory(chats, currentTokens, maxContextTokens, currentChat, nowChatroom, tokenizer, {
                asHyper: settingsStore.state.hypaMemory
            })
            if(sp.error){
                throwError(sp.error)
                return false
            }
            chats = sp.chats
            currentTokens = sp.currentTokens
            currentChat.supaMemoryData = sp.memory ?? currentChat.supaMemoryData
            characterStore.characters[selectedChar].chats[selectedChat].supaMemoryData = currentChat.supaMemoryData
            console.log(currentChat.supaMemoryData)
            currentChat.lastMemory = sp.lastId ?? currentChat.lastMemory;
        }
        stageTimings.stage2Duration = Date.now() - stageTimings.stage2Start
        chatProcessStage.set(1)
    }
    else{
        stageTimings.stage1Duration = Date.now() - stageTimings.stage1Start
        while(currentTokens > maxContextTokens){
            if(chats.length <= 1){
                throwError(language.errors.toomuchtoken + "\n\nRequired Tokens: " + currentTokens)

                return false
            }

            currentTokens -= await tokenizer.tokenizeChat(chats[0])
            chats.splice(0, 1)
        }
        currentChat.lastMemory = chats[0].memo
    }

    let biases:[string,number][] = settingsStore.state.bias.concat(currentChar.bias).map((v) => {
        return [risuChatParser(v[0].replaceAll("\\n","\n").replaceAll("\\r","\r").replaceAll("\\\\","\\"), {chara: currentChar}),v[1]]
    })

    let memories:OpenAIChat[] = []



    if(!promptTemplate){
        unformated.lastChat.push(chats[chats.length - 1])
        chats.splice(chats.length - 1, 1)
    }

    unformated.chats = chats.map((v) => {
        if(v.memo !== 'supaMemory' && v.memo !== 'hypaMemory'){
            v.removable = true
        }
        else if(supaMemoryCardUsed){
            memories.push(v)
            return {
                role: 'system',
                content: '',
            } as OpenAIChat
        }
        else{
            v.content = `<Previous Conversation>${v.content}</Previous Conversation>`
        }
        return v
    }).filter((v) => {
        return v.content.trim() !== '' || (v.multimodals && v.multimodals.length > 0)
    })

    for(const depthPrompt of depthPrompts){
        const chat:OpenAIChat = {
            role: depthPrompt.role,
            content: risuChatParser(resolvePosition(depthPrompt.prompt), {chara: currentChar})
        }
        const depth = depthPrompt.pos === 'depth' ? (depthPrompt.depth) : (unformated.chats.length - depthPrompt.depth)
        unformated.chats.splice(depth,0,chat)
    }

    if(triggerResult){
        if(triggerResult.additonalSysPrompt.promptend){
            unformated.postEverything.push({
                role: 'system',
                content: triggerResult.additonalSysPrompt.promptend
            })
        }
        if(triggerResult.additonalSysPrompt.historyend){
            unformated.lastChat.push({
                role: 'system',
                content: triggerResult.additonalSysPrompt.historyend
            })
        }
        if(triggerResult.additonalSysPrompt.start){
            unformated.lastChat.unshift({
                role: 'system',
                content: triggerResult.additonalSysPrompt.start
            })
        }
    }

    
    //make into one

    let formated:OpenAIChat[] = []
    const formatOrder = safeStructuredClone(settingsStore.state.formatingOrder)
    if(formatOrder){
        formatOrder.push('postEverything')
    }

    //continue chat model
    if(arg.continue && (settingsStore.state.aiModel.startsWith('claude') || settingsStore.state.aiModel.startsWith('gpt') || settingsStore.state.aiModel.startsWith('openrouter') || settingsStore.state.aiModel.startsWith('reverse_proxy'))){
        unformated.postEverything.push({
            role: 'system',
            content: '[Continue the last response]'
        })
    }

    function pushPrompts(cha:OpenAIChat[]){
        for(const chat of cha){
            if(!chat.content.trim() && !(chat.multimodals && chat.multimodals.length > 0)){
                continue
            }
            if(!(settingsStore.state.aiModel.startsWith('gpt') || settingsStore.state.aiModel.startsWith('claude') || settingsStore.state.aiModel === 'openrouter' || settingsStore.state.aiModel === 'reverse_proxy')){
                formated.push(chat)
                continue
            }
            if(chat.role === 'system'){
                const endf = formated.at(-1)
                if(endf && endf.role === 'system' && endf.memo === chat.memo && endf.name === chat.name){
                    formated[formated.length - 1].content += '\n\n' + chat.content
                }
                else{
                    formated.push(chat)
                }
                formated.at(-1).content += ''
            }
            else{
                formated.push(chat)
            }
        }
    }

    let promptBodyformatedForChatStore: OpenAIChat[] = []
    function pushPromptInfoBody(role: "function" | "system" | "user" | "assistant", fmt: string, promptBody: OpenAIChat[]) {
        if(!fmt.trim()){
            return
        }
        promptBody.push({
            role: role,
            content: risuChatParser(fmt),
        })
    }

    if(promptTemplate){
        const template = promptTemplate

        for(const card of template){
            switch(card.type){
                case 'persona':{
                    let pmt = safeStructuredClone(unformated.personaPrompt)
                    applyPromptBlockRole(pmt, card.role2)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)

                            if(settingsStore.state.promptInfoInsideChat && settingsStore.state.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'description':{
                    let pmt = getDescriptionPrompts(card.role2)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content)
                            
                            if(settingsStore.state.promptInfoInsideChat && settingsStore.state.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'authornote':{
                    let pmt = safeStructuredClone(unformated.authorNote)
                    applyPromptBlockRole(pmt, card.role2)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(positionParser(card.innerFormat,card.type), {chara: currentChar}).replace('{{slot}}', pmt[i].content || card.defaultText || '')
                            
                            if(settingsStore.state.promptInfoInsideChat && settingsStore.state.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'lorebook':{
                    pushPrompts(unformated.lorebook)
                    break
                }
                case 'postEverything':{
                    pushPrompts(unformated.postEverything)
                    if(usingPromptTemplate && settingsStore.state.promptSettings.postEndInnerFormat){
                        pushPrompts([{
                            role: 'system',
                            content: settingsStore.state.promptSettings.postEndInnerFormat
                        }])
                    }
                    break
                }
                case 'plain':
                case 'jailbreak':
                case 'cot':{
                    if((!settingsStore.state.jailbreakToggle) && (card.type === 'jailbreak')){
                        continue
                    }
                    if((!settingsStore.state.chainOfThought) && (card.type === 'cot')){
                        continue
                    }

                    const posType = card.type === 'plain' ? card.type2 : card.type
                    let content = positionParser(card.text, posType)

                    if(card.type2 === 'globalNote'){
                        if(currentChar.replaceGlobalNote){
                            content = positionParser(currentChar.replaceGlobalNote, posType).replaceAll('{{original}}', content)
                        }
                        if(currentChar.prebuiltAssetCommand && !card.text.includes('{{//@customimageinstruction}}')){
                            content += prebuiltAssetCommand
                        }
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else if(card.type2 === 'main'){
                        content = (risuChatParser(content, {chara: currentChar, role: card.role}))
                    }
                    else{
                        content = risuChatParser(content, {chara: currentChar, role: card.role})
                    }

                    const prompt:OpenAIChat ={
                        role: convertPromptRole[card.role],
                        content: content
                    }

                    if(settingsStore.state.promptInfoInsideChat && settingsStore.state.promptTextInfoInsideChat && card.type2 !== 'globalNote'){
                        pushPromptInfoBody(prompt.role, prompt.content, promptBodyformatedForChatStore)
                    }

                    pushPrompts([prompt])
                    break
                }
                case 'chatML':{
                    let prompts = parseChatML(card.text)
                    pushPrompts(prompts)
                    break
                }
                case 'chat':{
                    let start = card.rangeStart
                    let end = (card.rangeEnd === 'end') ? unformated.chats.length : card.rangeEnd
                    if(start === -1000){
                        start = 0
                        end = unformated.chats.length
                    }
                    if(start < 0){
                        start = unformated.chats.length + start
                        if(start < 0){
                            start = 0
                        }
                    }
                    if(end < 0){
                        end = unformated.chats.length + end
                        if(end < 0){
                            end = 0
                        }
                    }
                    
                    if(start >= end){
                        break
                    }

                    let chats = unformated.chats.slice(start, end)
                    if(usingPromptTemplate && settingsStore.state.promptSettings.sendChatAsSystem && (!card.chatAsOriginalOnSystem)){
                        chats = systemizeChat(chats)
                    }
                    pushPrompts(chats)

                    if(settingsStore.state.automaticCachePoint && !hasCachePoint){
                        let pointer = formated.length - 1
                        let depthRemaining = 3
                        while(pointer >= 0){
                            if(depthRemaining === 0){
                                break
                            }
                            if(formated[pointer].role === 'user'){
                                formated[pointer].cachePoint = true
                                depthRemaining--
                            }
                            pointer--
                        }
                    }
                    break
                }
                case 'memory':{
                    let pmt = safeStructuredClone(memories)
                    applyPromptBlockRole(pmt, card.role2)
                    if(card.innerFormat && pmt.length > 0){
                        for(let i=0;i<pmt.length;i++){
                            pmt[i].content = risuChatParser(card.innerFormat, {chara: currentChar}).replace('{{slot}}', pmt[i].content)

                            if(settingsStore.state.promptInfoInsideChat && settingsStore.state.promptTextInfoInsideChat){
                                pushPromptInfoBody(pmt[i].role, card.innerFormat, promptBodyformatedForChatStore)
                            }
                        }
                    }

                    pushPrompts(pmt)
                    break
                }
                case 'cache':{
                    let pointer = formated.length - 1
                    let depthRemaining = card.depth
                    while(pointer >= 0){
                        if(depthRemaining === 0){
                            break
                        }
                        if(formated[pointer].role === card.role || card.role === 'all'){
                            formated[pointer].cachePoint = true
                            depthRemaining--
                        }
                        pointer--
                    }
                    break
                }
            }
        }
    }
    else{
        for(let i=0;i<formatOrder.length;i++){
            const cha = unformated[formatOrder[i]]
            pushPrompts(cha)
        }
    }


    formated = formated.map((v) => {
        v.content = v.content.trim()
        return v
    })

    if(settingsStore.state.promptInfoInsideChat && settingsStore.state.promptTextInfoInsideChat){
        promptBodyformatedForChatStore = promptBodyformatedForChatStore.map((v) => {
            v.content = v.content.trim()
            return v
        })
    }


    if(currentChar.depth_prompt && currentChar.depth_prompt.prompt && currentChar.depth_prompt.prompt.length > 0){
        //depth_prompt
        const depthPrompt = currentChar.depth_prompt
        formated.splice(formated.length - depthPrompt.depth, 0, {
            role: 'system',
            content: risuChatParser(depthPrompt.prompt, {chara: currentChar})
        })
    }

    formated = await runLuaEditTrigger(currentChar, 'editRequest', formated)

    if(settingsStore.state.promptInfoInsideChat && settingsStore.state.promptTextInfoInsideChat){
        promptBodyformatedForChatStore = await runLuaEditTrigger(currentChar, 'editRequest', promptBodyformatedForChatStore)
        promptInfo.promptText = promptBodyformatedForChatStore
    }

    //token rechecking
    let inputTokens = 0

    for(const chat of formated){
        inputTokens += await tokenizer.tokenizeChat(chat)
    }

    if(inputTokens > maxContextTokens){
        let pointer = 0
        while(inputTokens > maxContextTokens){
            if(pointer >= formated.length){
                throwError(language.errors.toomuchtoken + "\n\nAt token rechecking. Required Tokens: " + inputTokens)
                return false
            }
            if(formated[pointer].removable){
                inputTokens -= await tokenizer.tokenizeChat(formated[pointer])
                formated[pointer].content = ''
            }
            pointer++
        }
        formated = formated.filter((v) => {
            return v.content !== ''  || (v.multimodals && v.multimodals.length > 0)
        })
    }

    //estimate tokens
    let outputTokens = settingsStore.state.maxResponse
    if(inputTokens + outputTokens > maxContextTokens){
        outputTokens = maxContextTokens - inputTokens
    }
    const generationId = v4()
    const generationModel = getGenerationModelString()

    generationInfo = {
        model: generationModel,
        generationId: generationId,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        maxContext: maxContextTokens,
        stageTiming: {
            stage1: stageTimings.stage1Duration,
            stage2: stageTimings.stage2Duration,
            stage3: 0,
            stage4: 0
        }
    }

    chatProcessStage.set(3)
    stageTimings.stage3Start = Date.now()
    if(arg.preview){
        previewFormated = formated
        return true
    }

    const req = await requestChatData({
        formated: formated,
        biasString: biases,
        currentChar: currentChar,
        useStreaming: true,
        isGroupChat: nowChatroom.type === 'group',
        bias: {},
        continue: arg.continue,
        chatId: generationId,
        imageResponse: settingsStore.state.outputImageModal,
        previewBody: arg.previewPrompt,
        escape: nowChatroom.type === 'character' && nowChatroom.escapeOutput,
        rememberToolUsage: settingsStore.state.rememberToolUsage,
    }, 'model', abortSignal)

    console.log(req)
    if(req.model){
        generationInfo.model = getGenerationModelString(req.model)
        console.log(generationInfo.model, req.model)
    }

    if(arg.previewPrompt && req.type === 'success'){
        previewBody = req.result
        return true
    }

    let result = ''
    let emoChanged = false
    let resendChat = false
    
    if(abortSignal.aborted === true){
        return false
    }
    if(req.type === 'fail'){
        throwError(req.result)
        return false
    }
    else if(req.type === 'streaming'){
        const reader = req.result.getReader()
        let msgIndex = characterStore.characters[selectedChar].chats[selectedChat].message.length
        let prefix = ''
        if(arg.continue){
            msgIndex -= 1
            const outputMessage = characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex]
            prefix = outputMessage.data
        }
        else{
            characterStore.characters[selectedChar].chats[selectedChat].message.push({
                role: 'char',
                data: "",
                saying: currentChar.chaId,
                time: Date.now(),
                generationInfo,
                promptInfo,
                chatId: generationId,
            })
        }
        const outputMessageId = characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex]?.chatId
        const performanceMode: StreamingDisplayOptimizationMode = settingsStore.state.streamingDisplayOptimizationMode ?? 'off'
        characterStore.characters[selectedChar].chats[selectedChat].isStreaming = true
        characterStore.characters[selectedChar].chats[selectedChat].activeStreamingDisplayOptimizationMode = performanceMode
        characterStore.characters[selectedChar].reloadKeys += 1
        let lastResponseChunk:{[key:string]:string} = {}
        let streamAborted:boolean = abortSignal.aborted
        let receivedStreamingResult = false
        const deferStreamingPostProcessing = performanceMode === 'strong'
        const coalesceStreamingDisplay = performanceMode === 'balanced' || performanceMode === 'strong'
        const streamingDisplayFlushDelay = 125
        let pendingStreamingResult: string | null = null
        let streamingFlushTimer: ReturnType<typeof setTimeout> | null = null
        let streamingFlushFrame: number | null = null
        let streamingFlushPromise: Promise<void> | null = null
        let streamingFlushQueued = false
        let streamingFlushError: unknown = null
        const clearStreamingFlushSchedule = () => {
            if(streamingFlushTimer !== null){
                clearTimeout(streamingFlushTimer)
                streamingFlushTimer = null
            }
            if(streamingFlushFrame !== null){
                cancelAnimationFrame(streamingFlushFrame)
                streamingFlushFrame = null
            }
        }
        const flushStreamingDisplay = async () => {
            clearStreamingFlushSchedule()
            if(streamingFlushPromise){
                streamingFlushQueued = true
                return streamingFlushPromise
            }
            streamingFlushPromise = (async () => {
                do {
                    streamingFlushQueued = false
                    const nextResult = pendingStreamingResult
                    pendingStreamingResult = null
                    if(nextResult === null){
                        continue
                    }
                    if(deferStreamingPostProcessing){
                        characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex].data = reformatContent(prefix + nextResult)
                        characterStore.characters[selectedChar].reloadKeys += 1
                        continue
                    }
                    let result2 = await processScriptFull(nowChatroom, reformatContent(prefix + nextResult), 'editoutput', msgIndex)
                    characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex].data = result2.data
                    emoChanged = result2.emoChanged
                    characterStore.characters[selectedChar].reloadKeys += 1
                } while(streamingFlushQueued || pendingStreamingResult !== null)
            })().finally(() => {
                streamingFlushPromise = null
            })
            return streamingFlushPromise
        }
        const scheduleStreamingDisplayFlush = () => {
            if(streamingFlushTimer !== null || streamingFlushFrame !== null){
                return
            }
            streamingFlushTimer = setTimeout(() => {
                streamingFlushTimer = null
                streamingFlushFrame = requestAnimationFrame(() => {
                    streamingFlushFrame = null
                    void flushStreamingDisplay().catch((error) => {
                        streamingFlushError ??= error
                        void reader.cancel().catch(() => {})
                    })
                })
            }, streamingDisplayFlushDelay)
        }
        const abortReader = () => {
            streamAborted = true
            void reader.cancel().catch(() => {})
        }
        abortSignal.addEventListener('abort', abortReader, { once: true })
        try {
            while(streamAborted === false){
                let readed: ReadableStreamReadResult<{ [key: string]: string }>
                try {
                    readed = await reader.read()
                }
                catch(error){
                    if(abortSignal.aborted || streamAborted){
                        streamAborted = true
                        break
                    }
                    throw error
                }
                if(readed.value){
                    receivedStreamingResult = true
                    lastResponseChunk = readed.value
                    const firstChunkKey = Object.keys(lastResponseChunk)[0]
                    result = lastResponseChunk[firstChunkKey]
                    if(!result){
                        result = ''
                    }
                    if(settingsStore.state.removeIncompleteResponse){
                        result = trimUntilPunctuation(result)
                    }
                    if(coalesceStreamingDisplay){
                        pendingStreamingResult = result
                        scheduleStreamingDisplayFlush()
                    }
                    else{
                        let result2 = await processScriptFull(nowChatroom, reformatContent(prefix + result), 'editoutput', msgIndex)
                        characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex].data = result2.data
                        emoChanged = result2.emoChanged
                        characterStore.characters[selectedChar].reloadKeys += 1
                    }
                }
                if(readed.done){
                    break
                }
            }
        }
        finally {
            abortSignal.removeEventListener('abort', abortReader)
            try {
                if(coalesceStreamingDisplay){
                    try {
                        await flushStreamingDisplay()
                    }
                    catch(error){
                        streamingFlushError ??= error
                    }
                }
                if(streamingFlushError !== null){
                    throw streamingFlushError
                }
                if(deferStreamingPostProcessing && receivedStreamingResult){
                    let result2 = await processScriptFull(nowChatroom, reformatContent(prefix + result), 'editoutput', msgIndex)
                    characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex].data = result2.data
                    emoChanged = result2.emoChanged
                }
            }
            finally {
                characterStore.characters[selectedChar].chats[selectedChat].isStreaming = false
                characterStore.characters[selectedChar].chats[selectedChat].activeStreamingDisplayOptimizationMode = undefined
                characterStore.characters[selectedChar].reloadKeys += 1
                void reader.cancel().catch(() => {})
            }
        }

        if(streamAborted || abortSignal.aborted){
            return false
        }

        addRerolls(generationId, Object.values(lastResponseChunk))

        characterStore.characters[selectedChar].chats[selectedChat] = runCurrentChatFunction(characterStore.characters[selectedChar].chats[selectedChat])
        currentChat = characterStore.characters[selectedChar].chats[selectedChat]        
        const triggerResult = await runTrigger(currentChar, 'output', {chat:currentChat})
        if(triggerResult && triggerResult.chat){
            currentChat = triggerResult.chat
        }
        if(triggerResult && triggerResult.sendAIprompt){
            resendChat = true
        }
        characterStore.characters[selectedChar].chats[selectedChat] = currentChat
        currentChat = characterStore.characters[selectedChar].chats[selectedChat]
        const inlayMessageIndex = findMessageIndexByChatId(currentChat, outputMessageId)
        const outputMessage = currentChat.message[inlayMessageIndex]
        if(outputMessage){
            const inlayr = runInlayScreen(currentChar, outputMessage.data)
            outputMessage.data = inlayr.text
            characterStore.characters[selectedChar].chats[selectedChat] = currentChat
            if(inlayr.promise){
                const t = await inlayr.promise
                currentChat = characterStore.characters[selectedChar].chats[selectedChat]
                const asyncInlayMessageIndex = findMessageIndexByChatId(currentChat, outputMessageId)
                if(asyncInlayMessageIndex !== -1){
                    currentChat.message[asyncInlayMessageIndex].data = t
                    characterStore.characters[selectedChar].chats[selectedChat] = currentChat
                }
            }
        }
        currentChat = characterStore.characters[selectedChar].chats[selectedChat]
        const listenerMessageIndex = findMessageIndexByChatId(currentChat, outputMessageId)
        await runChatOutputListeners(currentChar, currentChat, selectedChar, selectedChat, listenerMessageIndex)
        if(settingsStore.state.ttsAutoSpeech){
            await sayTTS(currentChar, result)
        }
    }
    else{
        const msgs = (req.type === 'success') ? [['char',req.result]] as const 
                    : (req.type === 'multiline') ? req.result
                    : []
        let mrerolls:string[] = []
        let outputMessageIndex = -1
        let outputMessageId: string | undefined
        for(let i=0;i<msgs.length;i++){
            let msg = msgs[i]
            let mess = msg[1]
            let msgIndex = characterStore.characters[selectedChar].chats[selectedChat].message.length
            let result2 = await processScriptFull(nowChatroom, reformatContent(mess), 'editoutput', msgIndex)
            if(i === 0 && arg.continue){
                msgIndex -= 1
                let beforeChat = characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex]
                result2 = await processScriptFull(nowChatroom, reformatContent(beforeChat.data + mess), 'editoutput', msgIndex)
            }
            if(settingsStore.state.removeIncompleteResponse){
                result2.data = trimUntilPunctuation(result2.data)
            }
            result = result2.data
            const inlayResult = runInlayScreen(currentChar, result)
            result = inlayResult.text
            emoChanged = result2.emoChanged
            if(i === 0 && arg.continue){
                characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex] = {
                    role: 'char',
                    data: result,
                    saying: currentChar.chaId,
                    time: Date.now(),
                    generationInfo,
                    promptInfo,
                    chatId: generationId,
                }       
                if(inlayResult.promise){
                    const p = await inlayResult.promise
                    characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex].data = p
                }
                outputMessageIndex = msgIndex
                outputMessageId = characterStore.characters[selectedChar].chats[selectedChat].message[msgIndex]?.chatId
            }
            else if(i===0){
                characterStore.characters[selectedChar].chats[selectedChat].message.push({
                    role: msg[0],
                    data: result,
                    saying: currentChar.chaId,
                    time: Date.now(),
                    generationInfo,
                    promptInfo,
                    chatId: generationId,
                })
                const ind = characterStore.characters[selectedChar].chats[selectedChat].message.length - 1
                if(inlayResult.promise){
                    const p = await inlayResult.promise
                    characterStore.characters[selectedChar].chats[selectedChat].message[ind].data = p
                }
                mrerolls.push(result)
                outputMessageIndex = ind
                outputMessageId = characterStore.characters[selectedChar].chats[selectedChat].message[ind]?.chatId
            }
            else{
                mrerolls.push(result)
            }
            characterStore.characters[selectedChar].reloadKeys += 1
            if(settingsStore.state.ttsAutoSpeech){
                await sayTTS(currentChar, result)
            }
        }

        if(mrerolls.length >1){
            addRerolls(generationId, mrerolls)
        }

        characterStore.characters[selectedChar].chats[selectedChat] = runCurrentChatFunction(characterStore.characters[selectedChar].chats[selectedChat])
        currentChat = characterStore.characters[selectedChar].chats[selectedChat]        

        const triggerResult = await runTrigger(currentChar, 'output', {chat:currentChat})
        if(triggerResult && triggerResult.chat){
            characterStore.characters[selectedChar].chats[selectedChat] = triggerResult.chat
        }
        if(triggerResult && triggerResult.sendAIprompt){
            resendChat = true
        }
        currentChat = characterStore.characters[selectedChar].chats[selectedChat]
        if(outputMessageId){
            outputMessageIndex = findMessageIndexByChatId(currentChat, outputMessageId)
            await runChatOutputListeners(currentChar, currentChat, selectedChar, selectedChat, outputMessageIndex)
        }
    }

    let needsAutoContinue = false
    const resultTokens = await tokenize(result) + (arg.usedContinueTokens || 0)
    if(settingsStore.state.autoContinueMinTokens > 0 && resultTokens < settingsStore.state.autoContinueMinTokens){
        needsAutoContinue = true
    }

    if(settingsStore.state.autoContinueChat && (!isLastCharPunctuation(result))){
        //if result doesn't end with punctuation or special characters, auto continue
        needsAutoContinue = true
    }

    if(needsAutoContinue){
        doingChat.set(false)
        return await sendChat(chatProcessIndex, {
            chatAdditonalTokens: arg.chatAdditonalTokens,
            continue: true,
            signal: abortSignal,
            usedContinueTokens: resultTokens
        })
    }

    const igp = risuChatParser(settingsStore.state.igpPrompt ?? "")

    if(igp){
        const igpFormated = parseChatML(igp)
        const rq = await requestChatData({
            formated: igpFormated,
            bias: {}
        },'emotion', abortSignal)

        characterStore.characters[selectedChar].chats[selectedChat].message[characterStore.characters[selectedChar].chats[selectedChat].message.length - 1].data += rq
    }

    stageTimings.stage3Duration = Date.now() - stageTimings.stage3Start

    if(generationInfo.stageTiming) {
        generationInfo.stageTiming.stage3 = stageTimings.stage3Duration
    }
    chatProcessStage.set(4)
    stageTimings.stage4Start = Date.now()

    if(resendChat){
        stageTimings.stage4Duration = Date.now() - stageTimings.stage4Start
        
        if(generationInfo.stageTiming) {
            generationInfo.stageTiming.stage1 = stageTimings.stage1Duration
            generationInfo.stageTiming.stage2 = stageTimings.stage2Duration
            generationInfo.stageTiming.stage3 = stageTimings.stage3Duration
            generationInfo.stageTiming.stage4 = stageTimings.stage4Duration
        }
        
        const lastMessageIndex = characterStore.characters[selectedChar].chats[selectedChat].message.length - 1
        if(lastMessageIndex >= 0 && characterStore.characters[selectedChar].chats[selectedChat].message[lastMessageIndex].generationInfo) {
            characterStore.characters[selectedChar].chats[selectedChat].message[lastMessageIndex].generationInfo = generationInfo
        }
        
        doingChat.set(false)
        return await sendChat(chatProcessIndex, {
            signal: abortSignal
        })
    }

    if(settingsStore.state.notification){
        try {
            const permission = await Notification.requestPermission()
            if(permission === 'granted'){
                const noti = new Notification('Risuai', {
                    body: result
                })
                noti.onclick = () => {
                    window.focus()
                }
            }
        } catch (error) {
            
        }
    }

    peerSync()

    if(req.special){
        if(req.special.emotion){
            let charemotions = get(CharEmotion)
            let currentEmotion = currentChar.emotionImages

            let tempEmotion = charemotions[currentChar.chaId]
            if(!tempEmotion){
                tempEmotion = []
            }
            if(tempEmotion.length > 4){
                tempEmotion.splice(0, 1)
            }

            for(const emo of currentEmotion){
                if(emo[0] === req.special.emotion){
                    const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                    tempEmotion.push(emos)
                    charemotions[currentChar.chaId] = tempEmotion
                    CharEmotion.set(charemotions)
                    emoChanged = true
                    break
                }
            }
        }
    }

    if(!currentChar.inlayViewScreen){
        if(currentChar.viewScreen === 'emotion' && (!emoChanged) && (abortSignal.aborted === false)){

            let currentEmotion = currentChar.emotionImages
            let emotionList = currentEmotion.map((a) => {
                return a[0]
            })
            let charemotions = get(CharEmotion)

            let tempEmotion = charemotions[currentChar.chaId]
            if(!tempEmotion){
                tempEmotion = []
            }
            if(tempEmotion.length > 4){
                tempEmotion.splice(0, 1)
            }

            if(settingsStore.state.emotionProcesser === 'embedding'){
                const hypaProcesser = new HypaProcesser()
                await hypaProcesser.addText(emotionList.map((v) => 'emotion:' + v))
                let searched = (await hypaProcesser.similaritySearchScored(result)).map((v) => {
                    v[0] = v[0].replace("emotion:",'')
                    return v
                })

                //give panaltys
                for(let i =0;i<tempEmotion.length;i++){
                    const emo = tempEmotion[i]
                    //give panalty index
                    const index = searched.findIndex((v) => {
                        return v[0] === emo[0]
                    })

                    const modifier = ((5 - ((tempEmotion.length - (i + 1))))) / 200

                    if(index !== -1){
                        searched[index][1] -= modifier
                    }
                }

                //make a sorted array by score
                const emoresult = searched.sort((a,b) => {
                    return b[1] - a[1]
                }).map((v) => {
                    return v[0]
                })

                for(const emo of currentEmotion){
                    if(emo[0] === emoresult[0]){
                        const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                        tempEmotion.push(emos)
                        charemotions[currentChar.chaId] = tempEmotion
                        CharEmotion.set(charemotions)
                        break
                    }
                }

                

                return true
            }

            function shuffleArray(array:string[]) {
                for (let i = array.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [array[i], array[j]] = [array[j], array[i]];
                }
                return array
            }

            let emobias:{[key:number]:number} = {}

            for(const emo of emotionList){
                const tokens = await tokenizeNum(emo)
                for(const token of tokens){
                    emobias[token] = 10
                }
            }

            for(let i =0;i<tempEmotion.length;i++){
                const emo = tempEmotion[i]

                const tokens = await tokenizeNum(emo[0])
                const modifier = 20 - ((tempEmotion.length - (i + 1)) * (20/4))

                for(const token of tokens){
                    emobias[token] -= modifier
                    if(emobias[token] < -100){
                        emobias[token] = -100
                    }
                }
            }        

            const promptbody:OpenAIChat[] = [
                {
                    role:'system',
                    content: `${settingsStore.state.emotionPrompt2 || "From the list below, choose a word that best represents a character's outfit description, action, or emotion in their dialogue. Prioritize selecting words related to outfit first, then action, and lastly emotion. Print out the chosen word."}\n\n list: ${shuffleArray(emotionList).join(', ')} \noutput only one word.`
                },
                {
                    role: 'user',
                    content: `"Good morning, Master! Is there anything I can do for you today?"`
                },
                {
                    role: 'assistant',
                    content: 'happy'
                },
                {
                    role: 'user',
                    content: result
                },
            ]

            const rq = await requestChatData({
                formated: promptbody,
                bias: emobias,
                currentChar: currentChar,
                maxTokens: 30,
            }, 'emotion', abortSignal)

            if(rq.type === 'fail'){
                if(abortSignal.aborted){
                    return true
                }
                throwError(rq.result)
                return true
            }
            if(rq.type === 'streaming' || rq.type === 'multiline'){
                if(abortSignal.aborted){
                    return true
                }
                throwError('Unexpected response type')
                return true
            }
            else{
                emotionList = currentEmotion.map((a) => {
                    return a[0]
                })
                try {
                    const emotion:string = rq.result.replace(/ |\n/g,'').trim().toLocaleLowerCase()
                    let emotionSelected = false
                    for(const emo of currentEmotion){
                        if(emo[0] === emotion){
                            const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                            tempEmotion.push(emos)
                            charemotions[currentChar.chaId] = tempEmotion
                            CharEmotion.set(charemotions)
                            emotionSelected = true
                            break
                        }
                    }
                    if(!emotionSelected){
                        for(const emo of currentEmotion){
                            if(emotion.includes(emo[0])){
                                const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                                tempEmotion.push(emos)
                                charemotions[currentChar.chaId] = tempEmotion
                                CharEmotion.set(charemotions)
                                emotionSelected = true
                                break
                            }
                        }
                    }
                    if(!emotionSelected && emotionList.includes('neutral')){
                        const emo = currentEmotion[emotionList.indexOf('neutral')]
                        const emos:[string, string,number] = [emo[0], emo[1], Date.now()]
                        tempEmotion.push(emos)
                        charemotions[currentChar.chaId] = tempEmotion
                        CharEmotion.set(charemotions)
                        emotionSelected = true
                    }
                } catch (error) {
                    throwError(language.errors.httpError + `${error}`)
                    return true
                }
            }
            
            return true


        }
        else if(currentChar.viewScreen === 'imggen'){
            if(chatProcessIndex !== -1){
                throwError("Stable diffusion in group chat is not supported")
            }

            const msgs = characterStore.characters[selectedChar].chats[selectedChat].message
            let msgStr = ''
            for(let i = (msgs.length - 1);i>=0;i--){
                if(msgs[i].role === 'char'){
                    msgStr = `character: ${msgs[i].data.replace(/\n/g, ' ')} \n` + msgStr
                }
                else{
                    msgStr = `user: ${msgs[i].data.replace(/\n/g, ' ')} \n` + msgStr
                    break
                }
            }


            await stableDiff(currentChar, msgStr)
        }
    }

    stageTimings.stage4Duration = Date.now() - stageTimings.stage4Start
    
    if(generationInfo.stageTiming) {
        generationInfo.stageTiming.stage1 = stageTimings.stage1Duration
        generationInfo.stageTiming.stage2 = stageTimings.stage2Duration
        generationInfo.stageTiming.stage3 = stageTimings.stage3Duration
        generationInfo.stageTiming.stage4 = stageTimings.stage4Duration
    }
    
    const currentFinishedChat = characterStore.characters[selectedChar]?.chats?.[selectedChat]
    if (currentFinishedChat?.id) {
        const msgs = currentFinishedChat.message ?? []
        const msgsToCommit = msgs.slice(-2)
        if (msgsToCommit.length > 0) {
            void messageStore.commitMessages(currentFinishedChat.id, msgsToCommit).catch((err) => {
                console.error('[requestProcess] Failed to commit chat messages:', err)
            })
        }
    }

    return true
}

function systemizeChat(chat:OpenAIChat[]){
    for(let i=0;i<chat.length;i++){
        if(chat[i].role === 'user' || chat[i].role === 'assistant'){
            const attr = chat[i].attr ?? []
            if(chat[i].name?.startsWith('example_')){
                chat[i].content = chat[i].name + ': ' + chat[i].content
            }
            else if(!attr.includes('nameAdded')){
                chat[i].content = chat[i].role + ': ' + chat[i].content
            }
            chat[i].role = 'system'
            delete chat[i].memo
            delete chat[i].name
        }
    }
    return chat
}
