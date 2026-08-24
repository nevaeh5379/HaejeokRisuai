<script lang="ts">
    import { language } from "src/lang";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import OptionInput from "../UI/GUI/OptionInput.svelte";
    import SelectInput from "../UI/GUI/SelectInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { HypaProcesser } from "src/ts/process/memory/hypamemory";
    import { settingsStore } from "src/ts/stores/domain";

    let query = $state("");
    let model = $state("openai3small");
    let customEmbeddingUrl = $state("");
    let data:string[] = $state([]);
    let dataresult:[string, number][] = $state([]);
    let running = $state(false);

    const run = async () => {
        if(running) return;
        running = true;
        const processer = new HypaProcesser(model as any, customEmbeddingUrl);
        await processer.addText(data);
        console.log(processer.vectors)
        dataresult = await processer.similaritySearchScored(query);
        running = false;
    }
</script>
  
<h2 class="text-4xl text-textcolor my-6 font-black relative">{language.embedding}</h2>

<span class="text-textcolor text-lg">Model</span>
<SelectInput bind:value={model} className="mb-4">
    <OptionInput value="openai3small">OpenAI text-embedding-3-small</OptionInput>
    <OptionInput value="openai3large">OpenAI text-embedding-3-large</OptionInput>
    <OptionInput value="ada">OpenAI Ada</OptionInput>
    <OptionInput value="voyageContext3">Voyage Context 3</OptionInput>
    <OptionInput value="custom">Custom (OpenAI-compatible)</OptionInput>
</SelectInput>

{#if model === 'openai3small' || model === 'openai3large' || model === 'ada'}
    <span class="text-textcolor text-lg">OpenAI API Key</span>
    <TextInput size="sm" marginBottom bind:value={settingsStore.state.supaMemoryKey}/>
{/if}

{#if model === "custom"}
    <span class="text-textcolor text-lg">URL</span>
    <TextInput size="sm" marginBottom bind:value={settingsStore.state.hypaCustomSettings.url}/>
    <span class="text-textcolor text-lg">Key/Password</span>
    <TextInput size="sm" marginBottom bind:value={settingsStore.state.hypaCustomSettings.key}/>
    <span class="text-textcolor text-lg">Request Model</span>
    <TextInput size="sm" marginBottom bind:value={settingsStore.state.hypaCustomSettings.model}/>
{/if}

{#if model === 'voyageContext3'}
    <span class="text-textcolor text-lg">Voyage API Key</span>
    <TextInput size="sm" marginBottom bind:value={settingsStore.state.voyageApiKey}/>
{/if}

<div class="mb-4"></div>

<span class="text-textcolor text-lg">Query</span>
<TextInput bind:value={query} size="lg" fullwidth />

<span class="text-textcolor text-lg mt-6">Data</span>
{#each data as item, i}
    <TextInput bind:value={data[i]} size="lg" fullwidth marginBottom />
{/each}
<Button styled="outlined" onclick={() => {
    data.push("");
    data = data
}}>+</Button>

<span class="text-textcolor text-lg mt-6">Result</span>
{#if dataresult.length === 0}
    <span class="text-textcolor2 text-lg">No result</span>
{/if}
{#each dataresult as [item, score]}
    <div class="flex justify-between">
        <span>{item}</span>
        <span>{score.toFixed(2)}</span>
    </div>
{/each}

<Button className="mt-6 flex justify-center" size="lg" onclick={() => {
    run()
}}>
    {#if running}
        <div class="loadmove"></div>
    {:else}
        {language.run?.toLocaleUpperCase()}
    {/if}
</Button>