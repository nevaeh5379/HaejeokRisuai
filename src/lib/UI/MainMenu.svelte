<script lang="ts">
    import { DBState, OpenRealmStore } from "src/ts/stores.svelte";
    import { ArrowLeft } from "@lucide/svelte";
    import { getVersionString } from "src/ts/globalApi.svelte";
    import { language } from "src/lang";
    import { getCharImage } from "src/ts/characterImage";
    import { changeChar } from "src/ts/characters";
    import Title from "./Title.svelte";
    import LazyComponent from '../Others/LazyComponent.svelte'

    const realmLoader = () => import('./Realm/RealmMain.svelte')

    let characters = $derived(DBState.db.characters ?? [])
</script>
<div class="h-full w-full flex flex-col overflow-y-auto items-center">
    {#if !$OpenRealmStore}
      <Title />
      <h3 class="text-textcolor2 mt-1">Version {getVersionString()}</h3>
    {/if}
    <div class="w-full flex p-4 flex-col text-textcolor max-w-6xl">
      {#if !$OpenRealmStore}
      <div class="mt-4 mb-4 w-full border-t border-t-selected"></div>
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-bold">{language.character}</h1>
        <button class="text-sm font-medium px-3 py-1.5 bg-darkbg rounded-md hover:bg-selected transition-colors" onclick={() => {
          $OpenRealmStore = true
        }}>Get More</button>
      </div>
      {#if characters.length > 0}
        <div class="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-3">
          {#each characters as char, index (char.chaId)}
            <button
              class="group relative w-full mb-3 break-inside-avoid overflow-hidden rounded-xl bg-darkbg block transition-all duration-300 hover:-translate-y-1 hover:ring-2 hover:ring-selected/50 hover:shadow-xl hover:shadow-darkbg/50"
              onclick={() => changeChar(index)}
            >
              {#if char.image && !DBState.db.hideAllImages}
                {#await getCharImage(char.image, 'plain') then src}
                  {#if src}
                    <img
                      src={src}
                      alt={char.name}
                      class="w-full h-auto block transition-transform duration-300 group-hover:scale-105"
                      loading="lazy"
                      decoding="async"
                    />
                  {:else}
                    <div class="w-full aspect-square flex items-center justify-center bg-darkbutton text-textcolor2 text-4xl font-bold">
                      {char.name?.charAt(0)?.toUpperCase() ?? '?'}
                    </div>
                  {/if}
                {:catch}
                  <div class="w-full aspect-square flex items-center justify-center bg-darkbutton text-textcolor2 text-4xl font-bold">
                    {char.name?.charAt(0)?.toUpperCase() ?? '?'}
                  </div>
                {/await}
              {:else}
                <div class="w-full aspect-square flex items-center justify-center bg-darkbutton text-textcolor2 text-4xl font-bold">
                  {char.name?.charAt(0)?.toUpperCase() ?? '?'}
                </div>
              {/if}
              <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2 pt-8 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <span class="text-white text-sm font-medium truncate block">{char.name}</span>
              </div>
            </button>
          {/each}
        </div>
      {:else}
        <div class="text-textcolor2 text-center py-12">
          No characters yet. Click "Get More" to browse the {language.hub}.
        </div>
      {/if}

      {:else}
        <div class="flex items-center mt-4">
          <button class="mr-2 text-textcolor2 hover:text-green-500" onclick={() => ($OpenRealmStore = false)}>
            <ArrowLeft/>
          </button>
        </div>
        <LazyComponent loader={realmLoader} />
      {/if}
  </div>
</div>