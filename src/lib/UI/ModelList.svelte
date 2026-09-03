<script lang="ts">
  import { settingsStore } from 'src/ts/stores/domain';
  import { getHordeModels } from "src/ts/horde/getModels";
  import Accordion from "./Accordion.svelte";
  import { language } from "src/lang";
  import CheckInput from "./GUI/CheckInput.svelte";
  import { getModelInfo, getModelList } from 'src/ts/model/modellist';
  import { ArrowLeft } from "@lucide/svelte";

  interface Props {
    value?: string;
    onChange?: (v: string) => void;
    onclick?: (event: MouseEvent & {
      currentTarget: EventTarget & HTMLDivElement;
    }) => any;
    blankable?: boolean;
    excludesPrefix?: string;
    noMargin?: boolean;
    inlineCard?: boolean;
    noneText?: string;
  }

  let { 
    value = $bindable(), 
    onChange = (v) => {}, 
    onclick, 
    blankable, 
    excludesPrefix, 
    noMargin,
    inlineCard = false,
    noneText
  }: Props = $props();

  let openOptions = $state(false);

  function changeModel(name: string) {
    value = name;
    openOptions = false;
    onChange(name);
  }

  let showUnrec = $state(false);
  let providers = $derived(getModelList({
    recommendedOnly: !showUnrec,
    groupedByProvider: true
  }));
</script>

{#if openOptions}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div 
    class="fixed top-0 w-full h-full left-0 bg-black/50 z-50 flex justify-center items-center backdrop-blur-[2px]" 
    role="button" 
    tabindex="0" 
    onclick={() => { openOptions = false; }}
  >
    <div 
      class="w-96 max-w-full max-h-[85vh] overflow-y-auto overflow-x-hidden bg-bgcolor p-4 flex flex-col rounded-2xl border border-darkborderc shadow-2xl" 
      role="button" 
      tabindex="0" 
      onclick={(e) => {
        e.stopPropagation();
        onclick?.(e);
      }}
    >
      <div class="flex items-center gap-3 mb-4">
        <button 
          class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0 cursor-pointer"
          onclick={() => { openOptions = false; }}
          title="Back"
        >
          <ArrowLeft size={20} />
        </button>
        <h1 class="font-bold text-xl flex-1">{language.model}</h1>
      </div>
      <div class="border-t border-darkborderc mb-2"></div>

      {#each providers as provider}
        {#if provider.providerName === '@as-is'}
          {#each provider.models as model}
            <button class="hover:bg-selected px-4 py-2 text-base text-left rounded-lg transition-colors cursor-pointer" onclick={() => { changeModel(model.id); }}>{model.name}</button>
          {/each}
        {:else}
          <Accordion name={provider.providerName}>
            {#each provider.models.filter(m => !excludesPrefix || !m.id.startsWith(excludesPrefix)) as model}
              <button class="hover:bg-selected px-4 py-2 text-base text-left rounded-lg transition-colors cursor-pointer" onclick={() => { changeModel(model.id); }}>{model.name}</button>
            {/each}
          </Accordion>
        {/if}
      {/each}

      <Accordion name="Horde">
        {#await getHordeModels()}
          <button class="p-2 text-left text-textcolor2">Loading...</button>
        {:then models}
          <button onclick={() => { changeModel("horde:::auto"); }} class="p-2 hover:text-green-500 text-left cursor-pointer">
            Auto Model
            <br><span class="text-textcolor2 text-xs">Performance: Auto</span>
          </button>
          {#each models as model}
            <button onclick={() => { changeModel("horde:::" + model.name); }} class="p-2 hover:text-green-500 text-left cursor-pointer">
              {model.name.trim()}
              <br><span class="text-textcolor2 text-xs">Performance: {model.performance.toFixed(1)}</span>
            </button>
          {/each}
        {/await}
      </Accordion>

      {#if settingsStore.state.customModels?.length > 0}
        <Accordion name={language.customModels}>
          {#each settingsStore.state.customModels as model}
            <button class="hover:bg-selected px-4 py-2 text-base text-left rounded-lg transition-colors cursor-pointer" onclick={() => { changeModel(model.id); }}>{model.name || "Unnamed"}</button>
          {/each}
        </Accordion>
      {/if}

      {#if blankable}
        <button class="hover:bg-selected px-4 py-2 text-base text-left rounded-lg transition-colors cursor-pointer" onclick={() => { changeModel(''); }}>{noneText || language.none}</button>
      {/if}

      <div class="text-textcolor2 text-xs mt-3 pt-2 border-t border-darkborderc">
        <CheckInput name={language.showUnrecommended} grayText bind:check={showUnrec}/>
      </div>
    </div>
  </div>
{/if}

<button 
  type="button"
  onclick={() => { openOptions = true; }}
  class="drop-shadow-lg p-2.5 flex justify-center items-center rounded-md bg-darkbutton border-darkborderc border text-textcolor hover:bg-selected transition-colors text-sm cursor-pointer {noMargin ? '' : 'my-2'}"
>
  {value ? getModelInfo(value)?.fullName || value : (noneText || language.none)}
</button>
