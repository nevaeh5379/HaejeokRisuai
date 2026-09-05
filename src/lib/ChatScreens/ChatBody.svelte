<script lang="ts">
    import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import isEqual from "lodash/isEqual"
    import { settingsStore } from 'src/ts/stores/domain'
    import { sleep } from "src/ts/util"
    import { alertError } from "../../ts/alert"
    import { addMetadataToElement, getDistance, ParseMarkdown, postTranslationParse, trimMarkdown, type CbsConditions, type simpleCharacterArgument } from "../../ts/parser/parser.svelte"
    import { getLLMCache, translateHTML } from "../../ts/translator/translator"
    import { resolveCurrentChatAsset } from "src/ts/chatAssetResolver";
    import type { ChatExecutionTarget } from "src/ts/chatTarget";
    import { getFileSrc, isLiveObjectUrl, onBlobUrlsRevoked, untrackObjectUrl } from "src/ts/globalApi.svelte";
    import { isTauriAssetUrl } from "src/ts/mediaSrc";

    interface Props {
        character?: simpleCharacterArgument|string|null
        firstMessage?: boolean
        idx?: number
        msgDisplay?: string
        name?: string
        role: string|null
        translated: boolean
        translating: boolean
        retranslate: boolean
        bodyRoot?: HTMLElement|null
        modelShortName: string
        renderRawStreaming?: boolean
        rawStreamingText?: string
        chatTarget?: ChatExecutionTarget
    }

    let {
        character = null,
        idx = 0,
        firstMessage = false,
        msgDisplay,
        role,
        translated = $bindable(false),
        translating = $bindable(false),
        retranslate = $bindable(false),
        bodyRoot,
        modelShortName = '',
        renderRawStreaming = false,
        rawStreamingText = '',
        chatTarget,
    }: Props =  $props()

    // svelte-ignore non_reactive_update
    let lastParsed = ''
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10
    // Bumped when a blob URL embedded in lastParsed was revoked by asset
    // cache eviction, so the memoized HTML must be rebuilt. Without this,
    // low-spec eviction makes images vanish until a manual reload.
    let assetRev = 0

    function getCbsCondition(){
        try{
            const cbsConditions:CbsConditions = {
                firstmsg: firstMessage ?? false,
                chatRole: role,
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

    let shouldRenderRawStreaming = $derived(renderRawStreaming && !translated && !retranslate)

    const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number, tries?:number) => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        let lastParsedQueue = ''
        let mode = 'notrim' as const
        try {
            if((!isEqual(lastCharArg, charArg)) || (chatID !== lastChatId)){
                lastParsedQueue = ''
                lastCharArg = charArg
                lastChatId = chatID
                let translateText = false
                try {
                    if(settingsStore.state.autoTranslate){
                        if(settingsStore.state.autoTranslateCachedOnly && settingsStore.state.translatorType === 'llm'){
                            const cache = settingsStore.state.translateBeforeHTMLFormatting
                            ? await getLLMCache(data)
                            : !settingsStore.state.legacyTranslation
                            ? await getLLMCache(await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition(), chatTarget))
                            : await getLLMCache(await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), chatTarget))
                  
                            translateText = cache !== null
                        }
                        else{
                            translateText = true
                        }
                    }

                    const lastTranslated = translated

                    setTimeout(() => {
                            translated = translateText
                    }, 10)

                    // State change of `translated` triggers markParsing again,
                    // causing redundant translation attempts
                    if (lastTranslated !== translateText) {
                        return;
                    }
                } catch (error) {
                    console.error(error)
                }
            }
            if(retranslate || translated){
                if (settingsStore.state.showTranslationLoading) {
                    lastParsed = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`
                }

                let transResult
                
                if(settingsStore.state.translatorType === 'llm' && settingsStore.state.translateBeforeHTMLFormatting){
                    await sleep(100)
                    translating = true
                    data = await translateHTML(data, false, charArg, chatID, retranslate, chatTarget)
                    translating = false
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), chatTarget)
                    lastParsedQueue = marked
                    lastCharArg = charArg
                    transResult = marked
                }
                else if(!settingsStore.state.legacyTranslation){
                    const marked = await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition(), chatTarget)
                    translating = true
                    const translated = await postTranslationParse(await translateHTML(marked, false, charArg, chatID, retranslate, chatTarget))
                    translating = false
                    lastParsedQueue = translated
                    lastCharArg = charArg
                    transResult = translated
                }
                else{
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), chatTarget)
                    translating = true
                    const translated = await translateHTML(marked, false, charArg, chatID, retranslate, chatTarget)
                    translating = false
                    lastParsedQueue = translated
                    lastCharArg = charArg
                    transResult = translated
                }

                setTimeout(() => {
                    retranslate = false
                }, 10);

                return transResult
            }
            else{
                const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), chatTarget)
                lastParsedQueue = marked
                lastCharArg = charArg
                return marked
            }   
        } catch (error) {
            //retry
            if(tries > 2){

                alertError(`Error while parsing chat message: ${translated}, ${error.message}, ${error.stack}`)
                return data
            }
            return await markParsing(data, charArg, chatID, (tries ?? 0) + 1)
        }
        finally{
            //since trimMarkdown is fast, we don't need to cache it
            lastParsed = lastParsedQueue
        }
    }

    const checkImg = () => {
        if(!settingsStore.state.newImageHandlingBeta || !bodyRoot){
            return
        }
        const imgs = bodyRoot.querySelectorAll('img:not([src^="data:"]):not([src^="http:"]):not([src^="https:"]):not([src^="blob:"]):not([src^="file:"]):not([src^="tauri:"]):not([noimage])') as NodeListOf<HTMLImageElement>
        
        if (imgs.length > 0) {
            const currentCharacter = characterStore.currentCharacter
            const styl = currentCharacter.prebuiltAssetStyle

            imgs.forEach(async (img) => {
                const name = img.getAttribute('src')?.toLocaleLowerCase() || ''

                if(isTauriAssetUrl(name)){
                    return
                }

                if(
                    name.length > 200 ||
                    name.includes(':')
                ){
                    img.setAttribute('noimage', 'true')
                    return
                }

                if(name.length < 3){
                    img.setAttribute('noimage', 'true')
                    return
                }
                const currentFound = resolveCurrentChatAsset(currentCharacter, name, getDistance)
                if(currentFound){
                    const got = await getFileSrc(currentFound)
                    const name2 = img.getAttribute('src')?.toLocaleLowerCase() || ''
                    if(name === name2){
                        img.setAttribute('src', got)
                    }

                    if(img.classList.length === 0){
                        img.classList.add('root-loaded-image')
                        img.classList.add('root-loaded-image-' + styl)
                    }
                    img.removeAttribute('noimage')
                }
                else{
                    img.setAttribute('noimage', 'true')
                }
            })
        }
    }

    const ASSET_RETRY_LIMIT = 3
    let assetRetries = 0
    let lastRetryKey = ''

    const bumpAssetRev = () => {
        if(assetRetries >= ASSET_RETRY_LIMIT){
            return
        }
        assetRetries++
        assetRev++
    }

    let markParsingResult = $derived.by(() => {
        assetRev;
        const retryKey = `${idx}|${msgDisplay?.length ?? 0}`
        if(retryKey !== lastRetryKey){
            lastRetryKey = retryKey
            assetRetries = 0
        }
        return markParsing(msgDisplay, character, idx)
    })

    const hasStaleBlobImages = () => {
        if(!bodyRoot){
            return false
        }
        for(const img of bodyRoot.querySelectorAll(`img[src^="blob:"]`)){
            if(!isLiveObjectUrl(img.getAttribute('src') || '')){
                return true
            }
        }
        return false
    }

    $effect(() => {
        const unsubscribe = onBlobUrlsRevoked(() => {
            if(hasStaleBlobImages()){
                bumpAssetRev()
            }
        })
        return unsubscribe
    })

    $effect(() => {
        if(shouldRenderRawStreaming){
            return
        }
        markParsingResult
        checkImg()
        markParsingResult.then(checkImg)

        const onError = (e: Event) => {
            const img = e.target as HTMLImageElement
            const src = img?.getAttribute('src') || ''
            if(src.startsWith('blob:')){
                // Image failed to load after its blob was evicted; re-parse
                // the message so a fresh URL is embedded.
                untrackObjectUrl(src)
                bumpAssetRev()
            }
        }
        bodyRoot?.addEventListener('error', onError, true)
        return () => {
            bodyRoot?.removeEventListener('error', onError, true)
        }
    })
 </script>

{#if shouldRenderRawStreaming}
    <span class="whitespace-pre-wrap">{rawStreamingText}</span>
{:else}
    {#await markParsingResult}
        {@html addMetadataToElement(trimMarkdown(lastParsed), modelShortName)}
    {:then md}
        {@html addMetadataToElement(trimMarkdown(md), modelShortName)}
    {/await}
{/if}
