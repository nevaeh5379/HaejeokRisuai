<script lang="ts">
  import {
    HomeIcon,
    LayoutGridIcon,
    SearchIcon,
    Settings,
    ShellIcon,
  } from "@lucide/svelte";
  import { onMount, tick } from "svelte";
  import PluginDefinedIcon from "../Others/PluginDefinedIcon.svelte";
  import {
    TAURI_SIDEBAR_MENU_ACTION_EVENT,
    TAURI_SIDEBAR_MENU_BLUR_ARM_EVENT,
    TAURI_SIDEBAR_MENU_PAYLOAD_EVENT,
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

  let currentPayload = $state<TauriSidebarMenuPopupPayload | null>(null);

  let popupStyle = $derived.by(() => {
    const activePayload = currentPayload ?? payload;
    return [
      `--risu-popup-text:${activePayload.theme.textColor}`,
      `--risu-popup-selected:${activePayload.theme.selectedColor}`,
      `--risu-popup-darkbg:${activePayload.theme.darkBg}`,
    ].join(";");
  });

  async function hidePopup(reason: "escape" | "action" | "blur") {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("hide_sidebar_menu_window", {
      popupLabel: launch.popupWindowLabel,
      reason,
    });
  }

  async function activate(action: TauriSidebarMenuAction) {
    const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const current = getCurrentWebviewWindow();
    try {
      await current.emitTo(launch.sourceWindowLabel, TAURI_SIDEBAR_MENU_ACTION_EVENT, {
        action,
      });
    } finally {
      await hidePopup("action");
    }
  }

  onMount(() => {
    currentPayload = payload;
    let disposed = false;
    let blurArmRequested = false;
    let blurArmed = false;
    let focusCloseTimer: ReturnType<typeof setTimeout> | undefined;
    let unlistenFocus: (() => void) | undefined;
    let unlistenPayload: (() => void) | undefined;
    let unlistenBlurArm: (() => void) | undefined;

    void Promise.all([
      import("@tauri-apps/api/webviewWindow"),
      import("@tauri-apps/api/core"),
    ]).then(async ([{ getCurrentWebviewWindow }, { invoke }]) => {
      const current = getCurrentWebviewWindow();
      const stopPayload = await current.listen<TauriSidebarMenuPopupPayload>(
        TAURI_SIDEBAR_MENU_PAYLOAD_EVENT,
        ({ payload: nextPayload }) => {
          currentPayload = nextPayload;
        },
      );
      const stopBlurArm = await current.listen<boolean>(
        TAURI_SIDEBAR_MENU_BLUR_ARM_EVENT,
        ({ payload: shouldArm }) => {
          blurArmRequested = shouldArm;
          blurArmed = false;
          if (focusCloseTimer) clearTimeout(focusCloseTimer);
          focusCloseTimer = undefined;
          if (!shouldArm) return;
          void current
            .isFocused()
            .then((focused) => {
              if (blurArmRequested && focused) blurArmed = true;
            })
            .catch(() => undefined);
        },
      );
      const stopFocus = await current.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          if (focusCloseTimer) clearTimeout(focusCloseTimer);
          focusCloseTimer = undefined;
          if (blurArmRequested) blurArmed = true;
          return;
        }
        if (!blurArmed) return;
        if (focusCloseTimer) clearTimeout(focusCloseTimer);
        focusCloseTimer = setTimeout(() => {
          if (!blurArmed) return;
          void Promise.all([current.isFocused(), current.isVisible()])
            .then(([stillFocused, stillVisible]) => {
              if (blurArmed && stillVisible && !stillFocused) {
                blurArmed = false;
                blurArmRequested = false;
                return hidePopup("blur");
              }
            })
            .catch(() => undefined);
        }, 120);
      });
      if (disposed) {
        stopPayload();
        stopBlurArm();
        stopFocus();
        return;
      }
      unlistenPayload = stopPayload;
      unlistenBlurArm = stopBlurArm;
      unlistenFocus = stopFocus;
      await tick();
      await invoke("mark_sidebar_menu_window_ready", {
        popupLabel: launch.popupWindowLabel,
      });
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void hidePopup("escape");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      disposed = true;
      blurArmRequested = false;
      blurArmed = false;
      if (focusCloseTimer) clearTimeout(focusCloseTimer);
      unlistenPayload?.();
      unlistenBlurArm?.();
      unlistenFocus?.();
      window.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

<div class="rs-native-sidebar-menu-popup" style={popupStyle}>
  {#each (currentPayload ?? payload).items as item}
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
