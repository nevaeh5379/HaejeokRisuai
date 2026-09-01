<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { language } from "src/lang";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";

    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    import OpenrouterProviderList from "src/lib/UI/OpenrouterProviderList.svelte";
    import { PlusIcon, TrashIcon } from "@lucide/svelte";
    import { getOpenRouterProviders } from 'src/ts/model/openrouter'
</script>

<Accordion name={`OpenRouter ${language.settings}`} styled>
    <div class="flex items-center mb-4">
        <Check bind:check={settingsStore.state.openrouterFallback} name={language.openRouterFallback}/>
    </div>
    <div class="flex items-center mb-4">
        <Check bind:check={settingsStore.state.openrouterMiddleOut} name={language.openRouterMiddleOut}/>
    </div>
    <div class="flex items-center mb-4">
        <Check bind:check={presetStore.state.useInstructPrompt} name={language.useInstructPrompt}/>
    </div>
    {#await getOpenRouterProviders()}
        <Accordion name={language.openRouterProviderOrder} help="openRouterProviderOrder" styled>
            <p>{language.loading}...</p>
        </Accordion>
        <Accordion name={language.openRouterProviderOnly} help="openRouterProviderOnly" styled>
            <p>{language.loading}...</p>
        </Accordion>
        <Accordion name={language.openRouterProviderIgnore} help="openRouterProviderIgnore" styled>
            <p>{language.loading}...</p>
        </Accordion>
    {:then openRouterProviders}
        <Accordion name={language.openRouterProviderOrder} help="openRouterProviderOrder" styled>
            {#each presetStore.state.openrouterProvider.order as _, i}
                <span class="text-textcolor mt-4">
                    {language.provider} {i + 1}
                </span>
                <OpenrouterProviderList bind:value={presetStore.state.openrouterProvider.order[i]} options={openRouterProviders} />
            {/each}
            <div class="flex gap-2">
                <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                    let value = presetStore.state.openrouterProvider.order ?? []
                    value.push('')
                    presetStore.state.openrouterProvider.order = value
            }}><PlusIcon /></button>
                <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                    let value = presetStore.state.openrouterProvider.order ?? []
                    value.pop()
                    presetStore.state.openrouterProvider.order = value
            }}><TrashIcon /></button>
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderOnly} help="openRouterProviderOnly" styled>
            {#each presetStore.state.openrouterProvider.only as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider} {i + 1}
                </span>
                <OpenrouterProviderList bind:value={presetStore.state.openrouterProvider.only[i]} options={openRouterProviders} />
            {/each}
            <div class="flex gap-2">
                <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                    let value = presetStore.state.openrouterProvider.only ?? []
                    value.push('')
                    presetStore.state.openrouterProvider.only = value
            }}><PlusIcon /></button>
                <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                    let value = presetStore.state.openrouterProvider.only ?? []
                    value.pop()
                    presetStore.state.openrouterProvider.only = value
            }}><TrashIcon /></button>
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderIgnore} help="openRouterProviderIgnore" styled>
            {#each presetStore.state.openrouterProvider.ignore as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider} {i + 1}
                </span>
                <OpenrouterProviderList bind:value={presetStore.state.openrouterProvider.ignore[i]} options={openRouterProviders} />
            {/each}
            <div class="flex gap-2">
                <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                    let value = presetStore.state.openrouterProvider.ignore ?? []
                    value.push('')
                    presetStore.state.openrouterProvider.ignore = value
            }}><PlusIcon /></button>
                <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                    let value = presetStore.state.openrouterProvider.ignore ?? []
                    value.pop()
                    presetStore.state.openrouterProvider.ignore = value
            }}><TrashIcon /></button>
            </div>
        </Accordion>
    {/await}

    {#if presetStore.state.useInstructPrompt}
        <ChatFormatSettings />
    {/if}
</Accordion>
