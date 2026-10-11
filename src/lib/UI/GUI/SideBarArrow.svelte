<script lang="ts">
    import { ArrowLeft, ArrowRight } from "@lucide/svelte";
    import { DynamicGUI, MobileGUI, sideBarClosing, sideBarStore } from "src/ts/stores.svelte";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import { isTauriMacOS } from "src/ts/platform";

    let sidebarRight = $derived(
        !!(settingsStore.state.useExperimental && settingsStore.state.sidebarRight)
    );
</script>

{#if !$MobileGUI}
    {#if $sideBarStore && !$DynamicGUI}
        <button
            onclick={() => {sideBarClosing.set(true)}}
            class="rs-sidebar-toggle absolute top-3 h-12 w-12 border-b border-t border-transparent bg-darkbg hover:border-neutral-200 transition-colors flex items-center justify-center text-textcolor z-20"
            class:left-0={!sidebarRight}
            class:border-r={!sidebarRight}
            class:rounded-r-md={!sidebarRight}
            class:right-0={sidebarRight}
            class:border-l={sidebarRight}
            class:rounded-l-md={sidebarRight}
            class:macos-sidebar-toggle={isTauriMacOS && !sidebarRight}
            class:macos-sidebar-toggle-right={isTauriMacOS && sidebarRight}
        >
            {#if sidebarRight}
                <ArrowRight />
            {:else}
                <ArrowLeft />
            {/if}
        </button>
    {:else}
        <button
            onclick={() => {
                sideBarClosing.set(false);
                sideBarStore.set(true);
            }}
            class="rs-sidebar-toggle absolute top-3 h-12 w-12 border-b border-t border-borderc bg-darkbg hover:border-neutral-200 transition-colors flex items-center justify-center text-textcolor opacity-50 hover:opacity-90 z-20"
            class:left-0={!sidebarRight}
            class:border-r={!sidebarRight}
            class:rounded-r-md={!sidebarRight}
            class:right-0={sidebarRight}
            class:border-l={sidebarRight}
            class:rounded-l-md={sidebarRight}
            class:macos-sidebar-toggle={isTauriMacOS && !sidebarRight}
            class:macos-sidebar-toggle-right={isTauriMacOS && sidebarRight}
        >
            {#if sidebarRight}
                <ArrowLeft />
            {:else}
                <ArrowRight />
            {/if}
        </button>
    {/if}
{/if}