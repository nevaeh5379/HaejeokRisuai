<script lang="ts">
  import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte'
  import Check from "src/lib/UI/GUI/CheckInput.svelte"
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import { language } from 'src/lang'
  import ModelList from 'src/lib/UI/ModelList.svelte'
</script>

<div class="flex items-center mt-4">
  <Check bind:check={settingsStore.state.seperateModelsForAxModels} name={language.seperateModelsForAxModels}></Check>
</div>
{#if settingsStore.state.seperateModelsForAxModels}
  <Check bind:check={settingsStore.state.doNotChangeSeperateModels} name={language.doNotChangeSeperateModels}></Check>
  <Accordion name={language.axModelsDef} styled>
    <span class="text-textcolor mt-4"> Memory </span>
    <ModelList bind:value={settingsStore.state.seperateModels.memory} blankable />

    <span class="text-textcolor mt-4"> Translations </span>
    <ModelList bind:value={settingsStore.state.seperateModels.translate} blankable />

    <span class="text-textcolor mt-4"> Emotion </span>

    <ModelList bind:value={settingsStore.state.seperateModels.emotion} blankable />

    <span class="text-textcolor mt-4"> OtherAx </span>

    <ModelList bind:value={settingsStore.state.seperateModels.otherAx} blankable />
  </Accordion>
{/if}
