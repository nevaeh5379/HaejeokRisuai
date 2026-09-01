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
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import { allBasicParameterItems } from "src/ts/setting/botSettingsParamsData";
    import SeparateParametersSection from "./SeparateParametersSection.svelte";
    import AuxModelSelectors from './Model/AuxModelSelectors.svelte'
    import ModelBrowser from "src/lib/UI/Model/ModelBrowser.svelte";

    let modelTab = $state<'main' | 'sub' | 'provider'>('main');
    let providerModelRole = $state<'main' | 'sub' | 'memory' | 'translate' | 'emotion' | 'otherAx'>('main');
    let auxSubTab = $state<'memory' | 'translate' | 'emotion' | 'otherAx'>('memory');
    let openProviders = $state<Record<string, boolean>>({});

    const featureRoles = ['memory', 'translate', 'emotion', 'otherAx'] as const;
    type FeatureRole = typeof featureRoles[number];
    let isFeatureRole = $derived(featureRoles.includes(providerModelRole as FeatureRole));
    let currentOverride = $derived(
        isFeatureRole
            ? presetStore.state.providerModelOverrides[providerModelRole as FeatureRole]
            : undefined
    );

    $effect(() => {
        if (presetStore.state.seperateModelsForAxModels) {
            if (providerModelRole === 'sub') providerModelRole = auxSubTab
        } else if (isFeatureRole) {
            providerModelRole = 'sub'
        }
    })

    const openrouterPinnedItems: ModelGridPinnedItem[] = [
        { id: 'risu/free',       displayName: 'Free Auto',       providerName: 'Risu'       },
        { id: 'openrouter/auto', displayName: 'OpenRouter Auto', providerName: 'OpenRouter' },
    ]

    type ProviderRole = 'main' | 'sub' | FeatureRole;

    function getEffectiveNanoGPTSubscription(role: ProviderRole): boolean {
        if (role === 'main') return settingsStore.state.nanogptUseSubscriptionEndpoint
        if (role === 'sub') return settingsStore.state.nanogptSubUseSubscriptionEndpoint
        return presetStore.state.providerModelOverrides[role].nanogptUseSubscriptionEndpoint
            ?? settingsStore.state.nanogptSubUseSubscriptionEndpoint
    }

    function clearNanoGPTSelection(role: ProviderRole) {
        if (role === 'main') {
            settingsStore.state.nanogptRequestModel = ''
            settingsStore.state.nanogptRequestModelName = ''
            settingsStore.state.nanogptProvider = ''
        } else if (role === 'sub') {
            settingsStore.state.nanogptSubRequestModel = ''
            settingsStore.state.nanogptSubRequestModelName = ''
            settingsStore.state.nanogptSubProvider = ''
        } else {
            const override = presetStore.state.providerModelOverrides[role]
            override.nanogptRequestModel = ''
            override.nanogptRequestModelName = ''
            override.nanogptProvider = ''
        }
    }

    function setFeatureNanoGPTSubscription(role: FeatureRole, enabled: boolean) {
        presetStore.state.providerModelOverrides[role].nanogptUseSubscriptionEndpoint = enabled
        clearNanoGPTSelection(role)
    }

    function initialNanoGPTInputMode(role: ProviderRole): 'list' | 'manual' {
        const model = role === 'main'
            ? settingsStore.state.nanogptRequestModel
            : role === 'sub'
                ? settingsStore.state.nanogptSubRequestModel
                : presetStore.state.providerModelOverrides[role].nanogptRequestModel
        const modelName = role === 'main'
            ? settingsStore.state.nanogptRequestModelName
            : role === 'sub'
                ? settingsStore.state.nanogptSubRequestModelName
                : presetStore.state.providerModelOverrides[role].nanogptRequestModelName
        return model && !modelName ? 'manual' : 'list'
    }

    let nanogptInputModes = $state<Record<ProviderRole, 'list' | 'manual'>>({
        main: initialNanoGPTInputMode('main'),
        sub: initialNanoGPTInputMode('sub'),
        memory: initialNanoGPTInputMode('memory'),
        translate: initialNanoGPTInputMode('translate'),
        emotion: initialNanoGPTInputMode('emotion'),
        otherAx: initialNanoGPTInputMode('otherAx'),
    })

    function getNanoGPTInputMode(): 'list' | 'manual' {
        return nanogptInputModes[providerModelRole] ?? 'list'
    }

    function changeNanoGPTInputMode(value: string | number) {
        if (value !== 'list' && value !== 'manual') return
        if (value === getNanoGPTInputMode()) return
        nanogptInputModes[providerModelRole] = value
        clearNanoGPTSelection(providerModelRole)
    }

    let previousNanoGPTSubscriptionMode = $state({
        main: settingsStore.state.nanogptUseSubscriptionEndpoint,
        sub: settingsStore.state.nanogptSubUseSubscriptionEndpoint,
    })
    $effect(() => {
        const main = settingsStore.state.nanogptUseSubscriptionEndpoint
        if (main !== previousNanoGPTSubscriptionMode.main) {
            previousNanoGPTSubscriptionMode.main = main
            clearNanoGPTSelection('main')
        }
        const sub = settingsStore.state.nanogptSubUseSubscriptionEndpoint
        if (sub !== previousNanoGPTSubscriptionMode.sub) {
            previousNanoGPTSubscriptionMode.sub = sub
            clearNanoGPTSelection('sub')
            for (const role of featureRoles) {
                if (presetStore.state.providerModelOverrides[role].nanogptUseSubscriptionEndpoint === undefined) {
                    clearNanoGPTSelection(role)
                }
            }
        }
    })

    let previousNanoGPTKey = $state(settingsStore.state.nanogptKey)
    $effect(() => {
        const key = settingsStore.state.nanogptKey
        if (previousNanoGPTKey && !key) {
            settingsStore.state.nanogptUseSubscriptionEndpoint = false
            settingsStore.state.nanogptSubUseSubscriptionEndpoint = false
            settingsStore.state.nanogptSubscriptionState = ''
            clearNanoGPTSelection('main')
            clearNanoGPTSelection('sub')
            for (const role of featureRoles) {
                delete presetStore.state.providerModelOverrides[role].nanogptUseSubscriptionEndpoint
                clearNanoGPTSelection(role)
            }
        }
        previousNanoGPTKey = key
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
        tokens.mainPrompt = await tokenizeAccurate(presetStore.state.mainPrompt, true)
        tokens.jailbreak = await tokenizeAccurate(presetStore.state.jailbreak, true)
        tokens.globalNote = await tokenizeAccurate(presetStore.state.globalNote, true)
    }

    $effect.pre(() => {
        if(presetStore.state.aiModel === 'textgen_webui' || presetStore.state.subModel === 'mancer'){
            settingsStore.state.useStreaming = presetStore.state.textgenWebUIStreamURL.startsWith("wss://")
        }
    });

    function clearVertexToken() {
        settingsStore.state.vertexAccessToken = '';
        settingsStore.state.vertexAccessTokenExpires = 0;
        console.log('Vertex AI token cleared');
    }

    let submenu = $state(settingsStore.state.useLegacyGUI ? -1 : 0)
    $effect(() => {
        if (targetSubmenu !== undefined && !settingsStore.state.useLegacyGUI) {
            submenu = targetSubmenu
        }
        if (targetModelTab !== undefined) {
            modelTab = targetModelTab
            if (targetModelTab !== 'provider') providerModelRole = targetModelTab
        }
    })
    let modelInfo = $derived(getModelInfo(presetStore.state.aiModel))
    let subModelInfo = $derived(getModelInfo(presetStore.state.subModel))
    let configuredModelIds = $derived.by(() => {
        const ids = [presetStore.state.aiModel, presetStore.state.subModel]
        if (presetStore.state.seperateModelsForAxModels) {
            for (const key of ['memory', 'translate', 'emotion', 'otherAx'] as const) {
                const modelId = presetStore.state.seperateModels[key]
                if (modelId) ids.push(modelId)
            }
        }
        return ids
    })

    let usesOllamaLocal = $derived(configuredModelIds.includes('ollama-hosted'))
    let usesOllamaCloud = $derived(configuredModelIds.includes('ollama-cloud'))

    let activeProviders = $derived.by(() => {
        const set = new Set<LLMProvider>();
        if (modelInfo?.provider !== undefined) set.add(modelInfo.provider);
        if (subModelInfo?.provider !== undefined) set.add(subModelInfo.provider);
        if (presetStore.state.seperateModelsForAxModels) {
            for (const key of ['memory', 'translate', 'emotion', 'otherAx'] as const) {
                const mId = presetStore.state.seperateModels[key];
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
    let usesMancer = $derived(configuredModelIds.some((modelId) => modelId.startsWith('mancer')));
    let usesOpenRouter = $derived(configuredModelIds.includes('openrouter'));
    let usesNanoGPT = $derived(configuredModelIds.includes('nanogpt'));
    let usesReverseProxy = $derived(configuredModelIds.includes('reverse_proxy'));
    let usesHorde = $derived(configuredModelIds.some((modelId) => modelId.startsWith('horde')));
    let usesKobold = $derived(configuredModelIds.includes('kobold'));
    let usesTextGen = $derived(configuredModelIds.includes('textgen_webui'));
    let usesOoba = $derived(configuredModelIds.includes('ooba'));
    let usesCustomPlugin = $derived(presetStore.state.aiModel === 'custom' || presetStore.state.subModel === 'custom');
    let usesEcho = $derived(configuredModelIds.includes('echo_model'));

    let hasAnyProviderSettings = $derived(
        usesGoogle || usesVertex || usesAnthropicOrAWS || usesOpenAI || usesMistral ||
        usesNovelAI || usesNovelList || usesCohere || usesMancer || usesOpenRouter ||
        usesNanoGPT || usesReverseProxy || usesHorde || usesKobold || usesTextGen ||
        usesOoba || usesCustomPlugin || usesEcho || usesOllamaLocal || usesOllamaCloud ||
        !!modelInfo?.keyIdentifier || !!subModelInfo?.keyIdentifier
    );

    function isProviderOpen(key: string, inUse: boolean): boolean {
        return openProviders[key] ?? inUse;
    }

    function toggleProvider(key: string, inUse: boolean) {
        const current = isProviderOpen(key, inUse);
        openProviders[key] = !current;
    }

    function toggleAllProviders() {
        const providers: Array<{ key: string; inUse: boolean }> = [
            { key: 'google', inUse: usesGoogle },
            { key: 'vertex', inUse: usesVertex },
            { key: 'openai', inUse: usesOpenAI },
            { key: 'anthropic', inUse: usesAnthropicOrAWS },
            { key: 'openrouter', inUse: usesOpenRouter },
            { key: 'nanogpt', inUse: usesNanoGPT },
            { key: 'ollama', inUse: usesOllamaLocal || usesOllamaCloud },
            { key: 'proxy', inUse: usesReverseProxy },
            { key: 'mistral', inUse: usesMistral },
            { key: 'cohere', inUse: usesCohere },
            { key: 'novelai', inUse: usesNovelAI },
            { key: 'novellist', inUse: usesNovelList },
            { key: 'mancer', inUse: usesMancer },
            { key: 'horde', inUse: usesHorde },
            { key: 'kobold', inUse: usesKobold },
            { key: 'textgen', inUse: usesTextGen },
            { key: 'ooba', inUse: usesOoba },
            { key: 'plugin', inUse: usesCustomPlugin },
            { key: 'echo', inUse: usesEcho },
        ];
        const allOpen = providers.every(p => isProviderOpen(p.key, p.inUse));
        for (const p of providers) {
            openProviders[p.key] = !allOpen;
        }
    }
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

{#snippet providerRoleSelector(providerName: string)}
    <span class="text-xs text-textcolor2">{providerName} {language.model}</span>
    {#if presetStore.state.seperateModelsForAxModels}
        <div class="flex flex-wrap gap-1">
            <SegmentedControl
                bind:value={providerModelRole}
                options={[
                    { value: 'main', label: language.mainModelCardTitle || language.model },
                    { value: 'memory', label: 'Memory' },
                    { value: 'translate', label: 'Translate' },
                    { value: 'emotion', label: 'Emotion' },
                    { value: 'otherAx', label: 'OtherAux' },
                ]}
                size="md"
            />
        </div>
    {:else}
        <SegmentedControl
            bind:value={providerModelRole}
            options={[
                { value: 'main', label: language.mainModelCardTitle || language.model },
                { value: 'sub', label: language.subModelCardTitle || language.submodel }
            ]}
            size="md"
        />
    {/if}
{/snippet}

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
                    onclick={() => { modelTab = 'main'; providerModelRole = 'main'; }}
                    class="py-1.5 px-3 flex-1 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap {modelTab === 'main' ? 'bg-darkbutton text-textcolor shadow-sm' : 'text-textcolor2 hover:text-textcolor'}"
                >
                    <span>{language.mainModelCardTitle || language.model}</span>
                    <Help key="model" />
                </button>
                <button
                    onclick={() => { modelTab = 'sub'; providerModelRole = 'sub'; }}
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
                <ModelBrowser bind:value={presetStore.state.aiModel} />

                <!-- Main Model Options (Bottom) -->
                <div class="flex flex-col gap-2.5 pt-3 border-t border-darkborderc/60">
                    {#if !usesOllamaCloud && (modelInfo.flags.includes(LLMFlags.hasStreaming) || subModelInfo.flags.includes(LLMFlags.hasStreaming))}
                        <Check bind:check={settingsStore.state.useStreaming} name={`Response ${language.streaming}`} />

                        {#if settingsStore.state.useStreaming && (modelInfo.flags.includes(LLMFlags.geminiThinking) || subModelInfo.flags.includes(LLMFlags.geminiThinking))}
                            <Check bind:check={settingsStore.state.streamGeminiThoughts} name={`Stream Gemini Thoughts`} />
                        {/if}
                    {/if}

                    {#if presetStore.state.aiModel === 'reverse_proxy' || presetStore.state.subModel === 'reverse_proxy'}
                        <Check bind:check={settingsStore.state.reverseProxyOobaMode} name={`${language.reverseProxyOobaMode}`} />
                    {/if}

                    {#if modelInfo.provider === LLMProvider.NovelAI || subModelInfo.provider === LLMProvider.NovelAI}
                        <Check bind:check={presetStore.state.NAIadventure} name={language.textAdventureNAI} />
                        <Check bind:check={presetStore.state.NAIappendName} name={language.appendNameNAI} />
                    {/if}
                </div>
            </div>

        {:else if modelTab === 'sub'}
            <!-- Auxiliary Model Section -->
            <div class="flex flex-col gap-3">
                <div class="flex items-center justify-between pb-1">
                    <Check bind:check={presetStore.state.seperateModelsForAxModels} name={language.seperateModelsForAxModels} />
                </div>

                {#if !presetStore.state.seperateModelsForAxModels}
                    <ModelBrowser bind:value={presetStore.state.subModel} blankable />
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
                        <ModelBrowser bind:value={presetStore.state.seperateModels.memory} blankable />
                    {:else if auxSubTab === 'translate'}
                        <ModelBrowser bind:value={presetStore.state.seperateModels.translate} blankable />
                    {:else if auxSubTab === 'emotion'}
                        <ModelBrowser bind:value={presetStore.state.seperateModels.emotion} blankable />
                    {:else if auxSubTab === 'otherAx'}
                        <ModelBrowser bind:value={presetStore.state.seperateModels.otherAx} blankable />
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
                            class="px-2 py-1 rounded bg-darkbutton hover:bg-darkbutton/80 text-textcolor text-xs font-medium cursor-pointer"
                            onclick={toggleAllProviders}
                        >
                            Toggle All
                        </button>
                    </div>
                </div>

                <div class="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
                    <!-- Google AI Studio -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('google', usesGoogle)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Google AI Studio</span>
                                {#if usesGoogle}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('google', usesGoogle)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('google', usesGoogle)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">API Key</span>
                                <TextInput marginBottom={false} size={"sm"} placeholder="AIza..." hideText={settingsStore.state.hideApiKey} bind:value={settingsStore.state.google.accessToken} />
                            </div>
                        {/if}
                    </div>

                    <!-- Google Cloud Vertex AI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('vertex', usesVertex)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Google Cloud Vertex AI</span>
                                {#if usesVertex}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('vertex', usesVertex)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('vertex', usesVertex)}
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
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('openai', usesOpenAI)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">OpenAI</span>
                                {#if usesOpenAI}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('openai', usesOpenAI)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('openai', usesOpenAI)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">OpenAI {language.apiKey} <Help key="oaiapikey"/></span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.openAIKey} placeholder="sk-..." />
                            </div>
                        {/if}
                    </div>

                    <!-- Anthropic Claude / AWS Bedrock -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('anthropic', usesAnthropicOrAWS)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Anthropic Claude</span>
                                {#if usesAnthropicOrAWS}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('anthropic', usesAnthropicOrAWS)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('anthropic', usesAnthropicOrAWS)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Claude {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="sk-ant-..." bind:value={settingsStore.state.claudeAPIKey} />
                            </div>
                        {/if}
                    </div>

                    <!-- OpenRouter -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('openrouter', usesOpenRouter)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">OpenRouter</span>
                                {#if usesOpenRouter}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('openrouter', usesOpenRouter)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('openrouter', usesOpenRouter)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                {@render providerRoleSelector('OpenRouter')}

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
                                    {#if providerModelRole === 'main'}
                                        <ModelGrid bind:value={presetStore.state.openrouterRequestModel} pinnedItems={openrouterPinnedItems} loading={true} />
                                    {:else if isFeatureRole && currentOverride}
                                        <ModelGrid bind:value={currentOverride.openrouterRequestModel} pinnedItems={openrouterPinnedItems} loading={true} />
                                    {:else}
                                        <ModelGrid bind:value={presetStore.state.openrouterSubRequestModel} pinnedItems={openrouterPinnedItems} loading={true} />
                                    {/if}
                                {:then m}
                                    {#if providerModelRole === 'main'}
                                        <ModelGrid bind:value={presetStore.state.openrouterRequestModel} items={(m ?? []).map(orToGridItem)} pinnedItems={openrouterPinnedItems} />
                                    {:else if isFeatureRole && currentOverride}
                                        <ModelGrid bind:value={currentOverride.openrouterRequestModel} items={(m ?? []).map(orToGridItem)} pinnedItems={openrouterPinnedItems} />
                                    {:else}
                                        <ModelGrid bind:value={presetStore.state.openrouterSubRequestModel} items={(m ?? []).map(orToGridItem)} pinnedItems={openrouterPinnedItems} />
                                    {/if}
                                {/await}
                            </div>
                        {/if}
                    </div>

                    <!-- NanoGPT -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('nanogpt', usesNanoGPT)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">NanoGPT</span>
                                {#if usesNanoGPT}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('nanogpt', usesNanoGPT)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('nanogpt', usesNanoGPT)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                {@render providerRoleSelector('NanoGPT')}

                                <span class="text-xs text-textcolor2">NanoGPT {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.nanogptKey} />

                                <NanoGPTDashboard apiKey={settingsStore.state.nanogptKey} />

                                {#if settingsStore.state.nanogptSubscriptionState === 'active' || settingsStore.state.nanogptSubscriptionState === 'grace'}
                                    <div class="flex items-center">
                                        {#if providerModelRole === 'main'}
                                            <CheckInput bind:check={settingsStore.state.nanogptUseSubscriptionEndpoint} name={language.nanoGPTUseSubscriptionEndpoint} />
                                        {:else if isFeatureRole && currentOverride}
                                            <CheckInput
                                                check={getEffectiveNanoGPTSubscription(providerModelRole)}
                                                onChange={(check) => setFeatureNanoGPTSubscription(providerModelRole as FeatureRole, check)}
                                                name={language.nanoGPTUseSubscriptionEndpoint}
                                            />
                                        {:else}
                                            <CheckInput bind:check={settingsStore.state.nanogptSubUseSubscriptionEndpoint} name={language.nanoGPTUseSubscriptionEndpoint} />
                                        {/if}
                                    </div>
                                {/if}

                                <span class="text-xs text-textcolor2 mt-1">NanoGPT {language.model}</span>
                                <SegmentedControl
                                    value={getNanoGPTInputMode()}
                                    onchange={changeNanoGPTInputMode}
                                    options={[
                                        { value: 'list', label: (language as any).nanoGPTSelectFromList || 'Select from List' },
                                        { value: 'manual', label: (language as any).nanoGPTManualInput || 'Manual Input' }
                                    ]}
                                    size="md"
                                />

                                {#if getNanoGPTInputMode() === 'manual'}
                                    {#if providerModelRole === 'main'}
                                        <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.nanogptRequestModel} placeholder={(language as any).nanoGPTManualModelSelect || "Manual Model Select"} oninput={() => { settingsStore.state.nanogptRequestModelName = ''; settingsStore.state.nanogptProvider = ''; }}/>
                                    {:else if isFeatureRole && currentOverride}
                                        <TextInput marginBottom={false} size={"sm"} bind:value={currentOverride.nanogptRequestModel} placeholder={(language as any).nanoGPTManualModelSelect || "Manual Model Select"} oninput={() => { currentOverride.nanogptRequestModelName = ''; currentOverride.nanogptProvider = ''; }}/>
                                    {:else}
                                        <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.nanogptSubRequestModel} placeholder={(language as any).nanoGPTManualModelSelect || "Manual Model Select"} oninput={() => { settingsStore.state.nanogptSubRequestModelName = ''; settingsStore.state.nanogptSubProvider = ''; }}/>
                                    {/if}
                                {:else}
                                    {#await Promise.all([getNanoGPTModels(), getNanoGPTSubscriptionModels(settingsStore.state.nanogptKey)])}
                                        {#if providerModelRole === 'main'}
                                            <ModelGrid bind:value={settingsStore.state.nanogptRequestModel} loading={true} />
                                        {:else if isFeatureRole && currentOverride}
                                            <ModelGrid bind:value={currentOverride.nanogptRequestModel} loading={true} showSubBadge={getEffectiveNanoGPTSubscription(providerModelRole)} />
                                        {:else}
                                            <ModelGrid bind:value={settingsStore.state.nanogptSubRequestModel} loading={true} showSubBadge={settingsStore.state.nanogptSubUseSubscriptionEndpoint} />
                                        {/if}
                                    {:then [regular, sub]}
                                        {#if providerModelRole === 'main'}
                                            <ModelGrid
                                                bind:value={settingsStore.state.nanogptRequestModel}
                                                items={settingsStore.state.nanogptUseSubscriptionEndpoint ? (sub ?? []).map(ngToGridItem) : (regular ?? []).map(ngToGridItem)}
                                                showSubBadge={settingsStore.state.nanogptUseSubscriptionEndpoint}
                                                selectedLabelOverride={settingsStore.state.nanogptRequestModel && !settingsStore.state.nanogptRequestModelName ? settingsStore.state.nanogptRequestModel : undefined}
                                                onselect={(_id, name) => { settingsStore.state.nanogptRequestModelName = name; settingsStore.state.nanogptProvider = ''; }}
                                            />
                                            {#if !settingsStore.state.nanogptUseSubscriptionEndpoint}
                                                <NanoGPTProviderPicker
                                                    apiKey={settingsStore.state.nanogptKey}
                                                    modelId={settingsStore.state.nanogptRequestModel}
                                                    bind:value={settingsStore.state.nanogptProvider}
                                                />
                                            {/if}
                                        {:else if isFeatureRole && currentOverride}
                                            <ModelGrid
                                                bind:value={currentOverride.nanogptRequestModel}
                                                items={getEffectiveNanoGPTSubscription(providerModelRole) ? (sub ?? []).map(ngToGridItem) : (regular ?? []).map(ngToGridItem)}
                                                showSubBadge={getEffectiveNanoGPTSubscription(providerModelRole)}
                                                selectedLabelOverride={currentOverride.nanogptRequestModel && !currentOverride.nanogptRequestModelName ? currentOverride.nanogptRequestModel : undefined}
                                                onselect={(_id, name) => { currentOverride.nanogptRequestModelName = name; currentOverride.nanogptProvider = ''; }}
                                            />
                                            {#if !getEffectiveNanoGPTSubscription(providerModelRole)}
                                                <NanoGPTProviderPicker
                                                    apiKey={settingsStore.state.nanogptKey}
                                                    modelId={currentOverride.nanogptRequestModel}
                                                    bind:value={currentOverride.nanogptProvider}
                                                />
                                            {/if}
                                        {:else}
                                            <ModelGrid
                                                bind:value={settingsStore.state.nanogptSubRequestModel}
                                                items={settingsStore.state.nanogptSubUseSubscriptionEndpoint ? (sub ?? []).map(ngToGridItem) : (regular ?? []).map(ngToGridItem)}
                                                showSubBadge={settingsStore.state.nanogptSubUseSubscriptionEndpoint}
                                                selectedLabelOverride={settingsStore.state.nanogptSubRequestModel && !settingsStore.state.nanogptSubRequestModelName ? settingsStore.state.nanogptSubRequestModel : undefined}
                                                onselect={(_id, name) => { settingsStore.state.nanogptSubRequestModelName = name; settingsStore.state.nanogptSubProvider = ''; }}
                                            />
                                            {#if !settingsStore.state.nanogptSubUseSubscriptionEndpoint}
                                                <NanoGPTProviderPicker
                                                    apiKey={settingsStore.state.nanogptKey}
                                                    modelId={settingsStore.state.nanogptSubRequestModel}
                                                    bind:value={settingsStore.state.nanogptSubProvider}
                                                />
                                            {/if}
                                        {/if}
                                    {/await}
                                {/if}
                            </div>
                        {/if}
                    </div>

                    <!-- Ollama -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('ollama', usesOllamaLocal || usesOllamaCloud)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Ollama</span>
                                {#if usesOllamaLocal || usesOllamaCloud}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('ollama', usesOllamaLocal || usesOllamaCloud)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('ollama', usesOllamaLocal || usesOllamaCloud)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                {@render providerRoleSelector('Ollama')}

                                <span class="text-xs text-textcolor2">Ollama URL</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaURL} />

                                <span class="text-xs text-textcolor2 mt-1">Ollama Local</span>
                                {#if providerModelRole === 'main'}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaModel} placeholder="Model" oninput={() => { settingsStore.state.ollamaModelSource = 'local'; settingsStore.state.ollamaModelName = '' }} />
                                {:else if isFeatureRole && currentOverride}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={currentOverride.ollamaModel} placeholder="Model (override)" oninput={() => { currentOverride.ollamaModelName = '' }} />
                                {:else}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaSubModel} placeholder="Model" oninput={() => { settingsStore.state.ollamaModelSource = 'local'; settingsStore.state.ollamaSubModelName = '' }} />
                                {/if}

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
                                    {#if providerModelRole === 'main'}
                                        <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaCloudModel} placeholder="Model" oninput={() => settingsStore.state.ollamaCloudModelName = ''} />
                                    {:else if isFeatureRole && currentOverride}
                                        <TextInput marginBottom={false} size={"sm"} bind:value={currentOverride.ollamaCloudModel} placeholder="Model (override)" oninput={() => { currentOverride.ollamaCloudModelName = '' }} />
                                    {:else}
                                        <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.ollamaCloudSubModel} placeholder="Model" oninput={() => settingsStore.state.ollamaCloudSubModelName = ''} />
                                    {/if}
                                {:else}
                                    {#await getOllamaModels(settingsStore.state.ollamaURL, 'cloud', settingsStore.state.ollamaApiKey)}
                                        {#if providerModelRole === 'main'}
                                            <ModelGrid bind:value={settingsStore.state.ollamaCloudModel} loading={true} />
                                        {:else if isFeatureRole && currentOverride}
                                            <ModelGrid bind:value={currentOverride.ollamaCloudModel} loading={true} />
                                        {:else}
                                            <ModelGrid bind:value={settingsStore.state.ollamaCloudSubModel} loading={true} />
                                        {/if}
                                    {:then cloudModels}
                                        {#if providerModelRole === 'main'}
                                            <ModelGrid
                                                bind:value={settingsStore.state.ollamaCloudModel}
                                                items={cloudModels ?? []}
                                                selectedLabelOverride={settingsStore.state.ollamaCloudModel ? `Cloud / ${settingsStore.state.ollamaCloudModelName || settingsStore.state.ollamaCloudModel}` : undefined}
                                                onselect={(_id, name) => {
                                                    settingsStore.state.ollamaModelSource = 'cloud'
                                                    settingsStore.state.ollamaCloudModelName = name
                                                }}
                                            />
                                        {:else if isFeatureRole && currentOverride}
                                            <ModelGrid
                                                bind:value={currentOverride.ollamaCloudModel}
                                                items={cloudModels ?? []}
                                                selectedLabelOverride={currentOverride.ollamaCloudModel ? `Cloud / ${currentOverride.ollamaCloudModelName || currentOverride.ollamaCloudModel}` : undefined}
                                                onselect={(_id, name) => {
                                                    currentOverride.ollamaCloudModelName = name
                                                }}
                                            />
                                        {:else}
                                            <ModelGrid
                                                bind:value={settingsStore.state.ollamaCloudSubModel}
                                                items={cloudModels ?? []}
                                                selectedLabelOverride={settingsStore.state.ollamaCloudSubModel ? `Cloud / ${settingsStore.state.ollamaCloudSubModelName || settingsStore.state.ollamaCloudSubModel}` : undefined}
                                                onselect={(_id, name) => {
                                                    settingsStore.state.ollamaModelSource = 'cloud'
                                                    settingsStore.state.ollamaCloudSubModelName = name
                                                }}
                                            />
                                        {/if}
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
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('proxy', usesReverseProxy)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Reverse Proxy</span>
                                {#if usesReverseProxy}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('proxy', usesReverseProxy)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('proxy', usesReverseProxy)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                {@render providerRoleSelector('Reverse Proxy')}

                                <span class="text-xs text-textcolor2">URL <Help key="forceUrl"/></span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={presetStore.state.forceReplaceUrl} placeholder="https://..." />

                                <span class="text-xs text-textcolor2 mt-1">{language.proxyAPIKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="leave blank if none" bind:value={presetStore.state.proxyKey} />

                                <span class="text-xs text-textcolor2 mt-1">{language.proxyRequestModel}</span>
                                {#if providerModelRole === 'main'}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={presetStore.state.customProxyRequestModel} placeholder="Model Name" />
                                {:else if isFeatureRole && currentOverride}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={currentOverride.customProxyRequestModel} placeholder="Model Name (override)" />
                                {:else}
                                    <TextInput marginBottom={false} size={"sm"} bind:value={presetStore.state.customProxySubRequestModel} placeholder="Model Name" />
                                {/if}

                                <span class="text-xs text-textcolor2 mt-1">{language.format}</span>
                                <SelectInput value={presetStore.state.customAPIFormat.toString()} onchange={(e) => {
                                    presetStore.state.customAPIFormat = parseInt(e.currentTarget.value) as LLMFormat
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
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('mistral', usesMistral)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Mistral AI</span>
                                {#if usesMistral}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('mistral', usesMistral)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('mistral', usesMistral)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Mistral {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.mistralKey} />
                            </div>
                        {/if}
                    </div>

                    <!-- Cohere -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('cohere', usesCohere)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Cohere</span>
                                {#if usesCohere}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('cohere', usesCohere)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('cohere', usesCohere)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Cohere {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} bind:value={settingsStore.state.cohereAPIKey} />
                            </div>
                        {/if}
                    </div>

                    <!-- NovelAI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('novelai', usesNovelAI)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">NovelAI</span>
                                {#if usesNovelAI}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('novelai', usesNovelAI)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('novelai', usesNovelAI)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">NovelAI Bearer Token</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={settingsStore.state.novelai.token} />
                            </div>
                        {/if}
                    </div>

                    <!-- NovelList -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('novellist', usesNovelList)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">NovelList</span>
                                {#if usesNovelList}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('novellist', usesNovelList)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('novellist', usesNovelList)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">NovelList {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.novellistAPI} />
                            </div>
                        {/if}
                    </div>

                    <!-- Mancer -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('mancer', usesMancer)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Mancer</span>
                                {#if usesMancer}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('mancer', usesMancer)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('mancer', usesMancer)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Mancer {language.apiKey}</span>
                                <TextInput hideText={settingsStore.state.hideApiKey} marginBottom={false} size={"sm"} placeholder="..." bind:value={settingsStore.state.mancerHeader} />
                            </div>
                        {/if}
                    </div>

                    <!-- AI Horde -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('horde', usesHorde)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">AI Horde</span>
                                {#if usesHorde}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('horde', usesHorde)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('horde', usesHorde)}
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
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('kobold', usesKobold)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Kobold</span>
                                {#if usesKobold}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('kobold', usesKobold)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('kobold', usesKobold)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Kobold URL</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={presetStore.state.koboldURL} />
                                <ChatFormatSettings />
                            </div>
                        {/if}
                    </div>

                    <!-- TextGen WebUI -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('textgen', usesTextGen)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">TextGen WebUI</span>
                                {#if usesTextGen}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('textgen', usesTextGen)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('textgen', usesTextGen)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Blocking {language.providerURL}</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={presetStore.state.textgenWebUIBlockingURL} placeholder="https://..." />
                                <span class="text-draculared text-xs">You must use textgen webui with --public-api</span>

                                <span class="text-xs text-textcolor2 mt-1">Stream {language.providerURL}</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={presetStore.state.textgenWebUIStreamURL} placeholder="wss://..." />
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
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('ooba', usesOoba)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Ooba</span>
                                {#if usesOoba}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('ooba', usesOoba)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('ooba', usesOoba)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <span class="text-xs text-textcolor2">Ooba {language.providerURL}</span>
                                <TextInput marginBottom={false} size={"sm"} bind:value={presetStore.state.textgenWebUIBlockingURL} placeholder="https://..." />
                            </div>
                        {/if}
                    </div>

                    <!-- Custom Plugin Provider -->
                    <div class="rounded-xl border border-darkborderc overflow-hidden bg-darkbg/25 transition-all">
                        <button
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('plugin', usesCustomPlugin)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">{language.plugin}</span>
                                {#if usesCustomPlugin}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('plugin', usesCustomPlugin)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('plugin', usesCustomPlugin)}
                            <div class="px-3.5 pb-3.5 pt-1 border-t border-darkborderc/40 flex flex-col gap-2">
                                <SelectInput bind:value={presetStore.state.currentPluginProvider}>
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
                            class="w-full px-3.5 py-2.5 flex items-center justify-between hover:bg-darkbutton/40 transition-colors text-left cursor-pointer"
                            onclick={() => toggleProvider('echo', usesEcho)}
                        >
                            <div class="flex items-center gap-2">
                                <span class="font-bold text-sm text-textcolor">Echo Model</span>
                                {#if usesEcho}
                                    <span class="px-1.5 py-0.2 rounded text-[10px] font-bold bg-selected text-textcolor">In Use</span>
                                {/if}
                            </div>
                            <span class="text-textcolor2">
                                {#if isProviderOpen('echo', usesEcho)}<ChevronUpIcon size={16} />{:else}<ChevronDownIcon size={16} />{/if}
                            </span>
                        </button>
                        {#if isProviderOpen('echo', usesEcho)}
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
    {#if presetStore.state.aiModel === 'textgen_webui' || presetStore.state.aiModel === 'mancer' || presetStore.state.aiModel.startsWith('local_') || presetStore.state.aiModel.startsWith('hf:::')}
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput min={1} max={1.5} step={0.01} fixed={2} marginBottom bind:value={presetStore.state.ooba.repetition_penalty}/>
        <span class="text-textcolor">Length Penalty</span>
        <SliderInput min={-5} max={5} step={0.05} marginBottom fixed={2} bind:value={presetStore.state.ooba.length_penalty}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom bind:value={presetStore.state.ooba.top_k} />
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.ooba.top_p}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.ooba.typical_p}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.ooba.top_a}/>
        <span class="text-textcolor">No Repeat n-gram Size</span>
        <SliderInput min={0} max={20} step={1} marginBottom bind:value={presetStore.state.ooba.no_repeat_ngram_size}/>
        <div class="flex items-center mt-4">
            <Check bind:check={presetStore.state.ooba.do_sample} name={'Do Sample'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={presetStore.state.ooba.add_bos_token} name={'Add BOS Token'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={presetStore.state.ooba.ban_eos_token} name={'Ban EOS Token'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={presetStore.state.ooba.skip_special_tokens} name={'Skip Special Tokens'}/>
        </div>
        <div class="flex items-center mt-4">
            <Check check={!!presetStore.state.localStopStrings} name={language.customStopWords} onChange={() => {
                if(!presetStore.state.localStopStrings){
                    presetStore.state.localStopStrings = []
                }
                else{
                    presetStore.state.localStopStrings = null
                }
            }} />
        </div>
        {#if presetStore.state.localStopStrings}
            <div class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1">
                <div class="p-2">
                    <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                        let localStopStrings = presetStore.state.localStopStrings
                        localStopStrings.push('')
                        presetStore.state.localStopStrings = localStopStrings
                    }}><PlusIcon /></button>
                </div>
                {#each presetStore.state.localStopStrings as stopString, i}
                    <div class="flex w-full">
                        <div class="grow">
                            <TextInput marginBottom bind:value={presetStore.state.localStopStrings[i]} fullwidth fullh/>
                        </div>
                        <div>
                            <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                                let localStopStrings = presetStore.state.localStopStrings
                                localStopStrings.splice(i, 1)
                                presetStore.state.localStopStrings = localStopStrings
                            }}><TrashIcon /></button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
        <div class="flex flex-col p-3 rounded-md border-selected border mt-4">
            <ChatFormatSettings />
        </div>
        <Check bind:check={presetStore.state.ooba.formating.useName} name={language.useNamePrefix}/>

    {:else if modelInfo.format === LLMFormat.NovelAI}
        <div class="flex flex-col p-3 bg-darkbg mt-4">
            <span class="text-textcolor">Starter</span>
            <TextInput bind:value={presetStore.state.NAIsettings.starter} placeholder={'⁂'} />
            <span class="text-textcolor">Seperator</span>
            <TextInput bind:value={presetStore.state.NAIsettings.seperator} placeholder={"\\n"}/>
        </div>
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.topP}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput min={0} max={100} step={1} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.topK}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.topA}/>
        <span class="text-textcolor">Tailfree Sampling</span>
        <SliderInput min={0} max={1} step={0.001} marginBottom fixed={3} bind:value={presetStore.state.NAIsettings.tailFreeSampling}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.typicalp}/>
        <span class="text-textcolor">Repetition Penalty</span>
        <SliderInput min={0} max={3} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.repetitionPenalty}/>
        <span class="text-textcolor">Repetition Penalty Range</span>
        <SliderInput min={0} max={8192} step={1} marginBottom fixed={0} bind:value={presetStore.state.NAIsettings.repetitionPenaltyRange}/>
        <span class="text-textcolor">Repetition Penalty Slope</span>
        <SliderInput min={0} max={10} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.repetitionPenaltySlope}/>
        <span class="text-textcolor">Frequency Penalty</span>
        <SliderInput min={-2} max={2} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.frequencyPenalty}/>
        <span class="text-textcolor">Presence Penalty</span>
        <SliderInput min={-2} max={2} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.presencePenalty}/>
        <span class="text-textcolor">Mirostat LR</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.mirostat_lr}/>
        <span class="text-textcolor">Mirostat Tau</span>
        <SliderInput min={0} max={6} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.mirostat_tau}/>
        <span class="text-textcolor">Cfg Scale</span>
        <SliderInput min={1} max={3} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.NAIsettings.cfg_scale}/>

    {:else if modelInfo.format === LLMFormat.NovelList}
        <span class="text-textcolor">Top P</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.ainconfig.top_p}/>
        <span class="text-textcolor">Reputation Penalty</span>
        <SliderInput min={0} max={2} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.ainconfig.rep_pen}/>
        <span class="text-textcolor">Reputation Penalty Range</span>
        <SliderInput min={0} max={2048} step={1} marginBottom fixed={2} bind:value={presetStore.state.ainconfig.rep_pen_range}/>
        <span class="text-textcolor">Reputation Penalty Slope</span>
        <SliderInput min={0} max={10} step={0.1} marginBottom fixed={2} bind:value={presetStore.state.ainconfig.rep_pen_slope}/>
        <span class="text-textcolor">Top K</span>
        <SliderInput min={1} max={500} step={1} marginBottom fixed={2} bind:value={presetStore.state.ainconfig.top_k}/>
        <span class="text-textcolor">Top A</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.ainconfig.top_a}/>
        <span class="text-textcolor">Typical P</span>
        <SliderInput min={0} max={1} step={0.01} marginBottom fixed={2} bind:value={presetStore.state.ainconfig.typical_p}/>
    {:else}
        <!-- Standard parameters now handled by SettingRenderer above -->
    {/if}

    {#if (settingsStore.state.reverseProxyOobaMode && presetStore.state.aiModel === 'reverse_proxy') || (presetStore.state.aiModel === 'ooba')}
        <OobaSettings instructionMode={presetStore.state.aiModel === 'ooba'} />
    {/if}

    {#if presetStore.state.aiModel.startsWith('openrouter')}
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
                        let bia = presetStore.state.bias
                        bia.push(['', 0])
                        presetStore.state.bias = bia
                    }}><PlusIcon /></button>
                </th>
            </tr>
            {#if presetStore.state.bias.length === 0}
                <tr>
                    <td colspan="3" class="text-textcolor2">{language.noBias}</td>
                </tr>
            {/if}
            {#each presetStore.state.bias as bias, i}
                <tr>
                    <td class="font-medium truncate">
                        <TextInput bind:value={presetStore.state.bias[i][0]} size="lg" fullwidth/>
                    </td>
                    <td class="font-medium truncate">
                        <NumberInput bind:value={presetStore.state.bias[i][1]} max={100} min={-101} size="lg" fullwidth/>
                    </td>
                    <td>
                        <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                            let bia = presetStore.state.bias
                            bia.splice(i, 1)
                            presetStore.state.bias = bia
                        }}><TrashIcon /></button>
                    </td>
                </tr>
            {/each}
            </tbody>
        </table>
        <div class="text-textcolor2 mt-2 flex items-center gap-2">
            <button class="font-medium cursor-pointer hover:text-textcolor gap-2" onclick={() => {
                const data = JSON.stringify(presetStore.state.bias, null, 2)
                downloadFile('bias.json', data)
            }}><DownloadIcon /></button>
            <button class="font-medium cursor-pointer hover:text-textcolor" onclick={async () => {
                const sel = await selectSingleFile(['json'])
                const utf8 = new TextDecoder().decode(sel.data)
                if(Array.isArray(JSON.parse(utf8))){
                    presetStore.state.bias = JSON.parse(utf8)
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
        {#if presetStore.state.promptTemplate}
            {#if submenu !== -1}
                <PromptSettings mode='inline' subMenu={1} />
            {/if}
        {:else}
            <Check check={false} name={language.usePromptTemplate} onChange={() => {
                presetStore.state.promptTemplate = []
            }}/>
        {/if}
    </Accordion>

    {#snippet CustomFlagButton(name:string,flag:number)}
        <Button className="mt-2" onclick={(e) => {
            if(presetStore.state.customFlags.includes(flag as LLMFlags)){
                presetStore.state.customFlags = presetStore.state.customFlags.filter((f: LLMFlags) => f !== flag)
            }
            else{
                presetStore.state.customFlags.push(flag as LLMFlags)
            }
        }} styled={presetStore.state.customFlags.includes(flag as LLMFlags) ? 'primary' : 'outlined'}>
            {name}
        </Button>
    {/snippet}

    <Accordion styled name={language.customFlags}>
        <Check bind:check={presetStore.state.enableCustomFlags} name={language.enableCustomFlags}/>


        {#if presetStore.state.enableCustomFlags}
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
        <TextAreaInput bind:value={presetStore.state.moduleIntergration} fullwidth height={"32"} autocomplete="off"/>
    </Accordion>

    <Accordion styled name={language.tools}>
        <Check name={language.search} check={presetStore.state.modelTools.includes('search')} onChange={() => {
            if(presetStore.state.modelTools.includes('search')){
                presetStore.state.modelTools = presetStore.state.modelTools.filter((tool: string) => tool !== 'search')
            }
            else{
                presetStore.state.modelTools.push('search')
            }
        }} />
    </Accordion>

    <Accordion styled name={language.regexScript}>
        <RegexList bind:value={presetStore.state.presetRegex} buttons />
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
            const objectUrl = URL.createObjectURL(blob)
            img.src = objectUrl
            try {
                await img.decode()
                canvas.width = 48
                canvas.height = 48
                ctx.drawImage(img, 0, 0, 48, 48)
                const data = canvas.toDataURL('image/jpeg', 0.7)
                const activePreset = presetStore.activePreset
                if (activePreset) {
                    await presetStore.savePreset({...activePreset, image: data})
                }
            } finally {
                img.src = ''
                URL.revokeObjectURL(objectUrl)
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
    {#if !presetStore.state.promptTemplate}
        <span class="text-textcolor">{language.mainPrompt} <Help key="mainprompt"/></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={presetStore.state.mainPrompt}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.mainPrompt} {language.tokens}</span>
        <span class="text-textcolor">{language.jailbreakPrompt} <Help key="jailbreak"/></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={presetStore.state.jailbreak}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.jailbreak} {language.tokens}</span>
        <span class="text-textcolor">{language.globalNote} <Help key="globalNote"/></span>
        <TextAreaInput fullwidth autocomplete="off" height={"32"} bind:value={presetStore.state.globalNote}></TextAreaInput>
        <span class="text-textcolor2 mb-6 text-sm mt-2">{tokens.globalNote} {language.tokens}</span>
        <span class="text-textcolor mb-2 mt-4">{language.formatingOrder} <Help key="formatOrder"/></span>
        <DropList bind:list={presetStore.state.formatingOrder} />
        <div class="flex items-center mt-4">
            <Check bind:check={presetStore.state.promptPreprocess} name={language.promptPreprocess}/>
        </div>
    {:else if submenu === 2}
        <PromptSettings mode='inline' />
    {/if}
{/if}


{#if presetStore.state.promptTemplate && submenu === -1}
    <div class="mt-2">
        <Button onclick={goPromptTemplate} size="sm">{language.promptTemplate}</Button>
    </div>
{/if}
{#if submenu === -1}
    <Button onclick={() => {$openPresetList = true}} className="mt-4">{language.presets}</Button>
{/if}
