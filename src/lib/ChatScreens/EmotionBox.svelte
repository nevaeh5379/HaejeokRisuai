<script>
    import { characterStore } from 'src/ts/stores/domain';
    import { CharEmotion } from '../../ts/stores.svelte';
    import { getEmotion } from '../../ts/util';
</script>

{#await getEmotion({ characters: characterStore.characters } as any, $CharEmotion, 'contain') then images}
    {#each images as image, i}
    <div style={image + `width:${(100 / images.length)}%;bottom:0;left:${100 / images.length * i}%`} class="h-full bg-center absolute"></div>

    {/each}
{/await}

<style>
    .h-full {
        height: 100%;
    }
    .bg-center {
        background-position: center;
    }
</style>