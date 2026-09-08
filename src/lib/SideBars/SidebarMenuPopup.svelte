<script lang="ts">
  import {
    HomeIcon,
    LayoutGridIcon,
    SearchIcon,
    Settings,
    ShellIcon,
  } from "@lucide/svelte";
  import { onMount } from "svelte";
  import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
  import {
    TAURI_SIDEBAR_MENU_ACTION_EVENT,
    type TauriSidebarMenuLaunch,
    type TauriSidebarMenuPopupPayload,
    type TauriSidebarMenuAction,
  } from "src/ts/tauriSidebarMenu";

  let {
    launch,
    payload,
  }: {
    launch: TauriSidebarMenuLaunch;
    payload: TauriSidebarMenuPopupPayload;
  } = $props();

  let popupStyle = $derived.by(() =>
    [
      `--risu-popup-text:${payload.theme.textColor}`,
      `--risu-popup-selected:${payload.theme.selectedColor}`,
      `--risu-popup-darkbg:${payload.theme.darkBg}`,
    ].join(";"),
  );

  async function closePopup() {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    await getCurrentWebviewWindow().close();
  }

  async function activate(action: TauriSidebarMenuAction) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const current = getCurrentWebviewWindow();
    try {
      await current.emitTo(launch.sourceWindowLabel, TAURI_SIDEBAR_MENU_ACTION_EVENT, {
        action,
      });
    } finally {
      await current.close();
    }
  }

  onMount(() => {
    let disposed = false;
    let unlistenFocus: (() => void) | undefined;
    void import("@tauri-apps/api/webviewWindow").then(async ({ getCurrentWebviewWindow }) => {
      const current = getCurrentWebviewWindow();
      const unlisten = await current.onFocusChanged(({ payload: focused }) => {
        if (!focused) void current.close();
      });
      if (disposed) unlisten();
      else unlistenFocus = unlisten;
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void closePopup();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      disposed = true;
      unlistenFocus?.();
      window.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

<div class="rs-native-sidebar-menu-popup" style={popupStyle}>
  {#each payload.items as item}
    <button
      class="rs-native-sidebar-menu-item"
      title={item.name}
      aria-label={item.name}
      onclick={() => void activate(item.action)}
    >
      {#if item.iconType === "builtin"}
        {#if item.icon === "settings"}
          <Settings />
        {:else if item.icon === "home"}
          <HomeIcon />
        {:else if item.icon === "playground"}
          <ShellIcon />
        {:else if item.icon === "search"}
          <SearchIcon />
        {:else if item.icon === "grid"}
          <LayoutGridIcon />
        {/if}
      {:else}
        <PluginDefinedIcon
          ico={{ iconType: item.iconType, icon: item.icon }}
          className="w-5 h-5"
        />
      {/if}
    </button>
  {/each}
</div>
