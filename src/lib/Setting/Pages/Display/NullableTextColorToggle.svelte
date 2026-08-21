<script lang="ts">
    import { language } from 'src/lang';
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import Check from 'src/lib/UI/GUI/CheckInput.svelte';

    interface Props {
        field: 'textScreenColor' | 'textScreenBorder';
        labelKey: 'textBackgrounds' | 'textScreenBorder';
        defaultColor: string;
    }

    let { field, labelKey, defaultColor }: Props = $props();
    let currentValue = $derived(settingsStore.state[field]);
</script>

{#if currentValue}
    <div class="flex items-center mt-2">
        <Check
            check={true}
            onChange={() => {
                settingsStore.state[field] = null;
            }}
            name={language[labelKey]}
            hiddenName
        />
        <input
            type="color"
            class="style2 text-sm mr-2"
            value={currentValue}
            oninput={(e) => {
                settingsStore.state[field] = e.currentTarget.value;
            }}
        />
        <span>{language[labelKey]}</span>
    </div>
{:else}
    <div class="flex items-center mt-2">
        <Check
            check={false}
            onChange={() => {
                settingsStore.state[field] = defaultColor;
            }}
            name={language[labelKey]}
        />
    </div>
{/if}
