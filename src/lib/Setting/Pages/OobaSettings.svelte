<script lang="ts">

  import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import OptionalInput from "src/lib/UI/GUI/OptionalInput.svelte";

    import { settingsStore } from 'src/ts/stores/domain/settingsStore.svelte';
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import { language } from "src/lang";
    import { PlusIcon, TrashIcon } from "@lucide/svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import Accordion from "src/lib/UI/Accordion.svelte";
    import ChatFormatSettings from "./ChatFormatSettings.svelte";
    interface Props {
        instructionMode?: boolean;
    }

    let { instructionMode = false }: Props = $props();
</script>

<Accordion name="Ooba Settings" styled>
    {#if instructionMode}
        <ChatFormatSettings />
    {:else}
        <span class="text-textcolor">Ooba Mode</span>
        <SelectInput className="mt-2 mb-4" bind:value={presetStore.state.reverseProxyOobaArgs.mode}>
            <OptionInput value="instruct">Instruct</OptionInput>
            <OptionInput value="chat">Chat</OptionInput>
            <OptionInput value="chat-instruct">Chat-Instruct</OptionInput>
        </SelectInput>
        <!-- name1 = user | name2 = bot --->

        {#if presetStore.state.reverseProxyOobaArgs.mode === 'instruct'}
            <span class="text-textcolor">user prefix</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.name1_instruct} />
            <span class="text-textcolor">bot prefix</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.name2_instruct} />
            <span class="text-textcolor">system prefix</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.context_instruct} />
            <span class="text-textcolor">system message</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.system_message} />
        {/if}
        {#if presetStore.state.reverseProxyOobaArgs.mode === 'chat' || presetStore.state.reverseProxyOobaArgs.mode === 'chat-instruct'}
            <span class="text-textcolor">user prefix</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.name1} />
            <span class="text-textcolor">bot prefix</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.name2} />
            <span class="text-textcolor">system prefix</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.context} />
            <span class="text-textcolor">start message</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.greeting} />
        {/if}
        {#if presetStore.state.reverseProxyOobaArgs.mode === 'chat-instruct'}
            <span class="text-textcolor">chat_instruct_command</span>
            <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.chat_instruct_command} />
        {/if}
    {/if}
    <span class="text-textcolor">tokenizer</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.tokenizer} />
    <span class="text-textcolor">min_p</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.min_p} numberMode />
    <span class="text-textcolor">top_k</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.top_k} numberMode />
    <span class="text-textcolor">repetition_penalty</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.repetition_penalty} numberMode />
    <span class="text-textcolor">repetition_penalty_range</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.repetition_penalty_range} numberMode />
    <span class="text-textcolor">typical_p</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.typical_p} numberMode />
    <span class="text-textcolor">tfs</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.tfs} numberMode />
    <span class="text-textcolor">top_a</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.top_a} numberMode />
    <span class="text-textcolor">epsilon_cutoff</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.epsilon_cutoff} numberMode />
    <span class="text-textcolor">eta_cutoff</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.eta_cutoff} numberMode />
    <span class="text-textcolor">guidance_scale</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.guidance_scale} numberMode />
    <span class="text-textcolor">penalty_alpha</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.penalty_alpha} numberMode />
    <span class="text-textcolor">mirostat_mode</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.mirostat_mode} numberMode />
    <span class="text-textcolor">mirostat_tau</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.mirostat_tau} numberMode />
    <span class="text-textcolor">mirostat_eta</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.mirostat_eta} numberMode />
    <span class="text-textcolor">encoder_repetition_penalty</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.encoder_repetition_penalty} numberMode />
    <span class="text-textcolor">no_repeat_ngram_size</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.no_repeat_ngram_size} numberMode />
    <span class="text-textcolor">min_length</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.min_length} numberMode />
    <span class="text-textcolor">num_beams</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.num_beams} numberMode />
    <span class="text-textcolor">length_penalty</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.length_penalty} numberMode />
    <span class="text-textcolor">truncation_length</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.truncation_length} numberMode />
    <span class="text-textcolor">max_tokens_second</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.max_tokens_second} numberMode />
    <span class="text-textcolor">negative_prompt</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.negative_prompt} />
    <span class="text-textcolor">custom_token_bans</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.custom_token_bans} />
    <span class="text-textcolor">grammar_string</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.grammar_string} />

    <span class="text-textcolor">temperature_last</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.temperature_last} boolMode />
    <span class="text-textcolor">do_sample</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.do_sample} boolMode />
    <span class="text-textcolor">early_stopping</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.early_stopping} boolMode />
    <span class="text-textcolor">auto_max_new_tokens</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.auto_max_new_tokens} boolMode />

    <span class="text-textcolor">ban_eos_token</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.ban_eos_token} boolMode />
    <span class="text-textcolor">add_bos_token</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.add_bos_token} boolMode />
    <span class="text-textcolor">skip_special_tokens</span>
    <OptionalInput marginBottom={true} bind:value={presetStore.state.reverseProxyOobaArgs.skip_special_tokens} boolMode />


    {#if instructionMode}
        <div class="flex items-center mt-4">
            <CheckInput check={!!presetStore.state.localStopStrings} name={language.customStopWords} onChange={() => {
                if(!presetStore.state.localStopStrings){
                    presetStore.state.localStopStrings = []
                }
                else{
                    presetStore.state.localStopStrings = null
                }
            }} />
        </div>
        {#if presetStore.state.localStopStrings}
            <div class="flex flex-col p-2 rounded-sm border border-selected mt-2 gap-1">
                <div class="p-2">
                    <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                        let localStopStrings = presetStore.state.localStopStrings
                        localStopStrings.push('')
                        presetStore.state.localStopStrings = localStopStrings
                    }}><PlusIcon /></button>
                </div>
                {#each presetStore.state.localStopStrings as stopString, i}
                    <div class="flex w-full">
                        <div class="grow">
                            <TextInput marginBottom bind:value={presetStore.state.localStopStrings[i]} fullwidth fullh/>
                        </div>
                        <div>
                            <button class="font-medium flex justify-center items-center h-full cursor-pointer hover:text-green-500 w-full" onclick={() => {
                                let localStopStrings = presetStore.state.localStopStrings
                                localStopStrings.splice(i, 1)
                                presetStore.state.localStopStrings = localStopStrings
                            }}><TrashIcon /></button>
                        </div>
                    </div>
                {/each}
            </div>
        {/if}
    {/if}
</Accordion>