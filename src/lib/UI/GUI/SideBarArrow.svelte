<script lang="ts">
    import { ArrowLeft, ArrowRight, PanelLeft, PanelLeftClose, PanelLeftOpen } from "@lucide/svelte";
    import { DynamicGUI, MobileGUI, sideBarClosing, sideBarStore } from "src/ts/stores.svelte";
    import { isTauriMacOS, isTauriWindows } from "src/ts/platform";
    let isSidebarOpen = $derived($sideBarStore && !$DynamicGUI);
</script>

{#if !$MobileGUI}
{#if !isTauriWindows}
    <button
    onclick={() => {
        sideBarClosing.set(isSidebarOpen);
        if (!isSidebarOpen) sideBarStore.set(true);
    }}
    class="rs-sidebar-toggle absolute top-3 left-0 h-12 w-12
        border-r border-b border-t rounded-r-md
        bg-darkbg hover:border-neutral-200 transition-colors
        flex items-center justify-center text-textcolor z-20
        {isSidebarOpen
            ? 'border-transparent'
            : 'border-borderc opacity-50 hover:opacity-90'}"
    class:macos-sidebar-toggle={isTauriMacOS}
>
    {#if isSidebarOpen}
        <ArrowLeft />
    {:else}
        <ArrowRight />
    {/if}
</button>

{:else}
<!-- {#if !isSidebarOpen} -->
    <button onclick={() => {
        sideBarClosing.set(isSidebarOpen);
        if (!isSidebarOpen) sideBarStore.set(true);
    }} class="group rs-sidebar-toggle absolute left-1.25 top-1.25 h-8 w-8 items-center flex justify-center z-20">
    <PanelLeft class="text-zinc-500 group-hover:hidden group-hover:text-white transition-colors" />
    {#if isSidebarOpen}
    <PanelLeftClose class="hidden group-hover:block" />
    {:else}
    <PanelLeftOpen class="hidden group-hover:block" />
    {/if}
</button>
<!-- {/if} -->
{/if}
{/if}