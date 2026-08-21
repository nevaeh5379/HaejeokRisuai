<script lang="ts">
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme';
    import ColorInput from 'src/lib/UI/GUI/ColorInput.svelte';

    const colors = [
        ['FontColorStandard', 'Normal Text', false],
        ['FontColorItalic', 'Italic Text', false],
        ['FontColorBold', 'Bold Text', false],
        ['FontColorItalicBold', 'Italic Bold Text', false],
        ['FontColorQuote1', 'Single Quote Text', true],
        ['FontColorQuote2', 'Double Quote Text', true],
    ] as const;
</script>

{#if settingsStore.state.textTheme === 'custom'}
    {#each colors as color}
        <div class="flex items-center mt-2">
            <ColorInput
                nullable={color[2]}
                bind:value={settingsStore.state.customTextTheme[color[0]]}
                oninput={updateTextThemeAndCSS}
            />
            <span class="ml-2">{color[1]}</span>
        </div>
    {/each}
{/if}
