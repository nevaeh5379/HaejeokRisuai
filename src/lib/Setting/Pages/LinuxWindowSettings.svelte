<script lang="ts">
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import {
        getActiveLinuxWindowCapabilities,
        getActiveLinuxWindowDecoration,
        setLinuxWindowDecorationPreference,
        type LinuxWindowDecoration,
    } from "src/ts/linuxWindowIntegration";

    let requested = $state<LinuxWindowDecoration>(
        settingsStore.state.linuxWindowDecoration ?? "ssd",
    );
    const active = getActiveLinuxWindowDecoration();
    const capabilities = getActiveLinuxWindowCapabilities();
    let restartRequired = $derived(requested !== active);

    async function updateDecoration(value: LinuxWindowDecoration) {
        requested = value;
        settingsStore.set("linuxWindowDecoration", value);
        await Promise.all([
            settingsStore.flush(),
            setLinuxWindowDecorationPreference(value),
        ]);
    }
</script>

<section class="mt-5 rounded-lg border border-darkborderc bg-darkbg/35 p-4">
    <h3 class="text-lg font-semibold text-textcolor">Linux Window Decoration</h3>
    <p class="mt-1 mb-4 text-sm text-textcolor2">
        Choose whether the Wayland compositor or RisuAI draws the window chrome.
        Integrated CSD extends the app surface into the titlebar area.
    </p>

    <label class="flex flex-col gap-2 text-sm text-textcolor">
        <span>Decoration mode</span>
        <SelectInput
            value={requested}
            onchange={(event) =>
                void updateDecoration(
                    event.currentTarget.value as LinuxWindowDecoration,
                )}
            className="w-full"
        >
            <option class="bg-darkbg text-textcolor" value="ssd">
                SSD — compositor-native titlebar
            </option>
            <option class="bg-darkbg text-textcolor" value="csd">
                CSD — integrated app titlebar
            </option>
        </SelectInput>
    </label>

    {#if requested === "ssd" && capabilities.wayland && !capabilities.serverSideDecoration}
        <p class="mt-3 text-xs text-yellow-400">
            This compositor does not expose the server-decoration protocol used
            by the current GTK/Tauri stack. GTK may fall back to toolkit CSD.
        </p>
    {/if}

    {#if restartRequired}
        <p class="mt-3 text-xs text-textcolor2">
            The current window is still using {active.toUpperCase()}. Restart
            RisuAI to apply {requested.toUpperCase()} to this window. Newly
            created chat windows use the new preference immediately.
        </p>
    {:else}
        <p class="mt-3 text-xs text-textcolor2">
            Current window: {active.toUpperCase()}.
        </p>
    {/if}
</section>
