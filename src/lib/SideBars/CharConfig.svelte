<script lang="ts">
    import { language } from "../../lang";
    import { getCurrentCharacter, saveImage as saveAsset, type character, type groupChat } from "../../ts/storage/database.svelte";
    import { characterStore, settingsStore, moduleStore } from 'src/ts/stores/domain';
    import { onDestroy } from 'svelte';
    import { CharConfigSubMenu, MobileGUI, ShowRealmFrameStore, selectedCharID, hypaV3ModalOpen } from "../../ts/stores.svelte";
    import { PlusIcon, SmileIcon, TrashIcon, UserIcon, ActivityIcon, BookIcon, User, Braces, Volume2Icon, DownloadIcon, HardDriveUploadIcon, Share2Icon, ImageIcon, ImageOffIcon, ArrowUp, ArrowDown } from '@lucide/svelte'
    import Check from "../UI/GUI/CheckInput.svelte";
    import { addCharEmotion, addingEmotion, getCharImage, rmCharEmotion, selectCharImg, makeGroupImage, removeChar, changeCharImage } from "../../ts/characters";
    import LoreBook from "./LoreBook/LoreBookSetting.svelte";
    import { alertNormal, alertTOS, showHypaV2Alert } from "../../ts/alert";
    import BarIcon from "./BarIcon.svelte";
    import { findCharacterbyId, getAuthorNoteDefaultText, selectMultipleFile, selectSingleFile } from "../../ts/util";
    import Help from "../Others/Help.svelte";
    import { exportChar } from "src/ts/characterCards";
    import { getElevenTTSVoices, getWebSpeechTTSVoices, getVOICEVOXVoices, oaiVoices, getNovelAIVoices } from "src/ts/process/tts";
    import { getFileSrc } from "src/ts/globalApi.svelte";
    import { addGroupChar, rmCharFromGroup } from "src/ts/process/group";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import NumberInput from "../UI/GUI/NumberInput.svelte";
    import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import RegexList from "./Scripts/RegexList.svelte";
    import TriggerList from "./Scripts/TriggerList.svelte";
    import CheckInput from "../UI/GUI/CheckInput.svelte";
    import { updateInlayScreen } from "src/ts/process/inlayScreen";
    import MultiLangInput from "../UI/GUI/MultiLangInput.svelte";
    import { applyModule } from "src/ts/process/modules";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import SliderInput from "../UI/GUI/SliderInput.svelte";
    import Toggles from "./Toggles.svelte";
    import { convertCharacterToModule } from "src/ts/interchangeability";
    import { getMimeType } from "src/ts/media";
    import { createDeferredTokenCalculator } from "src/ts/deferredTokenCalculator";

    let iconRemoveMode = $state(false)
    let viewSubMenu = $state(0)
    let emos:[string, string][] = $state([])
    let iconButtonSize = window.innerWidth > 360 ? 24 as const : 20 as const
    let tokens = $state({
        desc: null as number | null,
        firstMsg: null as number | null,
        localNote: null as number | null,
    })

    const tokenCalculator = createDeferredTokenCalculator({
        calculate: async (text) => {
            const { tokenizeAccurate } = await import('../../ts/tokenizer')
            return tokenizeAccurate(text)
        },
        apply: (result) => {
            tokens.desc = result.desc
            tokens.firstMsg = result.firstMsg
            tokens.localNote = result.localNote
        },
    })

    onDestroy(() => tokenCalculator.dispose())


    let assetFileExtensions:string[] = $state([])
    let assetFilePath:string[] = $state([])
    let licensed = $state((characterStore.characters[$selectedCharID].type === 'character') ? (characterStore.characters[$selectedCharID] as character).license : '')

    $effect.pre(() => {
        emos = characterStore.characters[$selectedCharID].emotionImages
    });

    $effect(() => {
        const chara = characterStore.characters[$selectedCharID]
        const desc = chara.type !== 'group' ? (chara as character).desc : null
        const firstMsg = chara.type !== 'group' ? chara.firstMessage : null
        const localNote = chara.chats[chara.chatPage].note

        const changedTokens = tokenCalculator.update({
            desc,
            firstMsg,
            localNote,
        })
        for (const key of changedTokens) {
            tokens[key] = null
        }
    });

    $effect.pre(() => {
        if(characterStore.characters[$selectedCharID].type ==='character' && settingsStore.state.useAdditionalAssetsPreview){
            if((characterStore.characters[$selectedCharID] as character).additionalAssets){
                for(let i = 0; i < (characterStore.characters[$selectedCharID] as character).additionalAssets.length; i++){
                    if((characterStore.characters[$selectedCharID] as character).additionalAssets[i].length > 2 && (characterStore.characters[$selectedCharID] as character).additionalAssets[i][2]) {
                        assetFileExtensions[i] = (characterStore.characters[$selectedCharID] as character).additionalAssets[i][2]
                    } else
                        assetFileExtensions[i] = (characterStore.characters[$selectedCharID] as character).additionalAssets[i][1].split('.').pop()
                    getFileSrc((characterStore.characters[$selectedCharID] as character).additionalAssets[i][1]).then((filePath) => {
                        assetFilePath[i] = filePath
                    })
                }
            }
        }
    });

    $effect.pre(() => {
        licensed = (characterStore.characters[$selectedCharID].type === 'character') ? (characterStore.characters[$selectedCharID] as character).license : ''
    });
    $effect.pre(() => {
        if (characterStore.characters[$selectedCharID].ttsMode === 'novelai' && (characterStore.characters[$selectedCharID] as character).naittsConfig === undefined) {
            (characterStore.characters[$selectedCharID] as character).naittsConfig = {
                customvoice: false,
                voice: 'Aini',
                version: 'v2'
            };
        }
    });
    $effect.pre(() => {
        if (characterStore.characters[$selectedCharID].ttsMode === 'gptsovits' && (characterStore.characters[$selectedCharID] as character).gptSoVitsConfig === undefined) {
            (characterStore.characters[$selectedCharID] as character).gptSoVitsConfig = {
                url: '',
                use_auto_path: false,
                ref_audio_path: '',
                use_long_audio: false,
                ref_audio_data: {
                    fileName: '',
                    assetId: ''  
                },
                volume: 1.0,
                text_lang: 'auto',
                text: 'en',
                use_prompt: false,
                prompt_lang: 'en',
                top_p: 1,
                temperature: 0.7,
                speed: 1,
                top_k: 5,
                text_split_method: 'cut0',
            };
        }
    });

    let fishSpeechModels:{
        _id:string,
        title:string,
        description:string
    }[] = $state([])

    $effect.pre(() => {
        if (characterStore.characters[$selectedCharID].ttsMode === 'fishspeech' && (characterStore.characters[$selectedCharID] as character).fishSpeechConfig === undefined) {
            (characterStore.characters[$selectedCharID] as character).fishSpeechConfig = {
                model: {
                    _id: '',
                    title: '',
                    description: ''
                },
                chunk_length: 200,
                normalize: false,
            };
        }
    });

    $effect.pre(() => {
        if (characterStore.characters[$selectedCharID].ttsMode === 'openai' && (characterStore.characters[$selectedCharID] as character).oaiTTSConfig === undefined) {
            (characterStore.characters[$selectedCharID] as character).oaiTTSConfig = {
                enabled: false,
                format: 'mp3',
            };
        }
    });

    $effect.pre(() => {
        if(characterStore.characters[$selectedCharID].type === 'group' && ($CharConfigSubMenu === 4 || $CharConfigSubMenu === 5)){
            $CharConfigSubMenu = 0
        }

    });

    async function getFishSpeechModels() {
        try {
            const res = await fetch(`https://api.fish.audio/model?self=true`, {
                headers: {
                    'Authorization': `Bearer ${settingsStore.state.fishSpeechKey}`
                }
            });
            const data = await res.json();
            console.log(data.items);
            console.log(characterStore.characters[$selectedCharID])
            
            if (Array.isArray(data.items)) {
                fishSpeechModels = data.items.map((item) => ({
                    _id: item._id || '',
                    title: item.title || '',
                    description: item.description || ''
                }));
            } else {
                console.error('Expected an array of items, but received:', data.items);
                fishSpeechModels = [];
            }
        } catch (error) {
            console.error('Error fetching fish speech models:', error);
            fishSpeechModels = [];
        }
    }

    function moveAlternateGreetingUp(index: number) {
        if(index === 0) return
        if(characterStore.characters[$selectedCharID].type === 'character'){
            let alternateGreetings = characterStore.characters[$selectedCharID].alternateGreetings
            let temp = alternateGreetings[index]
            alternateGreetings[index] = alternateGreetings[index - 1]
            alternateGreetings[index - 1] = temp
            characterStore.characters[$selectedCharID].alternateGreetings = alternateGreetings
        }
    }

    function moveAlternateGreetingDown(index: number) {
        if(index === characterStore.characters[$selectedCharID].alternateGreetings.length - 1) return
        if(characterStore.characters[$selectedCharID].type === 'character'){
            let alternateGreetings = characterStore.characters[$selectedCharID].alternateGreetings
            let temp = alternateGreetings[index]
            alternateGreetings[index] = alternateGreetings[index + 1]
            alternateGreetings[index + 1] = temp
            characterStore.characters[$selectedCharID].alternateGreetings = alternateGreetings
        }
    }

</script>

{#if licensed !== 'private' && !$MobileGUI}
    <div class="flex mb-2" class:gap-2={iconButtonSize === 24} class:gap-1={iconButtonSize < 24}>
        <button class={$CharConfigSubMenu === 0 ? 'text-textcolor ' : 'text-textcolor2'} onclick={() => {$CharConfigSubMenu = 0}}>
            <UserIcon size={iconButtonSize} />
        </button>
        <button class={$CharConfigSubMenu === 1 ? 'text-textcolor' : 'text-textcolor2'} onclick={() => {$CharConfigSubMenu = 1}}>
            <SmileIcon size={iconButtonSize} />
        </button>
        <button class={$CharConfigSubMenu === 3 ? 'text-textcolor' : 'text-textcolor2'} onclick={() => {$CharConfigSubMenu = 3}}>
            <BookIcon size={iconButtonSize} />
        </button>
        {#if characterStore.characters[$selectedCharID].type === 'character'}
            <button class={$CharConfigSubMenu === 5 ? 'text-textcolor' : 'text-textcolor2'} onclick={() => {$CharConfigSubMenu = 5}}>
                <Volume2Icon size={iconButtonSize} />
            </button>
            <button class={$CharConfigSubMenu === 4 ? 'text-textcolor' : 'text-textcolor2'} onclick={() => {$CharConfigSubMenu = 4}}>
                <Braces size={iconButtonSize} />
            </button>
        {/if}
        <button class={$CharConfigSubMenu === 2 ? 'text-textcolor' : 'text-textcolor2'} onclick={() => {$CharConfigSubMenu = 2}}>
            <ActivityIcon size={iconButtonSize} />
        </button>
        {#if characterStore.characters[$selectedCharID].type === 'character'}
            <button class={$CharConfigSubMenu === 6 ? 'text-textcolor' : 'text-textcolor2'} onclick={() => {$CharConfigSubMenu = 6}}>
                <Share2Icon size={iconButtonSize} />
            </button>
        {/if}
    </div>
{/if}


{#if $CharConfigSubMenu === 0}
    {#if characterStore.characters[$selectedCharID].type !== 'group' && licensed !== 'private'}
        <TextInput size="xl" marginBottom placeholder="Character Name" bind:value={characterStore.characters[$selectedCharID].name} />
        <span class="text-textcolor">{language.description} <Help key="charDesc"/></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={(characterStore.characters[$selectedCharID] as character).desc}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm">{tokens.desc ?? '…'} {language.tokens}</span>
        <span class="text-textcolor">{language.firstMessage} <Help key="charFirstMessage"/></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].firstMessage}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm">{tokens.firstMsg ?? '…'} {language.tokens}</span>

    {:else if licensed !== 'private' && characterStore.characters[$selectedCharID].type === 'group'}
        <TextInput size="xl" marginBottom placeholder="Group Name" bind:value={characterStore.characters[$selectedCharID].name} />
        <span class="text-textcolor">{language.character}</span>
        <div class="p-4 gap-2 bg-bgcolor rounded-lg char-grid">
            {#if (characterStore.characters[$selectedCharID] as groupChat).characters.length === 0}
                <span class="text-textcolor2">No Character</span>
            {:else}
                <div></div>
                <div class="text-center">{language.talkness}</div>
                <div class="text-center">{language.active}</div>
                {#each (characterStore.characters[$selectedCharID] as groupChat).characters as char, i}
                    {#await getCharImage(findCharacterbyId(char).image, 'css', { thumbnail: true })}
                        <BarIcon onClick={() => {
                            rmCharFromGroup(i)
                        }}>
                            <User/>
                        </BarIcon>
                    {:then im} 
                        <BarIcon onClick={() => {
                            rmCharFromGroup(i)
                        }} additionalStyle={im} />
                    {/await}
                    <div class="flex items-center px-2 py-3">
                        {#each [1,2,3,4,5,6] as barIndex}
                            <button class="bg-selected h-full flex-1 border-r-bgcolor border-r" 
                                aria-labelledby="loading"
                                class:bg-green-500={(characterStore.characters[$selectedCharID] as groupChat).characterTalks[i] >= (1 / 6 * barIndex)}
                                class:bg-selected={(characterStore.characters[$selectedCharID] as groupChat).characterTalks[i] < (1 / 6 * barIndex)}
                                class:rounded-l-lg={barIndex === 1}
                                class:rounded-r-lg={barIndex === 6}
                                onclick={() => {
                                    if(characterStore.characters[$selectedCharID].type === 'group'){
                                        (characterStore.characters[$selectedCharID] as groupChat).characterTalks[i] = (1 / 6 * barIndex)
                                    }
                                }}
                            ></button>
                        {/each}
                    </div>
                    <div class="flex items-center justify-center">
                        <Check margin={false} bind:check={(characterStore.characters[$selectedCharID] as groupChat).characterActive[i]} />
                    </div>
                {/each}
            {/if}
        </div>
        <div class="text-textcolor2 mt-1 flex mb-6">
            <button onclick={addGroupChar} class="hover:text-textcolor cursor-pointer">
                <PlusIcon />
            </button>
        </div>

    {/if}
    <span class="text-textcolor">{language.authorNote} <Help key="chatNote"/></span>
    <TextAreaInput
        margin="both"
        autocomplete="off"
        bind:value={characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].note}
        highlight
        placeholder={getAuthorNoteDefaultText()}
    />
    <span class="text-textcolor2 mb-6 text-sm">{tokens.localNote ?? '…'} {language.tokens}</span>

    {#if !$MobileGUI}
        <Toggles bind:chara={characterStore.characters[$selectedCharID]} noContainer />

        {#if characterStore.characters[$selectedCharID].type === 'group'}
            <div class="flex mt-2 items-center">
                <Check bind:check={(characterStore.characters[$selectedCharID] as groupChat).orderByOrder} name={language.orderByOrder}/>
            </div>
        {/if}
    {/if}
{:else if licensed === 'private'}
    <span>You are not allowed</span>
    {(() => {
        $CharConfigSubMenu = 0
    })()}
{:else if $CharConfigSubMenu === 1}
    {#if !$MobileGUI}
        <h2 class="mb-2 text-2xl font-bold mt-2">{language.characterDisplay}</h2>
    {/if}

    <div class="flex w-full rounded-md border border-selected mb-4">
        <button onclick={() => {
            viewSubMenu = 0
        }} class="p-2 flex-1" class:bg-selected={viewSubMenu === 0}>
            <span>{characterStore.characters[$selectedCharID].type !== 'group' ? language.charIcon : language.groupIcon}</span>
        </button>
        <button onclick={() => {
            viewSubMenu = 1
        }} class="p2 flex-1 border-r border-l border-selected" class:bg-selected={viewSubMenu === 1}>
            <span>{language.viewScreen}</span>
        </button>
        <button onclick={() => {
            viewSubMenu = 2
        }} class="p-2 flex-1" class:bg-selected={viewSubMenu === 2}>
            <span>{language.additionalAssets}</span>
        </button>
    </div>

    {#if viewSubMenu === 0}
        {#if characterStore.characters[$selectedCharID].type === 'group'}
            <button onclick={async () => {await selectCharImg($selectedCharID)}}>
                {#await getCharImage(characterStore.characters[$selectedCharID].image, 'css')}
                    <div class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3"></div>
                {:then im}
                    <div class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3" style={im}></div>     
                {/await}
            </button>
        {:else}
            <div class="p-2 border-darkborderc border rounded-md flex flex-wrap gap-2">
                {#if characterStore.characters[$selectedCharID].image !== '' && characterStore.characters[$selectedCharID].image}
                    <button onclick={() => {
                        if(
                            characterStore.characters[$selectedCharID].type === 'character' &&
                            characterStore.characters[$selectedCharID].image !== '' &&
                            characterStore.characters[$selectedCharID].image &&
                            iconRemoveMode
                        ){
                            characterStore.characters[$selectedCharID].image = ''
                            if((characterStore.characters[$selectedCharID] as character).ccAssets && (characterStore.characters[$selectedCharID] as character).ccAssets.length > 0){
                                changeCharImage($selectedCharID, 0)
                            }
                            iconRemoveMode = false
                        }
                    }}>
                        {#await getCharImage(characterStore.characters[$selectedCharID].image, (characterStore.characters[$selectedCharID] as character).largePortrait ? 'lgcss' : 'css')}
                            <div
                                class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
                                class:ring-red-500={iconRemoveMode}
    ></div>
                        {:then im}
                            <div
                                class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer ring-3 transition-shadow"
                                class:ring-red-500={iconRemoveMode}
                                style={im}
    ></div>     
                        {/await}
                    </button>
                {/if}
                {#if (characterStore.characters[$selectedCharID] as character).ccAssets}
                    {#each (characterStore.characters[$selectedCharID] as character).ccAssets as assets, i}
                        <button onclick={async () => {
                            if(!iconRemoveMode){
                                changeCharImage($selectedCharID, i)
                            }
                            else if(characterStore.characters[$selectedCharID].type === 'character'){
                                (characterStore.characters[$selectedCharID] as character).ccAssets.splice(i, 1)
                                iconRemoveMode = false
                            }
                        }}>
                            {#await getCharImage(assets.uri, (characterStore.characters[$selectedCharID] as character).largePortrait ? 'lgcss' : 'css')}
                                <div
                                    class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                                    class:ring-red-500={iconRemoveMode} class:ring-3={iconRemoveMode}
    ></div>
                            {:then im}
                                <div
                                    class="rounded-md h-24 w-24 shadow-lg bg-textcolor2 cursor-pointer hover:ring-3 transition-shadow"
                                    style={im} class:ring-red-500={iconRemoveMode} class:ring-3={iconRemoveMode}
    ></div>     
                            {/await}
                        </button>
                    {/each}
                {/if}
                <button onclick={async () => {await selectCharImg($selectedCharID);}}>
                    <div
                        class="rounded-md h-24 w-24 cursor-pointer border-darkborderc border border-dashed flex justify-center items-center hover:border-blue-500"
                        style={(characterStore.characters[$selectedCharID] as character).largePortrait ? 'height: 10.66rem;' : ''}
                    >
                        <PlusIcon />
                    </div>
                </button>
            </div>
            <div class="flex w-full items-end justify-end mt-2">
                <button class={iconRemoveMode ? "text-red-500" : "text-textcolor2 hover:text-textcolor"} onclick={() => {
                    iconRemoveMode = !iconRemoveMode
                }}>
                    <TrashIcon size="18" />
                </button>
            </div>
        {/if}

        {#if characterStore.characters[$selectedCharID].type === 'character' && characterStore.characters[$selectedCharID].image !== ''}
            <div class="flex items-center mt-4">
                <Check bind:check={(characterStore.characters[$selectedCharID] as character).largePortrait} name={language.largePortrait}/>
            </div>
        {/if}

        {#if characterStore.characters[$selectedCharID].type === 'group'}
            <Button onclick={makeGroupImage}>
                {language.createGroupImg}
            </Button>
        {/if}


    {:else if viewSubMenu === 1}
        <!-- svelte-ignore block_empty -->

        {#if characterStore.characters[$selectedCharID].type !== 'group'}
            <SelectInput className="mb-2" bind:value={characterStore.characters[$selectedCharID].viewScreen} onchange={() => {
                if(characterStore.characters[$selectedCharID].type === 'character'){
                    characterStore.characters[$selectedCharID] = updateInlayScreen((characterStore.characters[$selectedCharID] as character))
                }
            }}>
                <OptionInput value="none">{language.none}</OptionInput>
                <OptionInput value="emotion">{language.emotionImage}</OptionInput>
                <OptionInput value="imggen">{language.imageGeneration}</OptionInput>
            </SelectInput>
        {:else}
            <SelectInput className="mb-2" bind:value={characterStore.characters[$selectedCharID].viewScreen}>
                <OptionInput value="none">{language.none}</OptionInput>
                <OptionInput value="single">{language.singleView}</OptionInput>
                <OptionInput value="multiple">{language.SpacedView}</OptionInput>
                <OptionInput value="emp">{language.emphasizedView}</OptionInput>

            </SelectInput>
        {/if}

        {#if characterStore.characters[$selectedCharID].viewScreen === 'emotion'}
            <span class="text-textcolor mt-6">{language.emotionImage} <Help key="emotion"/></span>
            <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>

            <div class="w-full max-w-full border border-selected p-2 rounded-md">

                <table class="w-full max-w-full tabler">
                    <tbody>
                    <tr>
                        <th class="font-medium w-1/3">{language.image}</th>
                        <th class="font-medium w-1/2">{language.emotion}</th>
                        <th class="font-medium"></th>
                    </tr>
                    {#if characterStore.characters[$selectedCharID].emotionImages.length === 0}
                        <tr>
                            <td colspan="3">{language.noImages}</td>
                        </tr>
                    {:else}
                        {#each emos as emo, i}
                            <tr>
                                {#await getCharImage(emo[1], 'plain')}
                                    <td class="font-medium truncate w-1/3"></td>
                                {:then im}
                                    <td class="font-medium truncate w-1/3"><img src={im} alt="img" class="w-full"></td>                        
                                {/await}
                                <td class="font-medium truncate w-1/2">
                                    <TextInput marginBottom size='lg' bind:value={characterStore.characters[$selectedCharID].emotionImages[i][0]} />
                                </td>
                                <td>
                                    <button class="font-medium cursor-pointer hover:text-green-500" onclick={() => {
                                        rmCharEmotion($selectedCharID,i)
                                    }}><TrashIcon /></button>
                                </td>

                            </tr>
                        {/each}
                    {/if}
                    </tbody>
                </table>

            </div>

            <div class="text-textcolor2 hover:text-textcolor mt-2 flex">
                {#if !$addingEmotion}
                    <button class="cursor-pointer hover:text-green-500" onclick={() => {addCharEmotion($selectedCharID)}}>
                        <PlusIcon />
                    </button>
                {:else}
                    <span>Loading...</span>
                {/if}
            </div>

            {#if (characterStore.characters[$selectedCharID] as character).inlayViewScreen}
                <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
                <TextAreaInput highlight bind:value={(characterStore.characters[$selectedCharID] as character).newGenData.emotionInstructions} />
            {/if}

            <CheckInput bind:check={(characterStore.characters[$selectedCharID] as character).inlayViewScreen} name={language.inlayViewScreen} onChange={() => {
                if(characterStore.characters[$selectedCharID].type === 'character'){
                    if((characterStore.characters[$selectedCharID] as character).inlayViewScreen && (characterStore.characters[$selectedCharID] as character).additionalAssets === undefined){
                        (characterStore.characters[$selectedCharID] as character).additionalAssets = []
                    }else if(!(characterStore.characters[$selectedCharID] as character).inlayViewScreen && (characterStore.characters[$selectedCharID] as character).additionalAssets.length === 0){
                        (characterStore.characters[$selectedCharID] as character).additionalAssets = undefined
                    }
                    
                    characterStore.characters[$selectedCharID] = updateInlayScreen((characterStore.characters[$selectedCharID] as character))
                }
            }}/>
        {/if}
        {#if characterStore.characters[$selectedCharID].viewScreen === 'imggen'}
            <span class="text-textcolor mt-6">{language.imageGeneration} <Help key="imggen"/></span>
            <span class="text-textcolor2 text-xs">{language.emotionWarn}</span>
            
            <span class="text-textcolor mt-2">{language.imgGenPrompt}</span>
            <TextAreaInput highlight bind:value={(characterStore.characters[$selectedCharID] as character).newGenData.prompt} />
            <span class="text-textcolor mt-2">{language.imgGenNegatives}</span>
            <TextAreaInput highlight bind:value={(characterStore.characters[$selectedCharID] as character).newGenData.negative} />
            <span class="text-textcolor mt-2">{language.imgGenInstructions}</span>
            <TextAreaInput highlight bind:value={(characterStore.characters[$selectedCharID] as character).newGenData.instructions} />

            <CheckInput bind:check={(characterStore.characters[$selectedCharID] as character).inlayViewScreen} name={language.inlayViewScreen} onChange={() => {
                if((characterStore.characters[$selectedCharID] as character).type === 'character'){
                    (characterStore.characters[$selectedCharID] as character) = updateInlayScreen((characterStore.characters[$selectedCharID] as character))
                }
            }}/>
        {/if}
    {:else if viewSubMenu === 2}

            {#if settingsStore.state.newImageHandlingBeta}
            <CheckInput bind:check={characterStore.characters[$selectedCharID].prebuiltAssetCommand} name={language.insertAssetPrompt}/>

            {#if characterStore.characters[$selectedCharID].prebuiltAssetCommand}

            <span class="text-textcolor mt-2">{language.assetStyle}</span>
            <SelectInput className="mb-2" bind:value={characterStore.characters[$selectedCharID].prebuiltAssetStyle}>
                <OptionInput value="">{language.static}</OptionInput>
                <OptionInput value="dynamic">{language.dynamic}</OptionInput>
            </SelectInput>
            {/if}
            {/if}
            <div class="w-full max-w-full border border-selected rounded-md p-2 mt-2">
                <table class="contain w-full max-w-full tabler mt-2">
                <tbody>
                    <tr>
                        <th class="font-medium">{language.value}</th>
                        <th class="font-medium cursor-pointer w-10">
                            <button class="hover:text-green-500" onclick={async () => {
                                if(characterStore.characters[$selectedCharID].type === 'character'){
                                    const da = await selectMultipleFile(['png', 'webp', 'mp4', 'mp3', 'gif', 'jpeg', 'jpg', 'ttf', 'otf', 'css', 'webm', 'woff', 'woff2', 'svg', 'avif'])
                                    characterStore.characters[$selectedCharID].additionalAssets = characterStore.characters[$selectedCharID].additionalAssets ?? []
                                    if(!da){
                                        return
                                    }
                                    for(const f of da){
                                        const img = f.data
                                        const name = f.name
                                        const extension = name.split('.').pop().toLowerCase()
                                        const imgp = await saveAsset(img,'', extension)
                                        characterStore.characters[$selectedCharID].additionalAssets.push([name, imgp, extension])
                                        characterStore.characters[$selectedCharID].additionalAssets = characterStore.characters[$selectedCharID].additionalAssets
                                    }
                                }
                            }}>
                                <PlusIcon />
                            </button>
                        </th>
                    </tr>
                    {#if (!characterStore.characters[$selectedCharID].additionalAssets) || characterStore.characters[$selectedCharID].additionalAssets.length === 0}
                        <tr>
                            <td class="text-textcolor2"> No Assets</td>
                        </tr>
                    {:else}
                        {#each characterStore.characters[$selectedCharID].additionalAssets as assets, i}
                            <tr>
                                <td class="font-medium truncate">
                                    {#if assetFilePath[i] && settingsStore.state.useAdditionalAssetsPreview}
                                        {#if ['mp4', 'webm', 'mkv', 'mov', 'avi'].includes(assetFileExtensions[i])}
                                        <!-- svelte-ignore a11y_media_has_caption -->
                                            <video controls class="mt-2 px-2 w-full m-1 rounded-md"><source src={assetFilePath[i]} type={getMimeType(assetFileExtensions[i])}></video>
                                        {:else if ['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(assetFileExtensions[i])}
                                            <audio controls class="mt-2 px-2 w-full h-16 m-1 rounded-md" loop><source src={assetFilePath[i]} type={getMimeType(assetFileExtensions[i])}></audio>
                                        {:else if ['png', 'webp', 'jpeg', 'jpg', 'gif', 'avif', 'svg', 'bmp'].includes(assetFileExtensions[i])}
                                            <img src={assetFilePath[i]} class="w-16 h-16 m-1 rounded-md" alt={assets[0]}/>
                                        {/if}
                                    {/if}
                                    <TextInput size="sm" marginBottom bind:value={characterStore.characters[$selectedCharID].additionalAssets[i][0]} placeholder="..." />
                                </td>
                                
                                <th class="font-medium cursor-pointer w-10">
                                    <button class="hover:text-blue-500" onclick={() => {
                                        if(characterStore.characters[$selectedCharID].type === 'character'){
                                            characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].fmIndex = -1
                                            let additionalAssets = characterStore.characters[$selectedCharID].additionalAssets
                                            additionalAssets.splice(i, 1)
                                            characterStore.characters[$selectedCharID].additionalAssets = additionalAssets
                                        }
                                    }}>
                                        <TrashIcon />
                                    </button>
                                    {#if settingsStore.state.useAdditionalAssetsPreview}
                                        <button class="hover:text-blue-500" class:text-textcolor2={characterStore.characters[$selectedCharID].prebuiltAssetExclude?.includes?.(assets[1])} onclick={() => {
                                            characterStore.characters[$selectedCharID].prebuiltAssetExclude ??= []
                                            if(characterStore.characters[$selectedCharID].prebuiltAssetExclude.includes(assets[1])){
                                                characterStore.characters[$selectedCharID].prebuiltAssetExclude = characterStore.characters[$selectedCharID].prebuiltAssetExclude.filter((e) => e !== assets[1])
                                            }
                                            else {
                                                characterStore.characters[$selectedCharID].prebuiltAssetExclude.push(assets[1])
                                            }
                                        }}>
                                            {#if characterStore.characters[$selectedCharID]?.prebuiltAssetExclude?.includes?.(assets[1])}
                                                <ImageOffIcon />
                                             {:else}
                                                <ImageIcon />
                                            {/if}
                                        </button>
                                    {/if}
                                </th>
                            </tr>
                        {/each}
                    {/if}
                </tbody>
                </table>
            </div>
    {/if}
{:else if $CharConfigSubMenu === 3}
    {#if !$MobileGUI}
        <h2 class="mb-2 text-2xl font-bold mt-2">{language.loreBook} <Help key="lorebook"/></h2>
    {/if}
    <LoreBook />
{:else if $CharConfigSubMenu === 4}
    {#if characterStore.characters[$selectedCharID].type === 'character'}
        {#if !$MobileGUI}
            <h2 class="mb-2 text-2xl font-bold mt-2">{language.scripts}</h2>
        {/if}

        <span class="text-textcolor mt-2">{language.backgroundHTML} <Help key="backgroundHTML" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].backgroundHTML}></TextAreaInput>

        <span class="text-textcolor mt-4">{language.regexScript} <Help key="regexScript"/></span>
        <RegexList bind:value={characterStore.characters[$selectedCharID].customscript} />
        <div class="text-textcolor2 mt-2 flex gap-2">
            <button class="font-medium cursor-pointer hover:text-green-500" onclick={() => {
                if(characterStore.characters[$selectedCharID].type === 'character'){
                    let script = characterStore.characters[$selectedCharID].customscript
                    script.push({
                    comment: "",
                    in: "",
                    out: "",
                    type: "editinput"
                    })
                    characterStore.characters[$selectedCharID].customscript = script
                }
            }}><PlusIcon /></button>
            <button class="font-medium cursor-pointer hover:text-green-500" onclick={() => {
                exportRegex(characterStore.characters[$selectedCharID].customscript)
            }}><DownloadIcon /></button>
            <button class="font-medium cursor-pointer hover:text-green-500" onclick={async () => {
                characterStore.characters[$selectedCharID].customscript = await importRegex(characterStore.characters[$selectedCharID].customscript)
            }}><HardDriveUploadIcon /></button>
        </div>

        <span class="text-textcolor mt-4">{language.triggerScript} <Help key="triggerScript"/></span>
        <TriggerList bind:value={(characterStore.characters[$selectedCharID] as character).triggerscript} lowLevelAble={characterStore.characters[$selectedCharID].lowLevelAccess} />


        {#if characterStore.characters[$selectedCharID].virtualscript || settingsStore.state.showUnrecommended}
            <span class="text-textcolor mt-4">{language.charjs} <Help key="charjs" unrecommended/></span>
            <TextAreaInput margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].virtualscript}></TextAreaInput>
        {/if}
    {/if}
{:else if $CharConfigSubMenu === 6}

    {#if characterStore.characters[$selectedCharID].license !== 'CC BY-NC-SA 4.0'
    && characterStore.characters[$selectedCharID].license !== 'CC BY-SA 4.0'
    }
        <Button size="lg" onclick={async () => {
            if(await alertTOS()){
                $ShowRealmFrameStore = 'character'
            }
        }} className="mt-2">
            {#if characterStore.characters[$selectedCharID].realmId}
                {language.updateRealm}
            {:else}
                {language.shareCloud}
            {/if}
        </Button>
    {/if}

    {#if characterStore.characters[$selectedCharID].license !== 'CC BY-NC-SA 4.0'
        && characterStore.characters[$selectedCharID].license !== 'CC BY-SA 4.0'
        && characterStore.characters[$selectedCharID].license !== 'CC BY-ND 4.0'
        && characterStore.characters[$selectedCharID].license !== 'CC BY-NC-ND 4.0'
        }
        <Button size="sm" onclick={async () => {
            const res = await exportChar($selectedCharID)
        }} className="mt-2">{language.exportCharacter}</Button>
    {/if}

    <Button onclick={async () => {
        removeChar($selectedCharID, characterStore.characters[$selectedCharID].name)
    }} className="mt-2" size="sm">{ characterStore.characters[$selectedCharID].type === 'group' ? language.removeGroup : language.removeCharacter}</Button>
    
{:else if $CharConfigSubMenu === 5}
    {#if characterStore.characters[$selectedCharID].type === 'character'}
        {#if !$MobileGUI}
            <h2 class="mb-2 text-2xl font-bold mt-2">TTS</h2>
        {/if}
        <span class="text-textcolor">{language.provider}</span>
        <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].ttsMode} onchange={(e) => {
            if(characterStore.characters[$selectedCharID].type === 'character'){
                (characterStore.characters[$selectedCharID] as character).ttsSpeech = ''
            }
        }}>
            <OptionInput value="">{language.disabled}</OptionInput>
            <OptionInput value="elevenlab">ElevenLabs</OptionInput>
            <OptionInput value="webspeech">Web Speech</OptionInput>
            <OptionInput value="VOICEVOX">VOICEVOX</OptionInput>
            <OptionInput value="openai">OpenAI</OptionInput>
            <OptionInput value="novelai">NovelAI</OptionInput>
            <OptionInput value="huggingface">Huggingface</OptionInput>
            <OptionInput value="vits">VITS</OptionInput>
            <OptionInput value="gptsovits">GPT-SoVITS</OptionInput>
            <OptionInput value="fishspeech">fish-speech</OptionInput>
        </SelectInput>
        

        {#if characterStore.characters[$selectedCharID].ttsMode === 'webspeech'}
            {#if !speechSynthesis}
                <span class="text-textcolor">Web Speech isn't supported in your browser or OS</span>
            {:else}
                <span class="text-textcolor">{language.Speech}</span>
                <SelectInput className="mb-4 mt-2" bind:value={(characterStore.characters[$selectedCharID] as character).ttsSpeech}>
                    <OptionInput value="">Auto</OptionInput>
                    {#each getWebSpeechTTSVoices() as voice}
                        <OptionInput value={voice}>{voice}</OptionInput>
                    {/each}
                </SelectInput>
                {#if (characterStore.characters[$selectedCharID] as character).ttsSpeech !== ''}
                    <span class="text-red-400 text-sm">If you do not set it to Auto, it may not work properly when importing from another OS or browser.</span>
                {/if}
            {/if}
        {:else if characterStore.characters[$selectedCharID].ttsMode === 'elevenlab'}
            <span class="text-sm mb-2 text-textcolor2">Please set the ElevenLabs API key in "global Settings → Bot Settings → Others → ElevenLabs API key"</span>
            {#await getElevenTTSVoices() then voices}
                <span class="text-textcolor">{language.Speech}</span>
                <SelectInput className="mb-4 mt-2" bind:value={(characterStore.characters[$selectedCharID] as character).ttsSpeech}>
                    <OptionInput value="">Unset</OptionInput>
                        {#each voices as voice}
                            <OptionInput value={voice.voice_id}>{voice.name}</OptionInput>
                        {/each}
                </SelectInput>
            {/await}
         {:else if characterStore.characters[$selectedCharID].ttsMode === 'VOICEVOX'}
                <span class="text-textcolor">Speaker</span>
                <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].voicevoxConfig.speaker}>
                    {#await getVOICEVOXVoices() then voices}
                        {#each voices as voice}
                            <OptionInput value={voice.list}  selected={characterStore.characters[$selectedCharID].voicevoxConfig.speaker === voice.list}>{voice.name}</OptionInput>
                        {/each}
                    {/await}
                </SelectInput>
                {#if characterStore.characters[$selectedCharID].voicevoxConfig.speaker}
                <span class="text=neutral-200">Style</span>
                <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].ttsSpeech}>
                {#each JSON.parse(characterStore.characters[$selectedCharID].voicevoxConfig.speaker) as styles}
                        <OptionInput value={styles.id} selected={characterStore.characters[$selectedCharID].ttsSpeech === styles.id}>{styles.name}</OptionInput>
                {/each}
                </SelectInput>
                {/if}
                <span class="text-textcolor">Speed scale</span>
                <NumberInput size={"sm"} marginBottom bind:value={characterStore.characters[$selectedCharID].voicevoxConfig.SPEED_SCALE}/>

                <span class="text-textcolor">Pitch scale</span>
                <NumberInput size={"sm"} marginBottom bind:value={characterStore.characters[$selectedCharID].voicevoxConfig.PITCH_SCALE}/>

                <span class="text-textcolor">Volume scale</span>
                <NumberInput size={"sm"} marginBottom bind:value={characterStore.characters[$selectedCharID].voicevoxConfig.VOLUME_SCALE}/>

                <span class="text-textcolor">Intonation scale</span>
                <NumberInput size={"sm"} marginBottom bind:value={characterStore.characters[$selectedCharID].voicevoxConfig.INTONATION_SCALE}/>
                <span class="text-sm mb-2 text-textcolor2">To use VOICEVOX, you need to run a colab and put the localtunnel URL in "Settings → Other Bots". https://colab.research.google.com/drive/1tyeXJSklNfjW-aZJAib1JfgOMFarAwze</span>
        {:else if characterStore.characters[$selectedCharID].ttsMode === 'novelai'}
            <span class="text-textcolor">Custom Voice Seed</span>
            <Check bind:check={characterStore.characters[$selectedCharID].naittsConfig.customvoice}/>
            {#if !characterStore.characters[$selectedCharID].naittsConfig.customvoice}
                <span class="text-textcolor">Voice</span>
                <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].naittsConfig.voice}>
                    {#await getNovelAIVoices() then voices}
                        {#each voices as voiceGroup}
                            <optgroup label={voiceGroup.gender} class="bg-darkbg appearance-none">
                                {#each voiceGroup.voices as voice}
                                    <OptionInput value={voice} selected={characterStore.characters[$selectedCharID].naittsConfig.voice === voice}>{voice}</OptionInput>
                                {/each}
                            </optgroup>
                        {/each}
                    {/await}
                </SelectInput>
            {:else}
                <span class="text-textcolor">Voice</span>
                <TextInput size={"sm"} bind:value={characterStore.characters[$selectedCharID].naittsConfig.voice}/>
            {/if}
            <span class="text-textcolor">Version</span>
            <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].naittsConfig.version}>
                <OptionInput value="v1">v1</OptionInput>
                <OptionInput value="v2">v2</OptionInput>
            </SelectInput>
        {:else if characterStore.characters[$selectedCharID].ttsMode === 'openai'}
            <span class="text-textcolor">Voice</span>
            {#if !characterStore.characters[$selectedCharID].oaiTTSConfig?.enabled}
                <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].oaiVoice}>
                    <OptionInput value="">Unset</OptionInput>
                    {#each oaiVoices as voice}
                        <OptionInput value={voice}>{voice}</OptionInput>
                    {/each}
                </SelectInput>
            {:else}
                <TextInput className="mb-4 mt-2"
                    bind:value={characterStore.characters[$selectedCharID].oaiTTSConfig.voice}
                    placeholder={characterStore.characters[$selectedCharID].oaiVoice || 'alloy'} />
            {/if}

            <span class="text-textcolor">Advanced (OpenAI-compatible endpoint)</span>
            <Check bind:check={characterStore.characters[$selectedCharID].oaiTTSConfig.enabled} />

            {#if characterStore.characters[$selectedCharID].oaiTTSConfig?.enabled}
                <span class="text-textcolor">Base URL</span>
                <TextInput className="mb-4 mt-2"
                    bind:value={characterStore.characters[$selectedCharID].oaiTTSConfig.baseURL}
                    placeholder="https://api.openai.com/v1" />

                <span class="text-textcolor">API Key (overrides global)</span>
                <TextInput className="mb-4 mt-2" hideText={settingsStore.state.hideApiKey}
                    bind:value={characterStore.characters[$selectedCharID].oaiTTSConfig.apiKey}
                    placeholder="Leave empty to use global OpenAI API key" />

                <span class="text-textcolor">Model</span>
                <TextInput className="mb-4 mt-2"
                    bind:value={characterStore.characters[$selectedCharID].oaiTTSConfig.model}
                    placeholder="tts-1" />

                <span class="text-textcolor">Response Format</span>
                <SelectInput className="mb-4 mt-2"
                    bind:value={characterStore.characters[$selectedCharID].oaiTTSConfig.format}>
                    <OptionInput value="mp3">mp3</OptionInput>
                    <OptionInput value="opus">opus</OptionInput>
                    <OptionInput value="aac">aac</OptionInput>
                    <OptionInput value="flac">flac</OptionInput>
                    <OptionInput value="wav">wav</OptionInput>
                    <OptionInput value="pcm">pcm</OptionInput>
                </SelectInput>
            {/if}
        {:else if characterStore.characters[$selectedCharID].ttsMode === 'huggingface'}
            <span class="text-textcolor">Model</span>
            <TextInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].hfTTS.model} />

            <span class="text-textcolor">Language</span>
            <TextInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].hfTTS.language} placeholder="en" />
        {:else if characterStore.characters[$selectedCharID].ttsMode === 'vits'}
            {#if characterStore.characters[$selectedCharID].vits}
                <span class="text-textcolor">{characterStore.characters[$selectedCharID].vits.name ?? 'Unnamed VitsModel'}</span>
            {:else}
                <span class="text-textcolor">No Model</span>
            {/if}
            <Button onclick={async () => {
                const { registerOnnxModel } = await import('src/ts/process/transformers')
                const model = await registerOnnxModel()
                if(model && characterStore.characters[$selectedCharID].type === 'character'){
                    characterStore.characters[$selectedCharID].vits = model
                }
            }}>{language.selectModel}</Button>
        {:else if characterStore.characters[$selectedCharID].ttsMode === 'gptsovits'}
            <span class="text-textcolor">Volume</span>
            <SliderInput min={0.0} max={1.0} step={0.01} fixed={2} bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.volume}/>
            <span class="text-textcolor">URL</span>
            <TextInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.url}/>

            <span class="text-textcolor">Use Auto Path</span>
            <Check bind:check={characterStore.characters[$selectedCharID].gptSoVitsConfig.use_auto_path}/>

            {#if !characterStore.characters[$selectedCharID].gptSoVitsConfig.use_auto_path}
                <span class="text-textcolor">Reference Audio Path (e.g. C:/Users/user/Downloads/GPT-SoVITS-v2-240821)</span>
                <TextInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.ref_audio_path}/>
            {/if}

            <span class="text-textcolor">Use Long Audio</span>
            <Check bind:check={characterStore.characters[$selectedCharID].gptSoVitsConfig.use_long_audio}/>

            <span class="text-textcolor">Reference Audio Data (3~10s audio file)</span>
            <Button onclick={async () => {
                const audio = await selectSingleFile([
                    'wav',
                    'ogg',
                    'aac',
                    'mp3'
                ])
                if(!audio){
                    return null
                }
                const saveId = await saveAsset(audio.data)
                characterStore.characters[$selectedCharID].gptSoVitsConfig.ref_audio_data = {
                    fileName: audio.name,
                    assetId: saveId
                }

            }}
            className="h-10">
                
                {#if characterStore.characters[$selectedCharID].gptSoVitsConfig.ref_audio_data.assetId === '' || characterStore.characters[$selectedCharID].gptSoVitsConfig.ref_audio_data.assetId === undefined}
                    {language.selectFile}
                {:else}
                    {characterStore.characters[$selectedCharID].gptSoVitsConfig.ref_audio_data.fileName}
                {/if}
            </Button>
            <span class="text-textcolor">Text Language</span>
            <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.text_lang}>
                <OptionInput value="auto">Multi-language Mixed</OptionInput>
                <OptionInput value="auto_yue">Multi-language Mixed (Cantonese)</OptionInput>
                <OptionInput value="en">English</OptionInput>
                <OptionInput value="zh">Chinese-English Mixed</OptionInput>
                <OptionInput value="ja">Japanese-English Mixed</OptionInput>
                <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
                <OptionInput value="ko">Korean-English Mixed</OptionInput>
                <OptionInput value="all_zh">Chinese</OptionInput>
                <OptionInput value="all_ja">Japanese</OptionInput>
                <OptionInput value="all_yue">Cantonese</OptionInput>
                <OptionInput value="all_ko">Korean</OptionInput>
            </SelectInput>

            {#if !characterStore.characters[$selectedCharID].gptSoVitsConfig.use_long_audio}
                <span class="text-textcolor">Use Reference Audio Script</span>
                <Check bind:check={characterStore.characters[$selectedCharID].gptSoVitsConfig.use_prompt}/>
            {/if}

            {#if characterStore.characters[$selectedCharID].gptSoVitsConfig.use_prompt && !characterStore.characters[$selectedCharID].gptSoVitsConfig.use_long_audio}
                <span class="text-textcolor">Reference Audio Script</span>
                <TextAreaInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.prompt}/>
            {/if}

            <span class="text-textcolor">Reference Audio Language</span>
            <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.prompt_lang}>
                <OptionInput value="auto">Multi-language Mixed</OptionInput>
                <OptionInput value="auto_yue">Multi-language Mixed (Cantonese)</OptionInput>
                <OptionInput value="en">English</OptionInput>
                <OptionInput value="zh">Chinese-English Mixed</OptionInput>
                <OptionInput value="ja">Japanese-English Mixed</OptionInput>
                <OptionInput value="yue">Cantonese-English Mixed</OptionInput>
                <OptionInput value="ko">Korean-English Mixed</OptionInput>
                <OptionInput value="all_zh">Chinese</OptionInput>
                <OptionInput value="all_ja">Japanese</OptionInput>
                <OptionInput value="all_yue">Cantonese</OptionInput>
                <OptionInput value="all_ko">Korean</OptionInput>
            </SelectInput>
            <span class="text-textcolor">Top P</span>
            <SliderInput min={0.0} max={1.0} step={0.05} fixed={2} bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.top_p}/>

            <span class="text-textcolor">Temperature</span>
            <SliderInput min={0.0} max={1.0} step={0.05} fixed={2} bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.temperature}/>

            <span class="text-textcolor">Speed</span>
            <SliderInput min={0.6} max={1.65} step={0.05} fixed={2} bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.speed}/>

            <span class="text-textcolor">Top K</span>
            <SliderInput min={1} max={100} step={1} bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.top_k}/>

            <span class="text-textcolor">Text Split Method</span>
            <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].gptSoVitsConfig.text_split_method}>
                <OptionInput value="cut0">Cut 0 (No splitting)</OptionInput>
                <OptionInput value="cut1">Cut 1 (Split every 4 sentences)</OptionInput>
                <OptionInput value="cut2">Cut 2 (Split every 50 characters)</OptionInput>
                <OptionInput value="cut3">Cut 3 (Split by Chinese periods)</OptionInput>
                <OptionInput value="cut4">Cut 4 (Split by English periods)</OptionInput>
                <OptionInput value="cut5">Cut 5 (Split by various punctuation marks)</OptionInput>
            </SelectInput>        
        {:else if characterStore.characters[$selectedCharID].ttsMode === 'fishspeech'}
            {#await getFishSpeechModels()}
                <span class="text-textcolor">Loading...</span>
            {:then}
                <span class="text-textcolor">Model</span>
                <SelectInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].fishSpeechConfig.model._id}>
                    <OptionInput value="">Not selected</OptionInput>
                    {#each fishSpeechModels as model}
                        <OptionInput value={model._id}>
                            <div class="flex items-center">
                                <span>{model.title}</span>
                                <span class="text-sm text-textcolor2">{model.description}</span>
                            </div>
                        </OptionInput>
                    {/each}
                </SelectInput>
            {:catch}
                <span class="text-textcolor">An error occurred while fetching the models.</span>
            {/await}

            <span class="text-textcolor">Chunk Length</span>
            <NumberInput className="mb-4 mt-2" bind:value={characterStore.characters[$selectedCharID].fishSpeechConfig.chunk_length}/>

            <span class="mt-2 text-textcolor">Normalize</span>
            <Check className="mb-4 mt-2" bind:check={characterStore.characters[$selectedCharID].fishSpeechConfig.normalize}/>
        {/if}
        {#if characterStore.characters[$selectedCharID].ttsMode}
            <div class="flex items-center mt-2">
                <Check bind:check={characterStore.characters[$selectedCharID].ttsReadOnlyQuoted} name={language.ttsReadOnlyQuoted}/>
            </div>
        {/if}
    {/if}
{:else if $CharConfigSubMenu === 2}
    {#if !$MobileGUI}
        <h2 class="mb-2 text-2xl font-bold mt-2">{language.advancedSettings}</h2>
    {/if}
        {#if characterStore.characters[$selectedCharID].type !== 'group'}
        <span class="text-textcolor mt-2">Bias <Help key="bias"/></span>
        <div class="w-full max-w-full border border-selected rounded-md p-2 mb-2">

        <table class="w-full max-w-full tabler mt-2">
            <tbody>
            <tr>
                <th class="font-medium w-1/2">Bias</th>
                <th class="font-medium w-1/3">{language.value}</th>
                <th>
                    <button class="font-medium cursor-pointer hover:text-green-500" onclick={() => {
                        if(characterStore.characters[$selectedCharID].type === 'character'){
                            (characterStore.characters[$selectedCharID] as character).bias.push(['', 0])
                        }
                    }}><PlusIcon /></button>
                </th>
            </tr>
            {#if (characterStore.characters[$selectedCharID] as character).bias.length === 0}
                <tr>
                    <td colspan="3">{language.noBias}</td>

                </tr>
            {/if}
            {#each (characterStore.characters[$selectedCharID] as character).bias as bias, i}
                <tr class="align-middle text-center">
                    <td class="font-medium truncate w-1/2">
                        <TextInput fullh fullwidth bind:value={(characterStore.characters[$selectedCharID] as character).bias[i][0]} placeholder="string" />
                    </td> 
                    <td class="font-medium truncate w-1/3">
                        <NumberInput fullh fullwidth bind:value={(characterStore.characters[$selectedCharID] as character).bias[i][1]} max={100} min={-100} />
                    </td>
                    <td>
                        <button class="font-medium flex justify-center items-center w-full h-full cursor-pointer hover:text-green-500" onclick={() => {
                            if(characterStore.characters[$selectedCharID].type === 'character'){
                                (characterStore.characters[$selectedCharID] as character).bias.splice(i, 1)
                            }
                        }}><TrashIcon /></button>
                    </td>
                </tr>
            {/each}
            </tbody>
            
        </table>
        </div>

        <span class="text-textcolor">{language.exampleMessage} <Help key="exampleMessage"/></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].exampleMessage}></TextAreaInput>

        <span class="text-textcolor">{language.creatorNotes} <Help key="creatorQuotes"/></span>
        <MultiLangInput bind:value={characterStore.characters[$selectedCharID].creatorNotes} className="my-2" onInput={() => {
            characterStore.characters[$selectedCharID].removedQuotes = false
        }}></MultiLangInput>

        <span class="text-textcolor">{language.systemPrompt} <Help key="systemPrompt"/></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].systemPrompt}></TextAreaInput>

        <span class="text-textcolor">{language.replaceGlobalNote} <Help key="replaceGlobalNote"/></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].replaceGlobalNote}></TextAreaInput>

        <span class="text-textcolor mt-2">{language.additionalText} <Help key="additionalText" /></span>
        <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].additionalText}></TextAreaInput>

        {#if settingsStore.state.showUnrecommended || characterStore.characters[$selectedCharID].personality.length > 3}
            <span class="text-textcolor">{language.personality} <Help key="personality" unrecommended/></span>
            <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].personality}></TextAreaInput>
        {/if}
        {#if settingsStore.state.showUnrecommended || characterStore.characters[$selectedCharID].scenario.length > 3}
            <span class="text-textcolor">{language.scenario} <Help key="scenario" unrecommended/></span>
            <TextAreaInput highlight margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].scenario}></TextAreaInput>
        {/if}

        <span class="text-textcolor mt-2">{language.defaultVariables} <Help key="defaultVariables" /></span>
        <TextAreaInput margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].defaultVariables}></TextAreaInput>

        <span class="text-textcolor mt-2">{language.translatorNote} <Help key="translatorNote" /></span>
        <TextAreaInput margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].translatorNote}></TextAreaInput>

        <span class="text-textcolor mt-2">{language.customPromptTemplateToggle} <Help key="customPromptTemplateToggle" /></span>
        <TextAreaInput margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].customModuleToggle}></TextAreaInput>

        <span class="text-textcolor">{language.creator}</span>
        <TextInput size="sm" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].additionalData.creator} />

        <span class="text-textcolor">{language.CharVersion}</span>
        <TextInput size="sm" bind:value={characterStore.characters[$selectedCharID].additionalData.character_version}/>

        <span class="text-textcolor">{language.nickname} <Help key="nickname" /></span>
        <TextInput size="sm" bind:value={characterStore.characters[$selectedCharID].nickname}/>

        <span class="text-textcolor">{language.depthPrompt}</span>
        <div class="flex justify-center items-center">
            <NumberInput size="sm" bind:value={characterStore.characters[$selectedCharID].depth_prompt.depth} className="w-12"/>
            <TextInput size="sm" bind:value={characterStore.characters[$selectedCharID].depth_prompt.prompt} className="flex-1"/>
        </div>

        <span class="text-textcolor mt-2">{language.altGreet}</span>
        <div class="w-full max-w-full border border-selected rounded-md p-2">
            <table class="contain w-full max-w-full tabler mt-2">
                <tbody>
                <tr>
                    <th class="font-medium">{language.value}</th>
                    <th class="font-medium cursor-pointer w-8">
                        <button class="hover:text-green-500" onclick={() => {
                            if(characterStore.characters[$selectedCharID].type === 'character'){
                                let alternateGreetings = characterStore.characters[$selectedCharID].alternateGreetings
                                alternateGreetings.push('')
                                characterStore.characters[$selectedCharID].alternateGreetings = alternateGreetings
                            }
                        }}>
                            <PlusIcon />
                        </button>
                    </th>
                </tr>
                {#if characterStore.characters[$selectedCharID].alternateGreetings.length === 0}
                    <tr>
                        <td colspan="3">{language.noData}</td>
                    </tr>
                {/if}
                {#each characterStore.characters[$selectedCharID].alternateGreetings as bias, i}
                    <tr>
                        <td class="font-medium truncate">
                            <TextAreaInput highlight bind:value={characterStore.characters[$selectedCharID].alternateGreetings[i]} placeholder="..." fullwidth />
                        </td>
                        <th class="font-medium cursor-pointer w-8">
                            <div class="flex flex-col items-center">
                                <button class="hover:text-blue-500 p-1" onclick={() => moveAlternateGreetingUp(i)} disabled={i === 0}>
                                    <ArrowUp size={16} />
                                </button>
                                <button class="hover:text-blue-500 p-1" onclick={() => moveAlternateGreetingDown(i)} disabled={i === characterStore.characters[$selectedCharID].alternateGreetings.length - 1}>
                                    <ArrowDown size={16} />
                                </button>
                                <button class="hover:text-red-500 p-1" onclick={() => {
                                    if(characterStore.characters[$selectedCharID].type === 'character'){
                                        characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].fmIndex = -1
                                        let alternateGreetings = characterStore.characters[$selectedCharID].alternateGreetings
                                        alternateGreetings.splice(i, 1)
                                        characterStore.characters[$selectedCharID].alternateGreetings = alternateGreetings
                                    }
                                }}>
                                    <TrashIcon size={16} />
                                </button>
                            </div>
                        </th>
                    </tr>
                {/each}
            </tbody>
            </table>
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={characterStore.characters[$selectedCharID].lowLevelAccess} name={language.lowLevelAccess}/>
            <span> <Help key="lowLevelAccess" name={language.lowLevelAccess}/></span>
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={characterStore.characters[$selectedCharID].hideChatIcon} name={language.hideChatIcon}/>
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={characterStore.characters[$selectedCharID].utilityBot} name={language.utilityBot}/>
            <span> <Help key="utilityBot" name={language.utilityBot}/></span>
        </div>

        <div class="flex items-center mt-4">
            <Check bind:check={characterStore.characters[$selectedCharID].escapeOutput} name={language.escapeOutput}/>
        </div>

        {#if settingsStore.state.supaModelType !== 'none' && settingsStore.state.hypav2}
            <Button
                onclick={() => {
                    characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].hypaV2Data ??= {
                        lastMainChunkID: 0,
                        mainChunks: [],
                        chunks: [],
                    }
                    showHypaV2Alert()
                }}
                className="mt-4"
            >
                {language.hypaMemoryV2Modal}
            </Button>
        {:else if settingsStore.state.hypaV3}
            <Button
                onclick={() => {
                    $hypaV3ModalOpen = true
                }}
                className="mt-4"
            >
                {language.hypaMemoryV3Modal}
            </Button>
        {:else if characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].supaMemoryData && characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].supaMemoryData.length > 4 || characterStore.characters[$selectedCharID].supaMemory}
            <span class="text-textcolor mt-4">{language.SuperMemory}</span>
            <TextAreaInput margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].supaMemoryData}></TextAreaInput>
        {/if}

        <Button
            onclick={applyModule}
            className="mt-4"
        >
            {language.applyModule}
        </Button>

        <Button
            onclick={async () => {
                const char = getCurrentCharacter()
                if(char.type === 'group'){
                    return
                }
                const m = convertCharacterToModule(char)
                const targetModules = moduleStore.modules ?? settingsStore.state.modules
                targetModules.push(m)
                alertNormal(language.successfullyConverted)
            }}
            className="mt-4"
        >
            {language.convertToModule}
        </Button>
    {:else}
        {#if characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].supaMemoryData && characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].supaMemoryData.length > 4 || characterStore.characters[$selectedCharID].supaMemory}
            <span class="text-textcolor mt-4">{language.SuperMemory}</span>
            <TextAreaInput margin="both" autocomplete="off" bind:value={characterStore.characters[$selectedCharID].chats[characterStore.characters[$selectedCharID].chatPage].supaMemoryData}></TextAreaInput>
        {/if}

        <div class="flex items-center mt-4">
            <Check bind:check={characterStore.characters[$selectedCharID].lowLevelAccess} name={language.lowLevelAccess}/>
            <span> <Help key="lowLevelAccess" name={language.lowLevelAccess}/></span>
        </div>
    {/if}
{/if}


<style>

    .tabler {
    table-layout: fixed;
    }

    .tabler td {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .char-grid{
        display: grid;
        grid-template-columns: auto 1fr auto;
    }
</style>
