<script lang="ts">
    import DesktopPersonaSettings from "./DesktopPersonaSettings.svelte";
    import MobilePersonaSettings from "./MobilePersonaSettings.svelte";
    import { MobileGUI } from "src/ts/stores.svelte";

    let innerWidth = $state(typeof window !== "undefined" ? window.innerWidth : 1200);
    let isMobile = $derived(innerWidth < 1024 || $MobileGUI);
</script>

<svelte:window bind:innerWidth />

{#if isMobile}
    <MobilePersonaSettings />
{:else}
    <DesktopPersonaSettings />
{/if}