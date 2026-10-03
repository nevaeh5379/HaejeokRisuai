<script lang="ts">
  import { tilt } from "src/ts/gui/tilt";

  interface Props {
    isDisabled?: boolean;
    onClick: () => void;
    children?: import('svelte').Snippet;
  }

  let { isDisabled = false, onClick, children }: Props = $props();
</script>

<button
  disabled={isDisabled}
  onclick={onClick}
  use:tilt
  class="flex h-[56px] w-[56px] cursor-pointer select-none items-center justify-center
   rounded-full border border-textcolor2 text-gray-300
   hover:border-gray-300 rs-sidebar-bot-btn
   {isDisabled ? 'cursor-not-allowed!' : ''}"
>
  {@render children?.()}
</button>
