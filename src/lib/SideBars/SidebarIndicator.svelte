<script lang="ts">
  interface Props {
    isActive: boolean;
  }

  let { isActive }: Props = $props();
</script>

<div
  class="
      rs-sidebar-indicator
      group-hover:bg-white
      absolute
      left-[-4px]
      h-[8px]
      w-[8px]
      rounded-full
      transition-all
      duration-300
      {isActive ? 'bg-white h-[20px]! rs-sidebar-indicator-active' : 'group-hover:h-[10px]'}
    "
></div>
