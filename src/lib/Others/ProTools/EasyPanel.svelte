<script lang="ts">
    import { language } from "src/lang";
    import ClaudeThinkingSeparateParams from "src/lib/Setting/Pages/ClaudeThinkingSeparateParams.svelte";
    import SegmentedControl from "src/lib/UI/GUI/SegmentedControl.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import { easyPanelStore } from "src/ts/stores.svelte";
    import { settingsStore } from "src/ts/stores/domain";
    import Help from "../Help.svelte";
    import Button from "src/lib/UI/GUI/Button.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import AllSeperateParameters from "../AllSeperateParameters.svelte";
    import { onMount } from "svelte";
    import { XIcon } from "@lucide/svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import CustomModelsSettings from "src/lib/Setting/Pages/Advanced/CustomModelsSettings.svelte";
    import { saveCurrentPreset } from "../../../ts/storage/presetService";

    let selectedOption = $state('models');
    let selectedParameterOption = $state('memory')
    let parameterModelSelection = $state('')

    let hasEPRequirements = $derived.by(() => {
        return  settingsStore.state.seperateParametersEnabled &&
                settingsStore.state.doNotChangeSeperateModels &&
                settingsStore.state.seperateModels &&
                settingsStore.state.epEnabled &&
                settingsStore.state.disableSeperateParameterChangeOnPresetChange
    })

    const onClose = () => {
        easyPanelStore.open = false
    }

    function persistModelSelection() {
        void saveCurrentPreset();
    }

</script>

<div class="fixed z-50 w-dvw h-dvh top-0 left-0 pointer-events-none flex justify-stretch items-stretch">
    <div class="m-4 p-4 bg-bgcolor/80 backdrop-blur-sm rounded-lg shadow-lg pointer-events-auto flex-1 flex flex-col overflow-y-auto">
        <h2 class="text-lg font-bold mb-2 flex items-center">
            {language.easyPanel}
            <div class="ml-2 bg-blue-800 p-1 rounded text-sm">Beta</div>
            <button class="ml-auto p-1 rounded hover:bg-selected" onclick={() => {
                onClose()
            }}>
                <XIcon size={28} class="ml-auto hover:bg-selected rounded"></XIcon>
            </button>
        </h2>
        <SegmentedControl
            options={[
                { label: language.model, value: 'models' },
                { label: language.parameters, value: 'parameters' },
                { label: language.customModels, value: 'customModels' },
                { label: language.settings, value: 'settings' },
            ]}
            bind:value={selectedOption}
            size="md"
        />

        {#if !hasEPRequirements}
            <div class="mt-4 p-4 bg-yellow-100 text-yellow-800 rounded">
                {language.epRequirementsNotMet}
            </div>

            <Button className="mt-4" onclick={() => {
                settingsStore.state.seperateParametersEnabled = true
                settingsStore.state.doNotChangeSeperateModels = true
                settingsStore.state.seperateModels = {
                    memory: '',
                    translate: '',
                    emotion: '',
                    otherAx: ''
                }
                settingsStore.state.epEnabled = true
                settingsStore.state.disableSeperateParameterChangeOnPresetChange = true
            }}>
                {language.run}
            </Button>

        {:else if selectedOption === 'models'}
             <div class="w-full grid grid-cols-1 md:grid-cols-2 gap-4 mt-4 justify-center items-center">
                <div class="col-span-1">
                    <span class="text-textcolor">{language.mainModel}</span>
                    <ModelList bind:value={settingsStore.state.aiModel} blankable excludesPrefix="plugin" onChange={persistModelSelection}/>
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.submodel}</span>
                    <ModelList bind:value={settingsStore.state.subModel} blankable excludesPrefix="plugin" onChange={persistModelSelection}/>
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.longTermMemory}</span>
                    <ModelList bind:value={settingsStore.state.seperateModels.memory} blankable excludesPrefix="plugin" onChange={persistModelSelection}/>
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.translator}</span>
                    <ModelList bind:value={settingsStore.state.seperateModels.translate} blankable excludesPrefix="plugin" onChange={persistModelSelection}/>
                </div>
                <div class="col-span-1">
                    <span class="text-textcolor">{language.emotionImage}</span>
                    <ModelList bind:value={settingsStore.state.seperateModels.emotion} blankable excludesPrefix="plugin" onChange={persistModelSelection}/>
                </div>

                <div class="col-span-1">
                    <span class="text-textcolor">{language.others}</span>
                    <ModelList bind:value={settingsStore.state.seperateModels.otherAx} blankable excludesPrefix="plugin" onChange={persistModelSelection}/>
                </div>
                
            </div>
        {/if}
        {#if selectedOption === 'parameters'}

            {#if settingsStore.state.seperateParametersByModel}

                <ModelList bind:value={parameterModelSelection} blankable excludesPrefix="plugin" onChange={(v) => {
                    settingsStore.state.seperateParameters.overrides ??= {}
                    settingsStore.state.seperateParameters.overrides[v] ??= {}
                }}/>

                {#if parameterModelSelection !== ''}
                    <AllSeperateParameters bind:value={settingsStore.state.seperateParameters.overrides[parameterModelSelection]} withImportExport paramKey={parameterModelSelection} />

                {/if}
            {:else}
                <SegmentedControl
                    options={[
                        { label: language.longTermMemory, value: 'memory' },
                        { label: language.translator, value: 'translate' },
                        { label: language.emotionImage, value: 'emotion' },
                        { label: language.others, value: 'otherAx' },
                    ]}
                    bind:value={selectedParameterOption}
                    size="md"
                />
                <div class="w-full mt-4 flex flex-col">
                    {#if selectedParameterOption === 'memory'}
                        <AllSeperateParameters bind:value={settingsStore.state.seperateParameters.memory} withImportExport paramKey="memory" />
                    {:else if selectedParameterOption === 'translate'}
                        <AllSeperateParameters bind:value={settingsStore.state.seperateParameters.translate} withImportExport paramKey="translate" />
                    {:else if selectedParameterOption === 'emotion'}
                        <AllSeperateParameters bind:value={settingsStore.state.seperateParameters.emotion} withImportExport paramKey="emotion" />
                    {:else if selectedParameterOption === 'otherAx'}
                        <AllSeperateParameters bind:value={settingsStore.state.seperateParameters.otherAx} withImportExport paramKey="otherAx" />
                    {/if}
                </div>

            {/if}
        {:else if selectedOption === 'customModels'}
            <CustomModelsSettings noAccordion />
        {:else if selectedOption === 'settings'}
             <CheckInput name={language.seperateParametersByModel} bind:check={settingsStore.state.seperateParametersByModel}/>
        {/if}
    </div>
</div>
