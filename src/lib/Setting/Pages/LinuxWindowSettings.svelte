<script lang="ts">
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import SliderInput from "src/lib/UI/GUI/SliderInput.svelte";
    import { language } from "src/lang";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import {
        setLinuxWindowDecorationPreference,
        type LinuxWindowDecoration,
    } from "src/ts/linuxWindowIntegration";

    let requested = $state<LinuxWindowDecoration>(
        settingsStore.state.linuxWindowDecoration ?? "ssd",
    );

    async function updateDecoration(value: LinuxWindowDecoration) {
        requested = value;
        settingsStore.set("linuxWindowDecoration", value);
        await Promise.all([
            settingsStore.flush(),
            setLinuxWindowDecorationPreference(value),
        ]);
    }
</script>

<SelectInput
    value={requested}
    onchange={(event) =>
        void updateDecoration(
            event.currentTarget.value as LinuxWindowDecoration,
        )}
    className="mt-5 w-full"
>
    <option class="bg-darkbg text-textcolor" value="ssd">
        SSD — compositor-native titlebar
    </option>
    <option class="bg-darkbg text-textcolor" value="csd">
        CSD — GTK native titlebar
    </option>
</SelectInput>

{#if requested === "csd"}
    <div class="mt-4 flex flex-col gap-2 text-sm text-textcolor">
        <span>{language.linuxCsdSidebarOpacity}</span>
        <SliderInput
            min={0}
            max={100}
            step={1}
            customText={`${settingsStore.state.linuxCsdSidebarOpacity ?? 94}%`}
            bind:value={settingsStore.state.linuxCsdSidebarOpacity}
        />
    </div>
{/if}
