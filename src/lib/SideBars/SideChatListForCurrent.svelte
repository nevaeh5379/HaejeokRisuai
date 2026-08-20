<script lang="ts">
    import { DBState, selectedCharID } from 'src/ts/stores.svelte'
    import SideChatList from './SideChatList.svelte'
</script>

{#if $selectedCharID >= 0 && DBState.db.characters[$selectedCharID]}
    <SideChatList bind:chara={DBState.db.characters[$selectedCharID]} />
{/if}
