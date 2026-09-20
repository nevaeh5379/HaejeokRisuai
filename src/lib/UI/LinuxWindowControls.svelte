<script lang="ts">
  import { CopyIcon, MinusIcon, SquareIcon, XIcon } from "@lucide/svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { onMount } from "svelte";

  const currentWindow = getCurrentWindow();
  let maximized = $state(false);

  async function refreshMaximized() {
    maximized = await currentWindow.isMaximized().catch(() => false);
  }

  async function minimize() {
    await currentWindow.minimize();
  }

  async function toggleMaximize() {
    await currentWindow.toggleMaximize();
    await refreshMaximized();
  }

  async function closeWindow() {
    await currentWindow.close();
  }

  onMount(() => {
    void refreshMaximized();
    const unlisten = currentWindow.onResized(() => {
      void refreshMaximized();
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  });
</script>

<div class="rs-linux-csd-controls" data-no-window-drag>
  <button
    type="button"
    class="rs-linux-csd-caption-button"
    aria-label="Minimize"
    title="Minimize"
    onclick={() => void minimize()}
  >
    <MinusIcon size={15} strokeWidth={1.8} />
  </button>
  <button
    type="button"
    class="rs-linux-csd-caption-button"
    aria-label={maximized ? "Restore" : "Maximize"}
    title={maximized ? "Restore" : "Maximize"}
    onclick={() => void toggleMaximize()}
  >
    {#if maximized}
      <CopyIcon size={13} strokeWidth={1.7} />
    {:else}
      <SquareIcon size={12} strokeWidth={1.7} />
    {/if}
  </button>
  <button
    type="button"
    class="rs-linux-csd-caption-button rs-linux-csd-close"
    aria-label="Close"
    title="Close"
    onclick={() => void closeWindow()}
  >
    <XIcon size={16} strokeWidth={1.8} />
  </button>
</div>
