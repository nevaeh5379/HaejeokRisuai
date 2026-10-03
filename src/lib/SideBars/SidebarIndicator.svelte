<script lang="ts">
  import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";

  interface Props {
    isActive: boolean;
  }

  let { isActive }: Props = $props();
  let botListRight = $derived(
    !!(settingsStore.state.useExperimental && settingsStore.state.botListRight)
  );
</script>

<div
  class="
      rs-sidebar-indicator
      group-hover:bg-white
      absolute
      h-[8px]
      w-[8px]
      rounded-full
      transition-all
      duration-300
      {isActive ? 'bg-white h-[20px]! rs-sidebar-indicator-active' : 'group-hover:h-[10px]'}
    "
  class:left-[-4px]={!botListRight}
  class:right-[-4px]={botListRight}
></div>
