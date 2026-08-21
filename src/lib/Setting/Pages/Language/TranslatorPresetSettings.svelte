<script lang="ts">
    import { DownloadIcon, HardDriveUploadIcon, PencilIcon, PlusIcon, TrashIcon } from "@lucide/svelte";
    import Help from "src/lib/Others/Help.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { alertConfirm, alertError, alertInput, alertNormal } from "src/ts/alert";
    import { downloadFile } from "src/ts/globalApi.svelte";
    import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
    import {
        createTranslatorPreset,
        decodeTranslatorPresetFile,
        defaultTranslatorPrompt,
        encodeTranslatorPresetFile,
        getTranslatorPresetDownloadName,
        normalizeTranslatorPresetState,
        syncCurrentTranslatorPresetToLegacyFields,
        translatorPresetImportExtensions,
    } from "src/ts/translator/presets";
    import { selectSingleFile } from "src/ts/util";
    import { language } from "src/lang";

    function normalizeTranslatorPresets() {
        normalizeTranslatorPresetState(settingsStore.state);
    }

    function syncCurrentTranslatorPreset() {
        syncCurrentTranslatorPresetToLegacyFields(settingsStore.state);
    }
</script>

<span class="text-textcolor mt-4">Preset</span>
<select
    class={"border border-darkborderc focus:border-borderc rounded-md shadow-xs text-textcolor bg-transparent focus:ring-borderc focus:ring-2 focus:outline-hidden transition-colors duration-200 text-md px-4 py-2 mb-1"}
    bind:value={() => settingsStore.state.translatorPresetId, (value) => {
        settingsStore.state.translatorPresetId = Number(value);
        syncCurrentTranslatorPreset();
    }}
>
    {#each settingsStore.state.translatorPresets as preset, i}
        <option class="bg-darkbg appearance-none" value={i}>{preset.name}</option>
    {/each}
</select>

<div class="flex items-center mb-4">
    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={() => {
            const newPreset = createTranslatorPreset();
            const presets = settingsStore.state.translatorPresets;
            presets.push(newPreset);
            settingsStore.state.translatorPresets = presets;
            settingsStore.state.translatorPresetId = settingsStore.state.translatorPresets.length - 1;
            normalizeTranslatorPresets();
        }}
    >
        <PlusIcon size={24} />
    </button>

    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={async () => {
            const presets = settingsStore.state.translatorPresets;

            if (presets.length === 0) {
                alertError("There must be at least one preset.");
                return;
            }

            const id = settingsStore.state.translatorPresetId;
            const preset = presets[id];
            const newName = await alertInput(`Enter new name for ${preset.name}`, [], preset.name);

            if (!newName || newName.trim().length === 0) return;

            preset.name = newName;
            settingsStore.state.translatorPresets = presets;
            syncCurrentTranslatorPreset();
        }}
    >
        <PencilIcon size={24} />
    </button>

    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={async () => {
            const presets = settingsStore.state.translatorPresets;

            if (presets.length <= 1) {
                alertError("There must be at least one preset.");
                return;
            }

            const id = settingsStore.state.translatorPresetId;
            const preset = presets[id];
            const confirmed = await alertConfirm(`${language.removeConfirm}${preset.name}`);

            if (!confirmed) return;

            settingsStore.state.translatorPresetId = 0;
            presets.splice(id, 1);
            settingsStore.state.translatorPresets = presets;
            normalizeTranslatorPresets();
        }}
    >
        <TrashIcon size={24} />
    </button>

    <div class="ml-2 mr-4 w-px h-full bg-darkborderc"></div>

    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={async () => {
            try {
                const presets = settingsStore.state.translatorPresets;

                if (presets.length === 0) {
                    alertError("There must be at least one preset.");
                    return;
                }

                const preset = presets[settingsStore.state.translatorPresetId];
                await downloadFile(
                    getTranslatorPresetDownloadName(preset.name),
                    await encodeTranslatorPresetFile(preset)
                );
                alertNormal(language.successExport);
            } catch (error) {
                alertError(`${error}`);
            }
        }}
    >
        <DownloadIcon size={24} />
    </button>

    <button
        class="mr-2 text-textcolor2 hover:text-green-500 cursor-pointer"
        onclick={async () => {
            try {
                const selectedFile = await selectSingleFile(translatorPresetImportExtensions);

                if (!selectedFile) return;

                const newPreset = await decodeTranslatorPresetFile(selectedFile.data);
                const presets = settingsStore.state.translatorPresets;

                presets.push(newPreset);
                settingsStore.state.translatorPresets = presets;
                settingsStore.state.translatorPresetId = settingsStore.state.translatorPresets.length - 1;
                normalizeTranslatorPresets();

                alertNormal(language.successImport);
            } catch (error) {
                alertError(`${error}`);
            }
        }}
    >
        <HardDriveUploadIcon size={24} />
    </button>
</div>

{#if settingsStore.state.translatorPresets?.[settingsStore.state.translatorPresetId]}
    {@const preset = settingsStore.state.translatorPresets[settingsStore.state.translatorPresetId]}
    <span class="text-textcolor mt-4">{language.translationResponseSize}</span>
    <NumberInput
        min={0}
        max={2048}
        marginBottom={true}
        bind:value={() => preset.maxResponse, (value) => {
            preset.maxResponse = value;
            syncCurrentTranslatorPreset();
        }}
    />
    <span class="text-textcolor mt-4">{language.translatorPrompt} <Help key="translatorPrompt" /></span>
    <TextAreaInput
        bind:value={() => preset.prompt, (value) => {
            preset.prompt = value;
            syncCurrentTranslatorPreset();
        }}
        placeholder={defaultTranslatorPrompt}
    />
{/if}
