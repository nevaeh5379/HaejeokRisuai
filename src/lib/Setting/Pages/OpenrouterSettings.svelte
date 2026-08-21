<script lang="ts">
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
        <Check bind:check={settingsStore.state.useInstructPrompt} name={language.useInstructPrompt}/>
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
            {#each settingsStore.state.openrouterProvider.order as _, i}
                <span class="text-textcolor mt-4">
                    {language.provider} {i + 1}
                </span>
                <OpenrouterProviderList bind:value={settingsStore.state.openrouterProvider.order[i]} options={openRouterProviders} />
            {/each}
            <div class="flex gap-2">
                <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                    let value = settingsStore.state.openrouterProvider.order ?? []
                    value.push('')
                    settingsStore.state.openrouterProvider.order = value
            }}><PlusIcon /></button>
                <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                    let value = settingsStore.state.openrouterProvider.order ?? []
                    value.pop()
                    settingsStore.state.openrouterProvider.order = value
            }}><TrashIcon /></button>
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderOnly} help="openRouterProviderOnly" styled>
            {#each settingsStore.state.openrouterProvider.only as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider} {i + 1}
                </span>
                <OpenrouterProviderList bind:value={settingsStore.state.openrouterProvider.only[i]} options={openRouterProviders} />
            {/each}
            <div class="flex gap-2">
                <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                    let value = settingsStore.state.openrouterProvider.only ?? []
                    value.push('')
                    settingsStore.state.openrouterProvider.only = value
            }}><PlusIcon /></button>
                <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                    let value = settingsStore.state.openrouterProvider.only ?? []
                    value.pop()
                    settingsStore.state.openrouterProvider.only = value
            }}><TrashIcon /></button>
            </div>
        </Accordion>

        <Accordion name={language.openRouterProviderIgnore} help="openRouterProviderIgnore" styled>
            {#each settingsStore.state.openrouterProvider.ignore as model, i}
                <span class="text-textcolor mt-4">
                    {language.provider} {i + 1}
                </span>
                <OpenrouterProviderList bind:value={settingsStore.state.openrouterProvider.ignore[i]} options={openRouterProviders} />
            {/each}
            <div class="flex gap-2">
                <button class="bg-selected text-textcolor p-2 rounded-md" onclick={() => {
                    let value = settingsStore.state.openrouterProvider.ignore ?? []
                    value.push('')
                    settingsStore.state.openrouterProvider.ignore = value
            }}><PlusIcon /></button>
                <button class="bg-red-500 text-white p-2 rounded-md" onclick={() => {
                    let value = settingsStore.state.openrouterProvider.ignore ?? []
                    value.pop()
                    settingsStore.state.openrouterProvider.ignore = value
            }}><TrashIcon /></button>
            </div>
        </Accordion>
    {/await}

    {#if settingsStore.state.useInstructPrompt}
        <ChatFormatSettings />
    {/if}
</Accordion>
