<script lang="ts">
    import { ParseMarkdown, risuChatParser } from "src/ts/parser/parser.svelte";
    import type { character, groupChat } from "../../ts/storage/database/schema";
    import { characterStore } from 'src/ts/stores/domain';
    import { moduleBackgroundEmbedding, ReloadGUIPointer } from "src/ts/stores.svelte";

    let backgroundHTML = $derived(characterStore.characters?.[characterStore.selectedId]?.backgroundHTML)
    let currentChar:character|groupChat = $derived(characterStore.characters?.[characterStore.selectedId])

</script>


{#if backgroundHTML || $moduleBackgroundEmbedding}
    {#if characterStore.selectedId > -1}
        {#key $ReloadGUIPointer}
            <div class="absolute top-0 left-0 w-full h-full">
                {#await ParseMarkdown(risuChatParser((backgroundHTML || '') + '\n' + ($moduleBackgroundEmbedding || ''), {chara:currentChar}), currentChar, 'back') then md} 
                    {@html md}
                {/await}
            </div>
        {/key}
    {/if}
{/if}
