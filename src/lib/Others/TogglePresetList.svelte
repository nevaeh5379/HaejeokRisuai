<script lang="ts">
    import { SaveIcon, TrashIcon, XIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import { alertConfirm, alertInput } from "src/ts/alert";
    import { applyToggleValues, snapshotToggleValues } from "src/ts/chatBindings";
    import { presetStore, settingsStore } from "src/ts/stores/domain";
    import CheckInput from "../UI/GUI/CheckInput.svelte";

    interface Props {
        close?: () => void;
    }

    let { close = () => {} }: Props = $props();

    let showAll = $state(false)
    const currentPromptName = $derived(
        presetStore.summaries.find((preset) => preset.id === presetStore.activeId)?.name
    )
    const presets = $derived(settingsStore.state.togglePresets ?? [])
    // Sets are saved per prompt preset; the others are hidden unless asked for.
    const visible = $derived(
        presets
            .map((preset, index) => ({ preset, index }))
            .filter(({ preset }) => showAll || preset.promptPresetName === currentPromptName)
    )

    async function saveNew() {
        const name = (await alertInput(language.togglePresetNameInput)).trim()
        if (!name) return
        settingsStore.state.togglePresets = [
            ...presets,
            { name, values: snapshotToggleValues(), promptPresetName: currentPromptName },
        ]
    }

    async function overwrite(index: number) {
        if (!(await alertConfirm(language.togglePresetOverwriteConfirm))) return
        settingsStore.state.togglePresets = presets.map((preset, i) =>
            i === index ? { ...preset, values: snapshotToggleValues(), promptPresetName: currentPromptName } : preset)
    }

    async function remove(index: number) {
        if (!(await alertConfirm(`${language.removeConfirm}${presets[index].name}`))) return
        settingsStore.state.togglePresets = presets.filter((_, i) => i !== index)
    }
</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-2">
            <h2 class="mt-0 mb-0 font-bold">{language.togglePresetList}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-green-500 cursor-pointer" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        <CheckInput bind:check={showAll} name={language.togglePresetShowAll} />
        {#if visible.length === 0}
            <p class="text-textcolor2 text-sm mt-2">{language.togglePresetEmpty}</p>
        {/if}
        {#each visible as { preset, index } (index)}
            <div class="flex items-center gap-2 text-textcolor border-t border-darkborderc p-2">
                <button class="grow min-w-0 text-left cursor-pointer hover:text-green-500" onclick={() => {
                    applyToggleValues(preset.values)
                    close()
                }}>
                    <div class="truncate">{preset.name}</div>
                    {#if showAll}
                        <div class="text-xs text-textcolor2 truncate">{preset.promptPresetName ?? language.none}</div>
                    {/if}
                </button>
                <button class="text-textcolor2 hover:text-green-500 cursor-pointer shrink-0" onclick={() => void overwrite(index)}>
                    <SaveIcon size={18}/>
                </button>
                <button class="text-textcolor2 hover:text-draculared cursor-pointer shrink-0" onclick={() => void remove(index)}>
                    <TrashIcon size={18}/>
                </button>
            </div>
        {/each}
        <button class="mt-3 pt-2 border-t border-darkborderc text-sm text-textcolor2 hover:text-green-500 cursor-pointer text-left" onclick={() => void saveNew()}>
            + {language.togglePresetSaveNew}
        </button>
    </div>
</div>
