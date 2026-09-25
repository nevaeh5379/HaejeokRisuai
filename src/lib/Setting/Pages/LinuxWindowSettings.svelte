<script lang="ts">
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
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
