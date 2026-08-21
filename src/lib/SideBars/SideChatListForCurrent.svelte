<script lang="ts">
    import { selectedCharID } from 'src/ts/stores.svelte'
    import { characterStore } from 'src/ts/stores/domain'
    import SideChatList from './SideChatList.svelte'
</script>

{#if $selectedCharID >= 0 && characterStore.characters[$selectedCharID]}
    <SideChatList bind:chara={characterStore.characters[$selectedCharID]} />
{/if}
