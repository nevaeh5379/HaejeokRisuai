<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
  import PromptTemplateEditor from "src/lib/UI/PromptTemplateEditor.svelte";
  import { ArrowLeft, PlusIcon, TrashIcon } from "@lucide/svelte";
    import { language } from "src/lang";

    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import ModelList from "src/lib/UI/ModelList.svelte";
    import {defaultAutoSuggestPrompt} from "../../../ts/storage/presets/defaultPrompts";
    import AuxModelSelectors from './Model/AuxModelSelectors.svelte'

  interface Props {
    onGoBack?: () => void;
    mode?: 'independent'|'inline';
    subMenu?: number;
  }

  let { onGoBack = () => {}, mode = 'independent', subMenu = $bindable(0) }: Props = $props();
</script>
{#if mode === 'independent'}
    <h2 class="mb-2 text-2xl font-bold mt-2 items-center flex">
        <button class="mr-2 text-textcolor2 hover:text-textcolor" onclick={onGoBack}>
            <ArrowLeft />
        </button>
        {language.promptTemplate}
    </h2>

    <div class="flex w-full rounded-md border border-selected">
        <button onclick={() => {
            subMenu = 0
        }} class="p-2 flex-1" class:bg-selected={subMenu === 0}>
            <span>{language.template}</span>
        </button>
        <button onclick={() => {
            subMenu = 1
        }} class="p-2 flex-1" class:bg-selected={subMenu === 1}>
            <span>{language.settings}</span>
        </button>
    </div>
{/if}
{#if subMenu === 0}
    <PromptTemplateEditor
        bind:template={presetStore.state.promptTemplate}
        promptSettings={presetStore.state.promptSettings}
    />
{:else}
    <span class="text-textcolor mt-4">{language.postEndInnerFormat}</span>
    <TextInput bind:value={presetStore.state.promptSettings.postEndInnerFormat}/>

    <Check bind:check={presetStore.state.promptSettings.sendChatAsSystem} name={language.sendChatAsSystem} className="mt-4"/>
    <Check bind:check={presetStore.state.promptSettings.sendName} name={language.formatGroupInSingle} className="mt-4"/>
    <Check bind:check={presetStore.state.promptSettings.trimStartNewChat} name={language.trimStartNewChat} className="mt-4"/>
    <Check bind:check={presetStore.state.promptSettings.utilOverride} name={language.utilOverride} className="mt-4"/>
    <Check bind:check={presetStore.state.jsonSchemaEnabled} name={language.enableJsonSchema} className="mt-4"/>
    <Check bind:check={presetStore.state.outputImageModal} name={language.outputImageModal} className="mt-4"/>

    <Check bind:check={presetStore.state.strictJsonSchema} name={language.strictJsonSchema} className="mt-4"/>

    {#if settingsStore.state.showUnrecommended}
        <Check bind:check={presetStore.state.promptSettings.customChainOfThought} name={language.customChainOfThought} className="mt-4">
            <Help unrecommended key='customChainOfThought' />
        </Check>
    {/if}
    <span class="text-textcolor mt-4">{language.maxThoughtTagDepth}</span>
    <NumberInput bind:value={presetStore.state.promptSettings.maxThoughtTagDepth}/>
    <span class="text-textcolor mt-4">{language.groupOtherBotRole} <Help key="groupOtherBotRole"/></span>
    <SelectInput bind:value={presetStore.state.groupOtherBotRole}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="system">System</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    <span class="text-textcolor mt-4">{language.customPromptTemplateToggle} <Help key='customPromptTemplateToggle' /></span>
    <TextAreaInput bind:value={presetStore.state.customPromptTemplateToggle}/>
    <span class="text-textcolor mt-4">{language.defaultVariables} <Help key='defaultVariables' /></span>
    <TextAreaInput bind:value={presetStore.state.templateDefaultVariables}/>
    <span class="text-textcolor mt-4">{language.predictedOutput}</span>
    <TextAreaInput bind:value={settingsStore.state.OAIPrediction}/>
    <span class="text-textcolor mt-4">{language.autoSuggest} <Help key='autoSuggest' /></span>
    <TextAreaInput bind:value={presetStore.state.autoSuggestPrompt} placeholder={defaultAutoSuggestPrompt}/>
    <span class="text-textcolor mt-4">{language.groupInnerFormat} <Help key='groupInnerFormat' /></span>
    <TextAreaInput placeholder={`<{{char}}\'s Message>\n{{slot}}\n</{{char}}\'s Message>`} bind:value={presetStore.state.groupTemplate}/>
    <span class="text-textcolor mt-4">{language.systemContentReplacement} <Help key="systemContentReplacement"/></span>
    <TextAreaInput bind:value={presetStore.state.systemContentReplacement}/>
    <span class="text-textcolor mt-4">{language.systemRoleReplacement} <Help key="systemRoleReplacement"/></span>
    <SelectInput bind:value={presetStore.state.systemRoleReplacement}>
        <OptionInput value="user">User</OptionInput>
        <OptionInput value="assistant">assistant</OptionInput>
    </SelectInput>
    {#if presetStore.state.jsonSchemaEnabled}
        <span class="text-textcolor mt-4">{language.jsonSchema} <Help key='jsonSchema' /></span>
        <TextAreaInput bind:value={presetStore.state.jsonSchema}/>
        <span class="text-textcolor mt-4">{language.extractJson} <Help key='extractJson' /></span>
        <TextInput bind:value={presetStore.state.extractJson}/>
    {/if}

    {#if !settingsStore.state.auxModelUnderModelSettings}
        <AuxModelSelectors />
    {/if}

    {#snippet fallbackModelList(arg:'model'|'memory'|'translate'|'emotion'|'otherAx')}
        {#each presetStore.state.fallbackModels[arg] as model, i}
            <span class="text-textcolor mt-4">
                {language.model} {i + 1}
            </span>
            <ModelList bind:value={presetStore.state.fallbackModels[arg][i]} blankable />
        {/each}
        <div class="flex gap-2">
            <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                let value = presetStore.state.fallbackModels[arg] ?? []
                value.push('')
                presetStore.state.fallbackModels[arg] = value
            }}><PlusIcon /></button>
            <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                let value = presetStore.state.fallbackModels[arg] ?? []
                value.pop()
                presetStore.state.fallbackModels[arg] = value
            }}><TrashIcon /></button>
        </div>
    {/snippet}

    <Accordion name={language.fallbackModel} styled>
        <Check bind:check={presetStore.state.fallbackWhenBlankResponse} name={language.fallbackWhenBlankResponse} className="mt-4"/>
        <Check bind:check={settingsStore.state.doNotChangeFallbackModels} name={language.doNotChangeFallbackModels} className="mt-4"/>

        <Accordion name={language.model} styled>
            {@render fallbackModelList('model')}
        </Accordion>
        <Accordion name={"Memory"} styled>
            {@render fallbackModelList('memory')}
        </Accordion>
        <Accordion name={"Translations"} styled>
            {@render fallbackModelList('translate')}
        </Accordion>
        <Accordion name={"Emotion"} styled>
            {@render fallbackModelList('emotion')}
        </Accordion>
        <Accordion name={"OtherAx"} styled>
            {@render fallbackModelList('otherAx')}
        </Accordion>
    </Accordion>

{/if}
