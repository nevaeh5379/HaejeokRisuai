<script lang="ts">
    import { XIcon } from "@lucide/svelte";
    import { language } from "../../lang";
    
    import { personaStore } from 'src/ts/stores/domain/personaStore.svelte';
    import { characterStore } from 'src/ts/stores/domain/characterStore.svelte';
    import { changeUserPersona } from "src/ts/persona";
    import { personaSelectCallback } from "src/ts/stores.svelte";
    import { get } from "svelte/store";


    interface Props {
        close?: any;
    }

    let { close = () => {} }: Props = $props();

    // Drop a pending callback when the list unmounts so it cannot fire later.
    $effect(() => {
        return () => {
            personaSelectCallback.set(null)
        }
    })

    // Binding mode (opened from the sidebar): a top "default" row unbinds and
    // the highlighted item is the chat's bound persona.
    const bindingMode = $derived($personaSelectCallback !== null)
    const boundIndex = $derived.by(() => {
        const id = characterStore.getCurrentChat()?.bindedPersona
        return id ? personaStore.list.findIndex((persona) => persona.id === id) : -1
    })
    const highlightIndex = $derived(bindingMode ? boundIndex : personaStore.activeIndex)

    function select(index: number) {
        const callback = get(personaSelectCallback)
        if (callback) {
            personaSelectCallback.set(null)
            callback(index)
        } else {
            changeUserPersona(index)
        }
        close()
    }

</script>

<div class="absolute w-full h-full z-40 bg-black/50 flex justify-center items-center">
    <div class="bg-darkbg p-4 break-any rounded-md flex flex-col max-w-3xl w-96 max-h-full overflow-y-auto">
        <div class="flex items-center text-textcolor mb-4">
            <h2 class="mt-0 mb-0 font-bold">{language.persona}</h2>
            <div class="grow flex justify-end">
                <button class="text-textcolor2 hover:text-green-500 mr-2 cursor-pointer items-center" onclick={close}>
                    <XIcon size={24}/>
                </button>
            </div>
        </div>
        {#if bindingMode}
            <button onclick={() => select(-1)}
                class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer"
                class:bg-selected={boundIndex < 0}>
                <span class="w-full text-left">
                    <span class="font-medium">{language.bindingInherit}</span>
                    <span class="opacity-75"> ({personaStore.activePersona?.name ?? 'User'})</span>
                </span>
            </button>
        {/if}
        {#each personaStore.list as persona, i}
            <button onclick={() => select(i)} class="flex items-center text-textcolor border-t-1 border-solid border-0 border-darkborderc p-2 cursor-pointer" class:bg-selected={i === highlightIndex}>
                <span class="overflow-x-auto whitespace-nowrap w-full text-left">
                    <span class="font-medium">{persona.name}</span>
                    {#if persona.note}
                        <span class="opacity-75"> / {persona.note}</span>
                    {/if}
                </span>
            </button>
        {/each}
    </div>
</div>

<style>
    .break-any{
        word-break: normal;
        overflow-wrap: anywhere;
    }
</style>