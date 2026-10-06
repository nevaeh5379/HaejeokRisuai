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
    import { mount, unmount, tick, onDestroy } from "svelte";
    import IllustrationSlot from "./IllustrationSlot.svelte";
    import type { Message } from "src/ts/storage/database/schema";
    import { resolveIllustrationSettings } from "@risuai/protocol/dist/illustration.mjs";
    import { illustrationDisplayLayout } from "src/ts/process/illustration/illustrationDisplay";

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
        sourceMessage?: Message
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
        sourceMessage,
    }: Props =  $props()

    let translationLoadingHtml = $state('')
    let lastCharArg:string|simpleCharacterArgument = null
    let lastChatId = -10
    // Bumped when a blob URL embedded in parsed HTML was revoked by asset
    // cache eviction, so the memoized HTML must be rebuilt. Without this,
    // low-spec eviction makes images vanish until a manual reload.
    let assetRev = $state(0)

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

    // SQL hydration may replace the target object without changing the chat.
    let parsingTargetKey = $derived(JSON.stringify(chatTarget ?? null))
    let parsingTarget: ChatExecutionTarget | undefined = $derived(JSON.parse(parsingTargetKey) ?? undefined)

    const markParsing = async (data: string, charArg: string | simpleCharacterArgument, chatID: number, tries?:number) => {
        // track 'translated' and 'retranslate' state
        translated;
        retranslate;
        let mode = 'notrim' as const
        try {
            if((!isEqual(lastCharArg, charArg)) || (chatID !== lastChatId)){
                lastCharArg = charArg
                lastChatId = chatID
                let translateText = false
                try {
                    if(settingsStore.state.autoTranslate){
                        if(settingsStore.state.autoTranslateCachedOnly && settingsStore.state.translatorType === 'llm'){
                            const cache = settingsStore.state.translateBeforeHTMLFormatting
                            ? await getLLMCache(data)
                            : !settingsStore.state.legacyTranslation
                            ? await getLLMCache(await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition(), parsingTarget))
                            : await getLLMCache(await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), parsingTarget))
                  
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
                    translationLoadingHtml = `<div style="display:flex;justify-content:center;align-items:center;height:48px;"><div style="animation: spin 1s linear infinite; border-radius: 50%; height: 32px; width: 32px; border: 2px solid #3b82f6; border-top: 2px solid transparent;"></div></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style>`
                }

                let transResult
                
                if(settingsStore.state.translatorType === 'llm' && settingsStore.state.translateBeforeHTMLFormatting){
                    await sleep(100)
                    translating = true
                    data = await translateHTML(data, false, charArg, chatID, retranslate, parsingTarget)
                    translating = false
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), parsingTarget)
                    lastCharArg = charArg
                    transResult = marked
                }
                else if(!settingsStore.state.legacyTranslation){
                    const marked = await ParseMarkdown(data, charArg, 'pretranslate', chatID, getCbsCondition(), parsingTarget)
                    translating = true
                    const translated = await postTranslationParse(await translateHTML(marked, false, charArg, chatID, retranslate, parsingTarget))
                    translating = false
                    lastCharArg = charArg
                    transResult = translated
                }
                else{
                    const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), parsingTarget)
                    translating = true
                    const translated = await translateHTML(marked, false, charArg, chatID, retranslate, parsingTarget)
                    translating = false
                    lastCharArg = charArg
                    transResult = translated
                }

                setTimeout(() => {
                    retranslate = false
                }, 10);

                return transResult
            }
            else{
                const marked = await ParseMarkdown(data, charArg, mode, chatID, getCbsCondition(), parsingTarget)
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
            translationLoadingHtml = ''
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

    // Metadata is replaced on every illustration progress update. Keep the
    // parser dependent on the displayed text so tagging/status changes do not
    // create a new parsing promise or replace the message DOM.
    let illustrationLayout = $derived(illustrationDisplayLayout(msgDisplay, sourceMessage?.illustrations))
    let illustrationDisplay = $derived(illustrationLayout.display)
    // Chat normalizes the display before CBS; slot identity comes from the stored narrative.
    let illustrationBindings = $derived(illustrationDisplayLayout(sourceMessage?.data, sourceMessage?.illustrations).bindings)
    let illustrationTargetKey = $derived(chatTarget && sourceMessage?.chatId
        ? JSON.stringify([chatTarget.characterId, chatTarget.chatId, sourceMessage.chatId]) : '')
    // Generated inlay tokens vary in length while the rendered slot stays the same.
    // Only visible text changes may invalidate the parsing promise and its DOM.
    let parsingRetryKey = $derived(`${idx}|${illustrationDisplay?.length ?? 0}`)

    let markParsingResult = $derived.by(() => {
        assetRev;
        const retryKey = parsingRetryKey
        if(retryKey !== lastRetryKey){
            lastRetryKey = retryKey
            assetRetries = 0
        }
        return markParsing(illustrationDisplay, character, idx)
    })
    // Keep one HTML block alive. An await block can switch through its pending
    // branch when upstream props are refreshed, replacing otherwise identical DOM.
    let parsedHtml = $state('')
    $effect(() => {
        const parsed = markParsingResult;
        let cancelled = false;
        void parsed.then((html) => {
            if (!cancelled && html !== undefined) parsedHtml = html;
        });
        return () => { cancelled = true; };
    })

    const hasStaleBlobImages = () => {
        if(!bodyRoot){
            return false
        }
        for(const img of bodyRoot.querySelectorAll(`img[src^="blob:"]`)){
            // IllustrationSlot owns and releases its URLs independently of the parser cache.
            if(img.closest('[data-risu-illustration-image]')) continue;
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
            // A slot owns its image lifecycle; its failures must never replace the chat body.
            if(img?.closest('[data-risu-illustration-image]')) return;
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

    let illustrationWidth = $derived.by(() => {
        const targetCharacter = characterStore.characters.find((c) => c.chaId === chatTarget?.characterId);
        return resolveIllustrationSettings(
            settingsStore.state.illustration,
            targetCharacter?.type === "group" ? undefined : targetCharacter?.illustration,
        ).displayWidth;
    })

    const illustrationMounts = new Map<string, { host: Element; component: ReturnType<typeof mount> }>();
    onDestroy(() => {
        for (const { component } of illustrationMounts.values()) void unmount(component);
        illustrationMounts.clear();
    });

    $effect(() => {
        const parsed = markParsingResult;
        const targetKey = illustrationTargetKey;
        const bindings: { id: string; index: number }[] = JSON.parse(illustrationBindings);
        const root = bodyRoot;
        const rawStreaming = shouldRenderRawStreaming;
        let cancelled = false;
        void parsed.then(async () => {
            await tick();
            if (cancelled) return;
            const hosts = new Map<string, { id: string; host: Element }>();
            if (root && targetKey && !rawStreaming) {
                for (const { id, index } of bindings) {
                    const host = root.querySelector(`[data-risu-illustration="${index}"]`);
                    if (host) hosts.set(`${targetKey}:${id}`, { id, host });
                }
            }
            for (const [key, mounted] of illustrationMounts) {
                if (hosts.get(key)?.host === mounted.host) continue;
                void unmount(mounted.component);
                illustrationMounts.delete(key);
            }
            for (const [key, { id, host }] of hosts) {
                if (illustrationMounts.has(key)) continue;
                const [characterId, chatId, messageId] = JSON.parse(targetKey);
                const component = mount(IllustrationSlot, { target: host, props: {
                    target: { characterId, chatId, messageId, illustrationId: id },
                    get width() { return illustrationWidth; },
                    get hideImages() { return settingsStore.state.hideAllImages; },
                } });
                illustrationMounts.set(key, { host, component });
            }
        }).catch(() => {});
        return () => { cancelled = true; };
    })
 </script>

{#if shouldRenderRawStreaming}
    <span class="whitespace-pre-wrap">{rawStreamingText}</span>
{:else}
    {@html translationLoadingHtml}
    {@html addMetadataToElement(trimMarkdown(parsedHtml), modelShortName)}
{/if}
