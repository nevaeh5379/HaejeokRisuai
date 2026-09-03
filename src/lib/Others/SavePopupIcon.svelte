<script lang="ts">
  import { CheckIcon, OctagonAlert, SaveIcon } from "@lucide/svelte";
  import { alertMd } from "src/ts/alert";
  import { AccountWarning, saving } from "src/ts/stores.svelte";
  import { settingsStore } from "src/ts/stores/domain";

  let savedVisible = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let wasSaving = false;

  $effect(() => {
    const isSaving = saving.state;
    if (isSaving) {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      savedVisible = false;
      wasSaving = true;
    } else if (wasSaving) {
      wasSaving = false;
      if (settingsStore.state?.showSavingIcon) {
        savedVisible = true;
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          savedVisible = false;
          hideTimer = null;
        }, 2500);
      }
    }

    return () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    };
  });
</script>

{#if settingsStore.state?.showSavingIcon && (saving.state || savedVisible)}
  <div
    data-save-indicator={saving.state ? "saving" : "saved"}
    class="absolute top-3 right-3 z-50 text-white p-2 rounded-sm pointer-events-none opacity-15 transition-all duration-300 {saving.state
      ? 'bg-linear-to-br from-blue-500 to-purple-800 saving-animation'
      : 'bg-linear-to-br from-emerald-500 to-teal-700'}"
  >
    {#if saving.state}
      <SaveIcon size={24} />
    {:else}
      <CheckIcon size={24} />
    {/if}
  </div>
{:else if $AccountWarning}
  <button
    class="absolute top-3 right-3 z-50 text-white bg-red-800 hover:bg-red-600 p-2 rounded-sm"
    onclick={() => {
      alertMd($AccountWarning);
      $AccountWarning = "";
    }}
  >
    <OctagonAlert size={24} />
  </button>
{/if}

