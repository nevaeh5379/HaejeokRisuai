<script lang="ts">

    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import Help from "src/lib/Others/Help.svelte";
    
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
    import { customProviderStore } from "src/ts/plugins/plugins.svelte";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { isTauri } from "src/ts/platform"
    import { tokenizeAccurate, tokenizerList } from "src/ts/tokenizer";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import DropList from "src/lib/SideBars/DropList.svelte";
    import { PlusIcon, TrashIcon, HardDriveUploadIcon, DownloadIcon, UploadIcon, KeyIcon, BotIcon, SparkleIcon, SlidersHorizontal, CpuIcon, RadioIcon, LayersIcon, ChevronDownIcon, ChevronUpIcon } from "@lucide/svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import { getOpenRouterModels, toModelGridItem as orToGridItem } from "src/ts/model/openrouter";
    import { getNanoGPTModels, getNanoGPTSubscriptionModels, toModelGridItem as ngToGridItem } from "src/ts/model/nanogpt";
    import { getOllamaModels } from "src/ts/model/ollama";
    import ModelGrid from "src/lib/UI/ModelGrid.svelte";
    import NanoGPTDashboard from "src/lib/UI/NanoGPTDashboard.svelte";
    import NanoGPTProviderPicker from "src/lib/UI/NanoGPTProviderPicker.svelte";
    import type { ModelGridPinnedItem } from "src/ts/model/modelGrid";
    import { getMimeType } from "src/ts/media";
    import OobaSettings from "./OobaSettings.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import OpenrouterSettings from "./OpenrouterSettings.svelte";
    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    import PromptSettings from "./PromptSettings.svelte";
    import { openPresetList } from "src/ts/stores.svelte";
    import { selectSingleFile } from "src/ts/util";
    import { getModelInfo, LLMFlags, LLMFormat, LLMProvider } from "src/ts/model/modellist";
    import { saveCurrentPreset } from "src/ts/storage/database.svelte";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { allBasicParameterItems } from "src/ts/setting/botSettingsParamsData";
    import SeparateParametersSection from "./SeparateParametersSection.svelte";
    import AuxModelSelectors from './Model/AuxModelSelectors.svelte'
    import ModelBrowser from "src/lib/UI/Model/ModelBrowser.svelte";

    let modelTab = $state<'main' | 'sub' | 'provider'>('main');
    let auxSubTab = $state<'memory' | 'translate' | 'emotion' | 'otherAx'>('memory');
    let openProviders = $state<Record<string, boolean>>({});
    
    const openrouterPinnedItems: ModelGridPinnedItem[] = [
        { id: 'risu/free',       displayName: 'Free Auto',       providerName: 'Risu'       },
        { id: 'openrouter/auto', displayName: 'OpenRouter Auto', providerName: 'OpenRouter' },
    ]

    // Reset model selection and display name when subscription mode toggles
    let _nanogptSubModeInitialized = false
    $effect(() => {
        const _sub = settingsStore.state.nanogptUseSubscriptionEndpoint
        if (!_nanogptSubModeInitialized) { _nanogptSubModeInitialized = true; return }
        settingsStore.state.nanogptRequestModel = ''
        settingsStore.state.nanogptRequestModelName = ''
    })

    // Reset provider selection to Auto when the model or subscription mode changes
    let _nanogptProviderResetInitialized = false
    $effect(() => {
        const _model = settingsStore.state.nanogptRequestModel
        const _sub   = settingsStore.state.nanogptUseSubscriptionEndpoint
        if (!_nanogptProviderResetInitialized) { _nanogptProviderResetInitialized = true; return }
        settingsStore.state.nanogptProvider = ''
    })

    // Reset subscription mode (and related state) when API key is cleared
    let _nanogptKeyInitialized = false
    $effect(() => {
        const _key = settingsStore.state.nanogptKey
        if (!_nanogptKeyInitialized) { _nanogptKeyInitialized = true; return }
        if (!_key) {
            settingsStore.state.nanogptUseSubscriptionEndpoint = false
            settingsStore.state.nanogptSubscriptionState = ''
            settingsStore.state.nanogptRequestModel = ''
            settingsStore.state.nanogptRequestModelName = ''
            settingsStore.state.nanogptProvider = ''
        }
    })

    let tokens = $state({
        mainPrompt: 0,
        jailbreak: 0,
        globalNote: 0,
    })

    interface Props {
        goPromptTemplate?: any;
        targetSubmenu?: number;
        targetModelTab?: 'main' | 'sub' | 'provider';
        hideTabs?: boolean;
    }

    let { goPromptTemplate = () => {}, targetSubmenu, targetModelTab, hideTabs = false }: Props = $props();

    async function loadTokenize(){
        tokens.mainPrompt = await tokenizeAccurate(settingsStore.state.mainPrompt, true)
        tokens.jailbreak = await tokenizeAccurate(settingsStore.state.jailbreak, true)
        tokens.globalNote = await tokenizeAccurate(settingsStore.state.globalNote, true)
    }

    $effect.pre(() => {
        if(settingsStore.state.aiModel === 'textgen_webui' || settingsStore.state.subModel === 'mancer'){
            settingsStore.state.useStreaming = settingsStore.state.textgenWebUIStreamURL.startsWith("wss://")
        }
    });

    function clearVertexToken() {
        settingsStore.state.vertexAccessToken = '';
        settingsStore.state.vertexAccessTokenExpires = 0;
        console.log('Vertex AI token cleared');
    }

    function persistModelSelection() {
        void saveCurrentPreset();
    }


    let submenu = $state(settingsStore.state.useLegacyGUI ? -1 : 0)
    $effect(() => {
        if (targetSubmenu !== undefined && !settingsStore.state.useLegacyGUI) {
            submenu = targetSubmenu
        }
        if (targetModelTab !== undefined) {
            modelTab = targetModelTab
        }
    })
    let modelInfo = $derived(getModelInfo(settingsStore.state.aiModel))
    let subModelInfo = $derived(getModelInfo(settingsStore.state.subModel))
    let nanogptInputMode = $state<'list' | 'manual'>(settingsStore.state.nanogptRequestModel && !settingsStore.state.nanogptRequestModelName ? 'manual' : 'list')
    // svelte-ignore state_referenced_locally
    let prevNanogptInputMode = nanogptInputMode;
    $effect(() => {
        if (nanogptInputMode !== prevNanogptInputMode) {
            settingsStore.state.nanogptRequestModel = '';
            settingsStore.state.nanogptRequestModelName = '';
            prevNanogptInputMode = nanogptInputMode;
        }
    });

    let usesOllamaLocal = $derived(settingsStore.state.aiModel === 'ollama-hosted' || settingsStore.state.subModel === 'ollama-hosted')
    let usesOllamaCloud = $derived(settingsStore.state.aiModel === 'ollama-cloud' || settingsStore.state.subModel === 'ollama-cloud')

    let activeProviders = $derived.by(() => {
        const set = new Set<LLMProvider>();
        if (modelInfo?.provider !== undefined) set.add(modelInfo.provider);
        if (subModelInfo?.provider !== undefined) set.add(subModelInfo.provider);
        if (settingsStore.state.seperateModelsForAxModels) {
            for (const key of ['memory', 'translate', 'emotion', 'otherAx'] as const) {
                const mId = settingsStore.state.seperateModels[key];
                if (mId) {
                    const info = getModelInfo(mId);
                    if (info?.provider !== undefined) set.add(info.provider);
                }
            }
        }
        return set;
    });

    let isProviderActive = (provider: LLMProvider) => activeProviders.has(provider);
    let usesGoogle = $derived(isProviderActive(LLMProvider.GoogleCloud));
    let usesVertex = $derived(isProviderActive(LLMProvider.VertexAI));
    let usesAnthropicOrAWS = $derived(isProviderActive(LLMProvider.Anthropic) || isProviderActive(LLMProvider.AWS));
    let usesOpenAI = $derived(isProviderActive(LLMProvider.OpenAI));
    let usesMistral = $derived(isProviderActive(LLMProvider.Mistral));
    let usesNovelAI = $derived(isProviderActive(LLMProvider.NovelAI));
    let usesNovelList = $derived(isProviderActive(LLMProvider.NovelList));
    let usesCohere = $derived(isProviderActive(LLMProvider.Cohere));
    let usesMancer = $derived(settingsStore.state.aiModel.startsWith('mancer') || settingsStore.state.subModel.startsWith('mancer'));
    let usesOpenRouter = $derived(settingsStore.state.aiModel === 'openrouter' || settingsStore.state.subModel === 'openrouter');
    let usesNanoGPT = $derived(settingsStore.state.aiModel === 'nanogpt' || settingsStore.state.subModel === 'nanogpt');
    let usesReverseProxy = $derived(settingsStore.state.aiModel === 'reverse_proxy' || settingsStore.state.subModel === 'reverse_proxy');
    let usesHorde = $derived(settingsStore.state.aiModel.startsWith('horde') || settingsStore.state.subModel.startsWith('horde'));
    let usesKobold = $derived(settingsStore.state.aiModel === 'kobold' || settingsStore.state.subModel === 'kobold');
    let usesTextGen = $derived(settingsStore.state.aiModel === 'textgen_webui' || settingsStore.state.subModel === 'textgen_webui');
    let usesOoba = $derived(settingsStore.state.aiModel === 'ooba' || settingsStore.state.subModel === 'ooba');
    let usesCustomPlugin = $derived(settingsStore.state.aiModel === 'custom' || settingsStore.state.subModel === 'custom');
    let usesEcho = $derived(settingsStore.state.aiModel === 'echo_model' || settingsStore.state.subModel === 'echo_model');
    
    let hasAnyProviderSettings = $derived(
        usesGoogle || usesVertex || usesAnthropicOrAWS || usesOpenAI || usesMistral ||
        usesNovelAI || usesNovelList || usesCohere || usesMancer || usesOpenRouter ||
        usesNanoGPT || usesReverseProxy || usesHorde || usesKobold || usesTextGen ||
        usesOoba || usesCustomPlugin || usesEcho || usesOllamaLocal || usesOllamaCloud ||
        !!modelInfo?.keyIdentifier || !!subModelInfo?.keyIdentifier
    );
    let currentSectionTitle = $derived.by(() => {
        if (submenu === 1) return language.parameters;
        if (submenu === 2) return language.prompt;
        if (submenu === 3) return language.others;
        if (submenu === 0 || submenu === -1) {
            if (modelTab === 'main') return language.mainModelCardTitle || language.model;
            if (modelTab === 'sub') return language.subModelCardTitle || language.submodel;
            if (modelTab === 'provider') return language.providerSettings || "API & Providers";
        }
        return '';
    });
</script>

<div class="mb-3 flex items-center justify-between">
    <div class="flex items-baseline gap-2.5">
        <h2 class="text-2xl font-bold">{language.chatBot}</h2>
        {#if hideTabs && currentSectionTitle}
            <span class="text-base font-medium text-textcolor2">/ {currentSectionTitle}</span>
        {/if}
    </div>
</div>

{#if !hideTabs && submenu !== -1}
    <div class="flex w-full rounded-xl border border-darkborderc overflow-hidden bg-darkbg/40 p-1 gap-1 mb-4">
        <button onclick={() => {
            submenu = 0
        }} class="py-2 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center {submenu === 0 ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}">
            <span>{language.model}</span>
        </button>
        <button onclick={() => {
            submenu = 1
        }} class="py-2 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center {submenu === 1 ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}">
            <span>{language.parameters}</span>
        </button>
        <button onclick={() => {
            submenu = 2
        }} class="py-2 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center {submenu === 2 ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}">
            <span>{language.prompt}</span>
        </button>
        <button onclick={() => {
            submenu = 3
        }} class="py-2 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center {submenu === 3 ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}">
            <span>{language.others}</span>
        </button>
    </div>
{/if}

{#if submenu === 0 || submenu === -1}
    <div class="flex flex-col gap-4 mt-2">
        {#if !hideTabs}
            <!-- Submenu 0 Tabs: Main Model vs Auxiliary Model vs Provider Credentials (Slim Single Line) -->
            <div class="flex w-full rounded-xl border border-darkborderc overflow-hidden bg-darkbg/40 p-1 gap-1">
                <button 
                    onclick={() => { modelTab = 'main'; }}
                    class="py-1.5 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap {modelTab === 'main' ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}"
                >
                    <span>{language.mainModelCardTitle || language.model}</span>
                    <Help key="model" />
                </button>
                <button 
                    onclick={() => { modelTab = 'sub'; }}
                    class="py-1.5 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap {modelTab === 'sub' ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}"
                >
                    <span>{language.subModelCardTitle || language.submodel}</span>
                    <Help key="submodel" />
                </button>
                <button 
                    onclick={() => { modelTab = 'provider'; }}
                    class="py-1.5 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap {modelTab === 'provider' ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}"
                >
                    <KeyIcon size={14} />
                    <span>{language.providerSettings || "API & Providers"}</span>
                </button>
            </div>
        {/if}

        {#if modelTab === 'main'}
            <!-- Main Model Inline Browser & Quick Options -->
            <div class="flex flex-col gap-3">
                <ModelBrowser bind:value={settingsStore.state.aiModel} onChange={persistModelSelection} />

                <!-- Main Model Options (Bottom) -->
                <div class="flex flex-col gap-2.5 pt-3 border-t border-darkborderc/60">
                    {#if !usesOllamaCloud && (modelInfo.flags.includes(LLMFlags.hasStreaming) || subModelInfo.flags.includes(LLMFlags.hasStreaming))}
                        <Check bind:check={settingsStore.state.useStreaming} name={`Response ${language.streaming}`} />
                        
                        {#if settingsStore.state.useStreaming && (modelInfo.flags.includes(LLMFlags.geminiThinking) || subModelInfo.flags.includes(LLMFlags.geminiThinking))}
                            <Check bind:check={settingsStore.state.streamGeminiThoughts} name={`Stream Gemini Thoughts`} />
                        {/if}
                    {/if}

                    {#if settingsStore.state.aiModel === 'reverse_proxy' || settingsStore.state.subModel === 'reverse_proxy'}
                        <Check bind:check={settingsStore.state.reverseProxyOobaMode} name={`${language.reverseProxyOobaMode}`} />
                    {/if}

                    {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
                        <Check bind:check={settingsStore.state.NAIadventure} name={language.textAdventureNAI} />
                        <Check bind:check={settingsStore.state.NAIappendName} name={language.appendNameNAI} />
                    {/if}
                </div>
            </div>

        {:else if modelTab === 'sub'}
            <!-- Auxiliary Model Section -->
            <div class="flex flex-col gap-3">
                <div class="flex items-center justify-between pb-1">
                    <Check bind:check={settingsStore.state.seperateModelsForAxModels} name={language.seperateModelsForAxModels} />
                </div>

                {#if !settingsStore.state.seperateModelsForAxModels}
                    <ModelBrowser bind:value={settingsStore.state.subModel} blankable onChange={persistModelSelection} />
                {:else}
                    <div class="flex items-center mb-1">
                        <Check bind:check={settingsStore.state.doNotChangeSeperateModels} name={language.doNotChangeSeperateModels} />
                    </div>

                    <!-- Aux feature sub-tabs -->
                    <div class="flex w-full rounded-xl border border-darkborderc overflow-hidden bg-darkbg/40 p-1 gap-1">
                        <button 
                            onclick={() => { auxSubTab = 'memory'; }}
                            class="py-1.5 px-3 flex-1 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 {auxSubTab === 'memory' ? 'bg-darkbutton text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        >
                            <span>Memory</span>
                        </button>
                        <button 
                            onclick={() => { auxSubTab = 'translate'; }}
                            class="py-1.5 px-3 flex-1 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 {auxSubTab === 'translate' ? 'bg-darkbutton text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        >
                            <span>Translations</span>
                        </button>
                        <button 
                            onclick={() => { auxSubTab = 'emotion'; }}
                            class="py-1.5 px-3 flex-1 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 {auxSubTab === 'emotion' ? 'bg-darkbutton text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        >
                            <span>Emotion</span>
                        </button>
                        <button 
                            onclick={() => { auxSubTab = 'otherAx'; }}
                            class="py-1.5 px-3 flex-1 rounded-lg text-xs font-bold transition-colors flex items-center justify-center gap-1 {auxSubTab === 'otherAx' ? 'bg-darkbutton text-textcolor shadow-xs' : 'text-textcolor2 hover:text-textcolor'}"
                        >
                            <span>OtherAux</span>
                        </button>
                    </div>

                    <!-- Inline Browser for current aux sub-tab -->
                    {#if auxSubTab === 'memory'}
                        <ModelBrowser bind:value={settingsStore.state.seperateModels.memory} blankable />
                    {:else if auxSubTab === 'translate'}
                        <ModelBrowser bind:value={settingsStore.state.seperateModels.translate} blankable />
                    {:else if auxSubTab === 'emotion'}
                        <ModelBrowser bind:value={settingsStore.state.seperateModels.emotion} blankable />
                    {:else if auxSubTab === 'otherAx'}
                        <ModelBrowser bind:value={settingsStore.state.seperateModels.otherAx} blankable />
                    {/if}
                {/if}
            </div>

        {:else if modelTab === 'provider'}
            <!-- Dedicated Provider Credentials & Settings Section (Collapsible Accordions) -->
            <div class="flex flex-col gap-3">
                <!-- Accordion Global Actions -->
                <div class="flex items-center justify-between pb-1 border-b border-darkborderc/60 text-xs">
                    <span class="text-textcolor2 font-medium">Click any provider to configure its API Key & options</span>
                    <div class="flex items-center gap-2">
                        <button 
                            class="px-2 py-1 rounded bg-darkbutton hover:bg-darkbutton/80 text-textcolor text-xs font-medium"
                            onclick={() => {
                                const allKeys = ['google', 'vertex', 'openai', 'anthropic', 'openrouter', 'nanogpt', 'ollama', 'proxy', 'mistral', 'cohere', 'novelai', 'novellist', 'mancer', 'horde', 'kobold', 'textgen', 'ooba', 'plugin', 'echo'];
                                const allOpen = allKeys.every(k => openProviders[k]);
                                for (const k of allKeys) openProviders[k] = !allOpen;
                            }}
                        >
                            Toggle All
                        </button>
                    </div>
                </div>

                <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                    <!-- Google AI Studio -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['google'] = !openProviders['google']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Google AI Studio</span>
                                {#if usesGoogle}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['google']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['google'] || (openProviders['google'] === undefined && usesGoogle)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">API Key</span>
                                <TextInput marginBottom={false} size={"sm"} placeholder="AIza..." hideText={settingsStore.state.hideApiKey} bind:value={settingsStore.state.google.accessToken} />
                            </div>
                        {/if}
                    </div>

                    <!-- Google Cloud Vertex AI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['vertex'] = !openProviders['vertex']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Google Cloud Vertex AI</span>
                                {#if usesVertex}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['vertex']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['vertex'] || (openProviders['vertex'] === undefined && usesVertex)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Project ID</span>
                                <TextInput marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.google.projectId} oninput={clearVertexToken} />
                                
                                <span class="text-xs text-textcolor2">Vertex Client Email</span>
                                <TextInput marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.vertexClientEmail} oninput={clearVertexToken} />
                                
                                <span class="text-xs text-textcolor2">Vertex Private Key</span>
                                <TextInput marginBottom={false} size={"sm"} placeholder="..." hideText={settingsStore.state.hideApiKey} bind:value={settingsStore.state.vertexPrivateKey} oninput={clearVertexToken} />
                                
                                <span class="text-xs text-textcolor2">Region</span>
                                <SelectInput value={settingsStore.state.vertexRegion} onchange={(e) => {
                                    settingsStore.state.vertexRegion = e.currentTarget.value;
                                    clearVertexToken();
                                }}>
                                    <OptionInput value={'global'}>global</OptionInput>
                                    <OptionInput value={'us-central1'}>us-central1</OptionInput>
                                    <OptionInput value={'us-west1'}>us-west1</OptionInput>
                                </SelectInput>
                            </div>
                        {/if}
                    </div>

                    <!-- OpenAI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['openai'] = !openProviders['openai']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">OpenAI</span>
                                {#if usesOpenAI}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['openai']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['openai'] || (openProviders['openai'] === undefined && usesOpenAI)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">OpenAI {language.apiKey} <Help key="oaiapikey"/></span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.openAIKey} placeholder="sk-..." />
                            </div>
                        {/if}
                    </div>

                    <!-- Anthropic Claude / AWS Bedrock -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['anthropic'] = !openProviders['anthropic']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Anthropic Claude</span>
                                {#if usesAnthropicOrAWS}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['anthropic']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['anthropic'] || (openProviders['anthropic'] === undefined && usesAnthropicOrAWS)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Claude {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="sk-ant-..." bind:value={settingsStore.state.claudeAPIKey} />
                            </div>
                        {/if}
                    </div>

                    <!-- OpenRouter -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['openrouter'] = !openProviders['openrouter']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">OpenRouter</span>
                                {#if usesOpenRouter}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['openrouter']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['openrouter'] || (openProviders['openrouter'] === undefined && usesOpenRouter)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">OpenRouter {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.openrouterKey} />

                                <span class="text-xs text-textcolor2 mt-1">{language.tokenizer}</span>
                                <SelectInput bind:value={settingsStore.state.customTokenizer}>
                                    {#each tokenizerList as entry}
                                        <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
                                    {/each}
                                </SelectInput>

                                <span class="text-xs text-textcolor2 mt-1">OpenRouter {language.model}</span>
                                {#await getOpenRouterModels()}
                                    <ModelGrid bind:value={settingsStore.state.openrouterRequestModel} pinnedItems={openrouterPinnedItems} loading={true} />
                                {:then m}
                                    <ModelGrid bind:value={settingsStore.state.openrouterRequestModel} items={(m ?? []).map(orToGridItem)} pinnedItems={openrouterPinnedItems} />
                                {/await}
                            </div>
                        {/if}
                    </div>

                    <!-- NanoGPT -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['nanogpt'] = !openProviders['nanogpt']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">NanoGPT</span>
                                {#if usesNanoGPT}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['nanogpt']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['nanogpt'] || (openProviders['nanogpt'] === undefined && usesNanoGPT)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">NanoGPT {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.nanogptKey} />

                                <NanoGPTDashboard apiKey={settingsStore.state.nanogptKey} />

                                {#if settingsStore.state.nanogptSubscriptionState === 'active' || settingsStore.state.nanogptSubscriptionState === 'grace'}
                                    <div class="flex items-center">
                                        <CheckInput bind:check={settingsStore.state.nanogptUseSubscriptionEndpoint} name={language.nanoGPTUseSubscriptionEndpoint} />
                                    </div>
                                {/if}

                                <span class="text-xs text-textcolor2 mt-1">NanoGPT {language.model}</span>
                                <SegmentedControl
                                    bind:value={nanogptInputMode}
                                    options={[
                                        { value: 'list', label: (language as any).nanoGPTSelectFromList || 'Select from List' },
                                        { value: 'manual', label: (language as any).nanoGPTManualInput || 'Manual Input' }
                                    ]}
                                    size="md"
                                />

                                {#if nanogptInputMode === 'manual'}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.nanogptRequestModel} placeholder={(language as any).nanoGPTManualModelSelect || "Manual Model Select"} oninput={() => settingsStore.state.nanogptRequestModelName = ''}/>
                                {:else}
                                    {#await Promise.all([getNanoGPTModels(), getNanoGPTSubscriptionModels(settingsStore.state.nanogptKey)])}
                                        <ModelGrid bind:value={settingsStore.state.nanogptRequestModel} loading={true} />
                                    {:then [regular, sub]}
                                        <ModelGrid
                                            bind:value={settingsStore.state.nanogptRequestModel}
                                            items={settingsStore.state.nanogptUseSubscriptionEndpoint ? (sub ?? []).map(ngToGridItem) : (regular ?? []).map(ngToGridItem)}
                                            showSubBadge={settingsStore.state.nanogptUseSubscriptionEndpoint}
                                            selectedLabelOverride={settingsStore.state.nanogptRequestModel && !settingsStore.state.nanogptRequestModelName ? settingsStore.state.nanogptRequestModel : undefined}
                                            onselect={(_id, name) => { settingsStore.state.nanogptRequestModelName = name }}
                                        />
                                        {#if !settingsStore.state.nanogptUseSubscriptionEndpoint}
                                            <NanoGPTProviderPicker
                                                apiKey={settingsStore.state.nanogptKey}
                                                modelId={settingsStore.state.nanogptRequestModel}
                                                bind:value={settingsStore.state.nanogptProvider}
                                            />
                                        {/if}
                                    {/await}
                                {/if}
                            </div>
                        {/if}
                    </div>

                    <!-- Ollama -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['ollama'] = !openProviders['ollama']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Ollama</span>
                                {#if usesOllamaLocal || usesOllamaCloud}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['ollama']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['ollama'] || (openProviders['ollama'] === undefined && (usesOllamaLocal || usesOllamaCloud))}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Ollama URL</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaURL} />
                                
                                <span class="text-xs text-textcolor2 mt-1">Ollama Model</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaModel} placeholder="Model" oninput={() => { settingsStore.state.ollamaModelSource = 'local'; settingsStore.state.ollamaModelName = '' }} />

                                <span class="text-xs text-textcolor2 mt-1">Ollama Cloud / Remote</span>
                                <SegmentedControl
                                    bind:value={settingsStore.state.ollamaInputMode}
                                    options={[
                                        { value: 'list', label: (language as any).nanoGPTSelectFromList || 'Select from List' },
                                        { value: 'manual', label: (language as any).nanoGPTManualInput || 'Manual Input' }
                                    ]}
                                    size="md"
                                />

                                {#if settingsStore.state.ollamaInputMode === 'manual'}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaCloudModel} placeholder="Model" oninput={() => settingsStore.state.ollamaCloudModelName = ''} />
                                {:else}
                                    {#await getOllamaModels(settingsStore.state.ollamaURL, 'cloud', settingsStore.state.ollamaApiKey)}
                                        <ModelGrid bind:value={settingsStore.state.ollamaCloudModel} loading={true} />
                                    {:then cloudModels}
                                        <ModelGrid
                                            bind:value={settingsStore.state.ollamaCloudModel}
                                            items={cloudModels ?? []}
                                            selectedLabelOverride={settingsStore.state.ollamaCloudModel ? `Cloud / ${settingsStore.state.ollamaCloudModelName || settingsStore.state.ollamaCloudModel}` : undefined}
                                            onselect={(_id, name) => {
                                                settingsStore.state.ollamaModelSource = 'cloud'
                                                settingsStore.state.ollamaCloudModelName = name
                                            }}
                                        />
                                    {/await}
                                {/if}

                                <span class="text-xs text-textcolor2 mt-1">Ollama {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaApiKey} />

                                <span class="text-xs text-textcolor2 mt-1">Ollama {language.format}</span>
                                <SelectInput value={settingsStore.state.ollamaRequestFormat.toString()} onchange={(e) => {
                                    settingsStore.state.ollamaRequestFormat = parseInt(e.currentTarget.value) as LLMFormat
                                }}>
                                    <OptionInput value={LLMFormat.Ollama.toString()}>Ollama SDK</OptionInput>
                                    <OptionInput value={LLMFormat.OpenAICompatible.toString()}>OpenAI Compatible</OptionInput>
                                    <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>OpenAI Response API</OptionInput>
                                    <OptionInput value={LLMFormat.Anthropic.toString()}>Anthropic Claude</OptionInput>
                                </SelectInput>

                                <span class="text-xs text-textcolor2 mt-1">Ollama Thinking</span>
                                <SelectInput bind:value={settingsStore.state.ollamaThinkingMode}>
                                    <OptionInput value="auto">Auto</OptionInput>
                                    <OptionInput value="off">Off</OptionInput>
                                    <OptionInput value="on">On</OptionInput>
                                    <OptionInput value="low">Low</OptionInput>
                                    <OptionInput value="medium">Medium</OptionInput>
                                    <OptionInput value="high">High</OptionInput>
                                </SelectInput>
                            </div>
                        {/if}
                    </div>

                    <!-- Reverse Proxy -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['proxy'] = !openProviders['proxy']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Reverse Proxy</span>
                                {#if usesReverseProxy}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['proxy']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['proxy'] || (openProviders['proxy'] === undefined && usesReverseProxy)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">URL <Help key="forceUrl"/></span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.forceReplaceUrl} placeholder="https://..." />
                                
                                <span class="text-xs text-textcolor2 mt-1">{language.proxyAPIKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="leave blank if none" bind:value={settingsStore.state.proxyKey} />
                                
                                <span class="text-xs text-textcolor2 mt-1">{language.proxyRequestModel}</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.customProxyRequestModel} placeholder="Model Name" />
                                
                                <span class="text-xs text-textcolor2 mt-1">{language.format}</span>
                                <SelectInput value={settingsStore.state.customAPIFormat.toString()} onchange={(e) => {
                                    settingsStore.state.customAPIFormat = parseInt(e.currentTarget.value) as LLMFormat
                                }}>
                                    <OptionInput value={LLMFormat.OpenAICompatible.toString()}>OpenAI Compatible</OptionInput>
                                    <OptionInput value={LLMFormat.OpenAIResponseAPI.toString()}>OpenAI Response API</OptionInput>
                                    <OptionInput value={LLMFormat.Anthropic.toString()}>Anthropic Claude</OptionInput>
                                    <OptionInput value={LLMFormat.Mistral.toString()}>Mistral</OptionInput>
                                    <OptionInput value={LLMFormat.GoogleCloud.toString()}>Google Cloud</OptionInput>
                                    <OptionInput value={LLMFormat.Cohere.toString()}>Cohere</OptionInput>
                                </SelectInput>

                                <span class="text-xs text-textcolor2 mt-1">{language.tokenizer}</span>
                                <SelectInput bind:value={settingsStore.state.customTokenizer}>
                                    {#each tokenizerList as entry}
                                        <OptionInput value={entry[0]}>{entry[1]}</OptionInput>
                                    {/each}
                                </SelectInput>
                            </div>
                        {/if}
                    </div>

                    <!-- Mistral AI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['mistral'] = !openProviders['mistral']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Mistral AI</span>
                                {#if usesMistral}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['mistral']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['mistral'] || (openProviders['mistral'] === undefined && usesMistral)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Mistral {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.mistralKey} />
                            </div>
                        {/if}
                    </div>

                    <!-- Cohere -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['cohere'] = !openProviders['cohere']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Cohere</span>
                                {#if usesCohere}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['cohere']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['cohere'] || (openProviders['cohere'] === undefined && usesCohere)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Cohere {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.cohereAPIKey} />
                            </div>
                        {/if}
                    </div>

                    <!-- NovelAI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['novelai'] = !openProviders['novelai']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">NovelAI</span>
                                {#if usesNovelAI}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['novelai']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['novelai'] || (openProviders['novelai'] === undefined && usesNovelAI)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">NovelAI Bearer Token</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.novelai.token} />
                            </div>
                        {/if}
                    </div>

                    <!-- NovelList -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['novellist'] = !openProviders['novellist']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">NovelList</span>
                                {#if usesNovelList}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['novellist']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['novellist'] || (openProviders['novellist'] === undefined && usesNovelList)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">NovelList {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.novellistAPI} />
                            </div>
                        {/if}
                    </div>

                    <!-- Mancer -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['mancer'] = !openProviders['mancer']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Mancer</span>
                                {#if usesMancer}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['mancer']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['mancer'] || (openProviders['mancer'] === undefined && usesMancer)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Mancer {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.mancerHeader} />
                            </div>
                        {/if}
                    </div>

                    <!-- AI Horde -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['horde'] = !openProviders['horde']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">AI Horde</span>
                                {#if usesHorde}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['horde']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['horde'] || (openProviders['horde'] === undefined && usesHorde)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Horde {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.hordeConfig.apiKey} />
                                <ChatFormatSettings />
                            </div>
                        {/if}
                    </div>

                    <!-- Kobold -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['kobold'] = !openProviders['kobold']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Kobold</span>
                                {#if usesKobold}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['kobold']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['kobold'] || (openProviders['kobold'] === undefined && usesKobold)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Kobold URL</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.koboldURL} />
                                <ChatFormatSettings />
                            </div>
                        {/if}
                    </div>

                    <!-- TextGen WebUI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['textgen'] = !openProviders['textgen']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">TextGen WebUI</span>
                                {#if usesTextGen}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['textgen']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['textgen'] || (openProviders['textgen'] === undefined && usesTextGen)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Blocking {language.providerURL}</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.textgenWebUIBlockingURL} placeholder="https://..." />
                                <span class="text-draculared text-xs">You must use textgen webui with --public-api</span>
                                
                                <span class="text-xs text-textcolor2 mt-1">Stream {language.providerURL}</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.textgenWebUIStreamURL} placeholder="wss://..." />
                                {#if !isTauri}
                                    <span class="text-draculared text-xs">You are using web version. You must use ngrok or tunnels for local WebUI.</span>
                                {/if}
                                <span class="text-draculared text-xs">Warning: For Ooba version over 1.7, use "Ooba" as model, and use url like http://127.0.0.1:5000/v1/chat/completions</span>
                            </div>
                        {/if}
                    </div>

                    <!-- Ooba -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['ooba'] = !openProviders['ooba']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Ooba</span>
                                {#if usesOoba}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['ooba']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['ooba'] || (openProviders['ooba'] === undefined && usesOoba)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Ooba {language.providerURL}</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.textgenWebUIBlockingURL} placeholder="https://..." />
                            </div>
                        {/if}
                    </div>

                    <!-- Custom Plugin Provider -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['plugin'] = !openProviders['plugin']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">{language.plugin}</span>
                                {#if usesCustomPlugin}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['plugin']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['plugin'] || (openProviders['plugin'] === undefined && usesCustomPlugin)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <SelectInput bind:value={settingsStore.state.currentPluginProvider}>
                                    <OptionInput value="">None</OptionInput>
                                    {#each $customProviderStore as plugin}
                                        <OptionInput value={plugin}>{plugin}</OptionInput>
                                    {/each}
                                </SelectInput>
                            </div>
                        {/if}
                    </div>

                    <!-- Echo Model -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button 
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left"
                            onclick={() => { openProviders['echo'] = !openProviders['echo']; }}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Echo Model</span>
                                {#if usesEcho}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if openProviders['echo']}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if openProviders['echo'] || (openProviders['echo'] === undefined && usesEcho)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Echo Message</span>
                                <TextAreaInput bind:value={settingsStore.state.echoMessage} placeholder={"The message you want to receive as the bot's response\n(e.g., Lumi tilts her head, her white hair sliding down as her pretty green and aqua eyes sparkle…)"} />
                                <span class="text-xs text-textcolor2 mt-1">Echo Delay (Seconds)</span>
                                <NumberInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.echoDelay} min={0} />
                            </div>
                        {/if}
                    </div>
                </div>
            </div>
        {/if}
    </div>
{/if}

{#if submenu === 1 || submenu === -1}
    <!-- Data-driven basic parameters -->
    <SettingRenderer items={allBasicParameterItems} {modelInfo} {subModelInfo} />
    {#if settingsStore.state.aiModel === 'textgen_webui' || settingsStore.state.aiModel === 'mancer' || settingsStore.state.aiModel.startsWith('local_') || settingsStore.state.aiModel.startsWith('hf:::')}
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput min={1} max={1.5} step={0.01} fixed={2} marginBottom bind:value={settingsStore.state.ooba.repetition_penalty}/>
        <span class="text-textcolor">Length Penalty</span>
        <SliderInput min={-5} max={5} step={0.05} marginBottom fixed={2} bind:value={settingsStore.state.ooba.length_penalty}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom bind:value={settingsStore.state.ooba.top_k} />
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.ooba.top_p}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.ooba.typical_p}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.ooba.top_a}/>
        <span class="text-textcolor">No Repeat n-gram Size</span>
        <SliderInput min={0} max={20} step={1} marginBottom bind:value={settingsStore.state.ooba.no_repeat_ngram_size}/>
        <div class="flex items-center mt-4">
            <Check bind:check={settingsStore.state.ooba.do_sample} name={'Do Sample'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={settingsStore.state.ooba.add_bos_token} name={'Add BOS Token'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={settingsStore.state.ooba.ban_eos_token} name={'Ban EOS Token'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={settingsStore.state.ooba.skip_special_tokens} name={'Skip Special Tokens'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check check={!!settingsStore.state.localStopStrings} name={language.customStopWords} onChange={() => {
                if(!settingsStore.state.localStopStrings){
                    settingsStore.state.localStopStrings = []
                }
                else{
                    settingsStore.state.localStopStrings = null
                }
            }} />
        </div>
        {#if settingsStore.state.localStopStrings}
            <div class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1">
                <div class="p-2">
                    <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                        let localStopStrings = settingsStore.state.localStopStrings
                        localStopStrings.push('')
                        settingsStore.state.localStopStrings = localStopStrings
                    }}><PlusIcon /></button>
                </div>
                {#each settingsStore.state.localStopStrings as stopString, i}
                    <div class="flex w-full">
                        <div class="grow">
                            <TextInput marginBottom bind:value={settingsStore.state.localStopStrings[i]} fullwidth fullh/>
                        </div>
                        <div>
                            <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                                let localStopStrings = settingsStore.state.localStopStrings
                                localStopStrings.splice(i, 1)
                                settingsStore.state.localStopStrings = localStopStrings
                            }}><TrashIcon /></button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
        <div class="flex flex-col p-3 rounded-md border-selected border mt-4">
            <ChatFormatSettings />
        </div>
        <Check bind:check={settingsStore.state.ooba.formating.useName} name={language.useNamePrefix}/>
    
    {:else if modelInfo.format === LLMFormat.NovelAI}
        <div class="flex flex-col p-3 bg-darkbg mt-4">
            <span class="text-textcolor">Starter</span>
            <TextInput bind:value={settingsStore.state.NAIsettings.starter} placeholder={'⁂'} />
            <span class="text-textcolor">Seperator</span>
            <TextInput bind:value={settingsStore.state.NAIsettings.seperator} placeholder={"\\n"}/>
        </div>
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.topP}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.topK}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.topA}/>
        <span class="text-textcolor">Tailfree Sampling</span>
        <SliderInput min={0} max={1} step={0.001} marginBottom fixed={3} bind:value={settingsStore.state.NAIsettings.tailFreeSampling}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.typicalp}/>
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput min={0} max={3} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.repetitionPenalty}/>
        <span class="text-textcolor">Repetition Penalty Range</span>
        <SliderInput min={0} max={8192} step={1} marginBottom fixed={0} bind:value={settingsStore.state.NAIsettings.repetitionPenaltyRange}/>
        <span class="text-textcolor">Repetition Penalty Slope</span>
        <SliderInput min={0} max={10} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.repetitionPenaltySlope}/>
        <span class="text-textcolor">Frequency Penalty</span>
        <SliderInput min={-2} max={2} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.frequencyPenalty}/>
        <span class="text-textcolor">Presence Penalty</span>
        <SliderInput min={-2} max={2} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.presencePenalty}/>
        <span class="text-textcolor">Mirostat LR</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.mirostat_lr}/>
        <span class="text-textcolor">Mirostat Tau</span>
        <SliderInput min={0} max={6} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.mirostat_tau}/>
        <span class="text-textcolor">Cfg Scale</span>
        <SliderInput min={1} max={3} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.NAIsettings.cfg_scale}/>

    {:else if modelInfo.format === LLMFormat.NovelList}
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.ainconfig.top_p}/>
        <span class="text-textcolor">Reputation Penalty</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.ainconfig.rep_pen}/>
        <span class="text-textcolor">Reputation Penalty Range</span>
        <SliderInput min={0} max={2048} step={1} marginBottom fixed={2} bind:value={settingsStore.state.ainconfig.rep_pen_range}/>
        <span class="text-textcolor">Reputation Penalty Slope</span>
        <SliderInput min={0} max={10} step={0.1} marginBottom fixed={2} bind:value={settingsStore.state.ainconfig.rep_pen_slope}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput min={1} max={500} step={1} marginBottom fixed={2} bind:value={settingsStore.state.ainconfig.top_k}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.ainconfig.top_a}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={settingsStore.state.ainconfig.typical_p}/>
    {:else}
        <!-- Standard parameters now handled by SettingRenderer above -->
    {/if}

    {#if (settingsStore.state.reverseProxyOobaMode && settingsStore.state.aiModel === 'reverse_proxy') || (settingsStore.state.aiModel === 'ooba')}
        <OobaSettings instructionMode={settingsStore.state.aiModel === 'ooba'} />
    {/if}

    {#if settingsStore.state.aiModel.startsWith('openrouter')}
        <OpenrouterSettings />
    {/if}

    <!-- Separate Parameters - handled by custom component -->
    <SeparateParametersSection />
{/if}

{#if submenu === 3 || submenu === -1}
    <Accordion styled name="Bias " help="bias">
        <table class="contain w-full max-w-full tabler">
            <tbody>
            <tr>
                <th class="font-medium">Bias</th>
                <th class="font-medium">{language.value}</th>
                <th>
                    <button class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center" onclick={() => {
                        let bia = settingsStore.state.bias
                        bia.push(['', 0])
                        settingsStore.state.bias = bia
                    }}><PlusIcon /></button>
                </th>
            </tr>
            {#if settingsStore.state.bias.length === 0}
                <tr>
                    <td colspan="3" class="text-textcolor2">{language.noBias}</td>
                </tr>
            {/if}
            {#each settingsStore.state.bias as bias, i}
                <tr>
                    <td class="font-medium truncate">
                        <TextInput bind:value={settingsStore.state.bias[i][0]} size="lg" fullwidth/>
                    </td>
                    <td class="font-medium truncate">
                        <NumberInput bind:value={settingsStore.state.bias[i][1]} max={100} min={-101} size="lg" fullwidth/>
                    </td>
                    <td>
                        <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                            let bia = settingsStore.state.bias
                            bia.splice(i, 1)
                            settingsStore.state.bias = bia
                        }}><TrashIcon /></button>
                    </td>
                </tr>
            {/each}
            </tbody>
        </table>
        <div class="text-textcolor2 mt-2 flex items-center gap-2">
            <button class="font-medium cursor-pointer hover:text-textcolor gap-2" onclick={() => {
                const data = JSON.stringify(settingsStore.state.bias, null, 2)
                downloadFile('bias.json', data)
            }}><DownloadIcon /></button>
            <button class="font-medium cursor-pointer hover:text-textcolor" onclick={async () => {
                const sel = await selectSingleFile(['json'])
                const utf8 = new TextDecoder().decode(sel.data)
                if(Array.isArray(JSON.parse(utf8))){
                    settingsStore.state.bias = JSON.parse(utf8)
                }
            }}><HardDriveUploadIcon /></button>
        </div>
    </Accordion>

    <Accordion styled name="{language.additionalParams} " help="additionalParams">
        <table class="contain w-full max-w-full tabler">
            <tbody>
            <tr>
                <th class="font-medium">{language.key}</th>
                <th class="font-medium">{language.value}</th>
                <th>
                    <button class="font-medium cursor-pointer hover:text-green-500 w-full flex justify-center items-center" onclick={() => {
                        settingsStore.state.additionalParams.push(['', ''])
                    }}><PlusIcon /></button>
                </th>
            </tr>
            {#if settingsStore.state.additionalParams.length === 0}
                <tr class="text-textcolor2">
                    <td colspan="3">{language.noData}</td>
                </tr>
            {/if}
            {#each settingsStore.state.additionalParams as additionalParams, i}
                <tr>
                    <td class="font-medium truncate">
                        <TextInput bind:value={settingsStore.state.additionalParams[i][0]} size="lg" fullwidth/>
                    </td>
                    <td class="font-medium truncate">
                        <TextInput bind:value={settingsStore.state.additionalParams[i][1]} size="lg" fullwidth/>
                    </td>
                    <td>
                        <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                            let additionalParams = settingsStore.state.additionalParams
                            additionalParams.splice(i, 1)
                            settingsStore.state.additionalParams = additionalParams
                        }}><TrashIcon /></button>
                    </td>
                </tr>
            {/each}
            </tbody>
        </table>
    </Accordion>


    <Accordion styled name={language.promptTemplate}>
        {#if settingsStore.state.promptTemplate}
            {#if submenu !== -1}
                <PromptSettings mode='inline' subMenu={1} />
            {/if}
        {:else}
            <Check check={false} name={language.usePromptTemplate} onChange={() => {
                settingsStore.state.promptTemplate = []
            }}/>
        {/if}
    </Accordion>

    {#snippet CustomFlagButton(name:string,flag:number)}
        <Button className="mt-2" onclick={(e) => {
            if(settingsStore.state.customFlags.includes(flag as LLMFlags)){
                settingsStore.state.customFlags = settingsStore.state.customFlags.filter((f: LLMFlags) => f !== flag)
            }
            else{
                settingsStore.state.customFlags.push(flag as LLMFlags)
            }
        }} styled={settingsStore.state.customFlags.includes(flag as LLMFlags) ? 'primary' : 'outlined'}>
            {name}
        </Button>
    {/snippet}

    <Accordion styled name={language.customFlags}>
        <Check bind:check={settingsStore.state.enableCustomFlags} name={language.enableCustomFlags}/>


        {#if settingsStore.state.enableCustomFlags}
            {@render CustomFlagButton('hasImageInput', 0)}
            {@render CustomFlagButton('hasImageOutput', 1)}
            {@render CustomFlagButton('hasAudioInput', 2)}
            {@render CustomFlagButton('hasAudioOutput', 3)}
            {@render CustomFlagButton('hasPrefill', 4)}
            {@render CustomFlagButton('hasCache', 5)}
            {@render CustomFlagButton('hasFullSystemPrompt', 6)}
            {@render CustomFlagButton('hasFirstSystemPrompt', 7)}
            {@render CustomFlagButton('hasStreaming', 8)}
            {@render CustomFlagButton('requiresAlternateRole', 9)}
            {@render CustomFlagButton('mustStartWithUserInput', 10)}
            {@render CustomFlagButton('hasVideoInput', 12)}
            {@render CustomFlagButton('OAICompletionTokens', 13)}
            {@render CustomFlagButton('DeveloperRole', 14)}
            {@render CustomFlagButton('geminiThinking', 15)}
            {@render CustomFlagButton('geminiBlockOff', 16)}
            {@render CustomFlagButton('deepSeekPrefix', 17)}
            {@render CustomFlagButton('deepSeekThinkingInput', 18)}
            {@render CustomFlagButton('deepSeekThinkingOutput', 19)}
            {@render CustomFlagButton('noCivilIntegrity', 20)}
            {@render CustomFlagButton('claudeThinking', 21)}
            {@render CustomFlagButton('claudeAdaptiveThinking', 22)}
            {@render CustomFlagButton('claudeXHighEffort', 23)}
            {@render CustomFlagButton('deepSeekThinkingToggle', 24)}

        {/if}
    </Accordion>

    <Accordion styled name={language.moduleIntergration} help="moduleIntergration">
        <TextAreaInput bind:value={settingsStore.state.moduleIntergration} fullwidth height={"32"} autocomplete="off"/>
    </Accordion>

    <Accordion styled name={language.tools}>
        <Check name={language.search} check={settingsStore.state.modelTools.includes('search')} onChange={() => {
            if(settingsStore.state.modelTools.includes('search')){
                settingsStore.state.modelTools = settingsStore.state.modelTools.filter((tool: string) => tool !== 'search')
            }
            else{
                settingsStore.state.modelTools.push('search')
            }
        }} />
    </Accordion>
    
    <Accordion styled name={language.regexScript}>
        <RegexList bind:value={settingsStore.state.presetRegex} buttons />
    </Accordion>

    <Accordion styled name={language.icon}>
        <div class="p-2 rounded-md border border-darkborderc flex flex-col items-center gap-2">
            <span>
                {language.preview}
            </span>
            <div class="flex items-center justify-center gap-2">
                {#if presetStore.activePreset?.image}
                    <img src={presetStore.activePreset.image} alt="icon" class="w-6 h-6 rounded-md" decoding="async"/>
                    <span class="text-textcolor2">{presetStore.activePreset.name}</span>
                {:else}
                    <span class="text-textcolor2">{language.noImages}</span>
                {/if}
            </div>
        </div>
        <button class="mt-2 text-textcolor2 hover:text-textcolor focus-within:text-textcolor" onclick={async () => {
            const sel = await selectSingleFile(['png', 'jpg', 'jpeg', 'webp'])
            const canvas = document.createElement('canvas')
            const ctx = canvas.getContext('2d')
            const img = new Image()
            //@ts-expect-error Uint8Array buffer type (ArrayBufferLike) is incompatible with BlobPart's ArrayBuffer
            const blob = new Blob([sel.data], {type: getMimeType(sel.name)})
            img.src = URL.createObjectURL(blob)
            await img.decode()
            canvas.width = 48
            canvas.height = 48
            ctx.drawImage(img, 0, 0, 48, 48)
            const data = canvas.toDataURL('image/jpeg', 0.7)
            if (presetStore.activePreset) {
                presetStore.activePreset.image = data
                await presetStore.savePreset(presetStore.activePreset)
            }
        }}>
            <UploadIcon />
        </button>
    </Accordion>
    {#if submenu !== -1}
        <Button onclick={() => {$openPresetList = true}} className="mt-4">{language.presets}</Button>
    {/if}
{/if}

{#if submenu === 2 || submenu === -1}
    {#if !settingsStore.state.promptTemplate}
        <span class="text-textcolor">{language.mainPrompt} <Help key="mainprompt"/></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={settingsStore.state.mainPrompt}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.mainPrompt} {language.tokens}</span>
        <span class="text-textcolor">{language.jailbreakPrompt} <Help key="jailbreak"/></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={settingsStore.state.jailbreak}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.jailbreak} {language.tokens}</span>
        <span class="text-textcolor">{language.globalNote} <Help key="globalNote"/></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={settingsStore.state.globalNote}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.globalNote} {language.tokens}</span>  
        <span class="text-textcolor mb-2 mt-4">{language.formatingOrder} <Help key="formatOrder"/></span>
        <DropList bind:list={settingsStore.state.formatingOrder} />
        <div class="flex items-center mt-4">
            <Check bind:check={settingsStore.state.promptPreprocess} name={language.promptPreprocess}/>
        </div>
    {:else if submenu === 2}
        <PromptSettings mode='inline' />
    {/if}
{/if}


{#if settingsStore.state.promptTemplate && submenu === -1}
    <div class="mt-2">
        <Button onclick={goPromptTemplate} size="sm">{language.promptTemplate}</Button>
    </div>
{/if}
{#if submenu === -1}
    <Button onclick={() => {$openPresetList = true}} className="mt-4">{language.presets}</Button>
{/if}
