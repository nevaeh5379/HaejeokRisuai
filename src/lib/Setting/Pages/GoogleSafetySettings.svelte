<script lang="ts">
    import { language } from "src/lang";
    import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
    import {
        GOOGLE_SAFETY_CATEGORIES,
        GOOGLE_SAFETY_THRESHOLDS,
        type GoogleSafetyCategory,
        type GoogleSafetyThreshold,
    } from "@risuai/chat-core/googleProvider.ts";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";

    const id = $props.id();

    function setThreshold(category: GoogleSafetyCategory, threshold: GoogleSafetyThreshold) {
        if (threshold === "OFF") {
            delete presetStore.state.googleSafetySettings[category];
        } else {
            presetStore.state.googleSafetySettings[category] = threshold;
        }
    }
</script>

<details class="mt-2 border-t border-darkborderc/40 pt-2 text-textcolor">
    <summary class="cursor-pointer text-sm font-medium">{language.googleSafetySettings.title}</summary>
    <div class="mt-3 flex flex-col gap-3">
        {#each GOOGLE_SAFETY_CATEGORIES as category}
            <div class="flex flex-col gap-1">
                <label for={`${id}-${category}`} class="text-xs text-textcolor2 [overflow-wrap:anywhere]">
                    {language.googleSafetySettings.categories[category]} ({category})
                </label>
                <SelectInput
                    id={`${id}-${category}`}
                    size="sm"
                    className="w-full min-w-0"
                    value={presetStore.state.googleSafetySettings[category] ?? "OFF"}
                    onchange={(event) => setThreshold(category, event.currentTarget.value as GoogleSafetyThreshold)}
                >
                    {#each GOOGLE_SAFETY_THRESHOLDS as threshold}
                        <OptionInput value={threshold}>{language.googleSafetySettings.thresholds[threshold]} ({threshold})</OptionInput>
                    {/each}
                </SelectInput>
            </div>
        {/each}
    </div>
</details>
