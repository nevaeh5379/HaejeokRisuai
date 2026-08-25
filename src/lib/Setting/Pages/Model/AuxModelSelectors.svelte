<script lang="ts">
  import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
  import Check from "src/lib/UI/GUI/CheckInput.svelte";
  import { language } from 'src/lang';
  import ModelList from 'src/lib/UI/ModelList.svelte';
  import { BrainIcon, GlobeIcon, SmileIcon, CpuIcon } from "@lucide/svelte";
</script>

<div class="mt-4 flex flex-col gap-3">
  <div class="p-4 rounded-xl border border-darkborderc bg-darkbg/40 flex flex-col gap-3">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <div>
        <h4 class="font-bold text-sm text-textcolor flex items-center gap-2">
          {language.seperateModelsForAxModels || "Separate Auxiliary Models"}
        </h4>
        <p class="text-xs text-textcolor2 mt-0.5">
          {language.auxModelsSplitCardDesc || "Assign dedicated AI models for specific features (Memory, Translation, Emotion, Other)."}
        </p>
      </div>
      <div class="shrink-0">
        <Check bind:check={settingsStore.state.seperateModelsForAxModels} name="" />
      </div>
    </div>

    {#if settingsStore.state.seperateModelsForAxModels}
      <div class="pt-2 border-t border-darkborderc/60 flex items-center">
        <Check bind:check={settingsStore.state.doNotChangeSeperateModels} name={language.doNotChangeSeperateModels} />
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mt-1">
        <!-- Memory Model -->
        <div class="p-3.5 rounded-xl border border-darkborderc bg-bgcolor/80 flex flex-col justify-between">
          <div class="flex items-center gap-2 mb-2">
            <div class="p-1.5 rounded-lg bg-purple-500/15 text-purple-400">
              <BrainIcon size={16} />
            </div>
            <div>
              <span class="font-bold text-sm text-textcolor block">Memory</span>
              <span class="text-[11px] text-textcolor2">HypaMemory / Summaries</span>
            </div>
          </div>
          <ModelList bind:value={settingsStore.state.seperateModels.memory} blankable noMargin />
        </div>

        <!-- Translation Model -->
        <div class="p-3.5 rounded-xl border border-darkborderc bg-bgcolor/80 flex flex-col justify-between">
          <div class="flex items-center gap-2 mb-2">
            <div class="p-1.5 rounded-lg bg-sky-500/15 text-sky-400">
              <GlobeIcon size={16} />
            </div>
            <div>
              <span class="font-bold text-sm text-textcolor block">Translations</span>
              <span class="text-[11px] text-textcolor2">Input / Output Auto-translation</span>
            </div>
          </div>
          <ModelList bind:value={settingsStore.state.seperateModels.translate} blankable noMargin />
        </div>

        <!-- Emotion Model -->
        <div class="p-3.5 rounded-xl border border-darkborderc bg-bgcolor/80 flex flex-col justify-between">
          <div class="flex items-center gap-2 mb-2">
            <div class="p-1.5 rounded-lg bg-amber-500/15 text-amber-400">
              <SmileIcon size={16} />
            </div>
            <div>
              <span class="font-bold text-sm text-textcolor block">Emotion</span>
              <span class="text-[11px] text-textcolor2">Emotion Expressions & Sprites</span>
            </div>
          </div>
          <ModelList bind:value={settingsStore.state.seperateModels.emotion} blankable noMargin />
        </div>

        <!-- Other Auxiliary Model -->
        <div class="p-3.5 rounded-xl border border-darkborderc bg-bgcolor/80 flex flex-col justify-between">
          <div class="flex items-center gap-2 mb-2">
            <div class="p-1.5 rounded-lg bg-emerald-500/15 text-emerald-400">
              <CpuIcon size={16} />
            </div>
            <div>
              <span class="font-bold text-sm text-textcolor block">Other Auxiliary</span>
              <span class="text-[11px] text-textcolor2">Secondary Tasks & Tools</span>
            </div>
          </div>
          <ModelList bind:value={settingsStore.state.seperateModels.otherAx} blankable noMargin />
        </div>
      </div>
    {/if}
  </div>
</div>
