<script lang="ts">
    import { language } from 'src/lang';
    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import Accordion from 'src/lib/UI/Accordion.svelte';
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte';
    import AllSeperateParameters from 'src/lib/Others/AllSeperateParameters.svelte';

    const paramLabels: Record<string, string> = {
        memory: 'longTermMemory',
        emotion: 'emotionImage',
        translate: 'translator',
        otherAx: 'others',
    };
</script>

<Accordion name={language.seperateParameters} styled>
    <CheckInput bind:check={settingsStore.state.seperateParametersEnabled} name={language.seperateParametersEnabled} />
    {#if settingsStore.state.seperateParametersEnabled}
        {#each Object.keys(settingsStore.state.seperateParameters) as param}
            <Accordion name={language[paramLabels[param]] ?? param} styled>
                <AllSeperateParameters bind:value={settingsStore.state.seperateParameters[param]} paramKey={param} />
            </Accordion>
        {/each}
    {/if}
</Accordion>
