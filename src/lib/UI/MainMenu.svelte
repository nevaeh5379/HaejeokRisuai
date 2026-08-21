<script lang="ts">
    import { DBState, OpenRealmStore } from "src/ts/stores.svelte";
    import { ArrowLeft, StarIcon, SortAscIcon, SearchIcon } from "@lucide/svelte";
    import { getVersionString } from "src/ts/globalApi.svelte";
    import { language } from "src/lang";
    import { getCharImage } from "src/ts/characterImage";
    import { changeChar } from "src/ts/characters";
    import Title from "./Title.svelte";
    import LazyComponent from '../Others/LazyComponent.svelte'

    const realmLoader = () => import('./Realm/RealmMain.svelte')

    type SortMode = 'default' | 'name' | 'recent' | 'favorite'

    let sortMode = $state<SortMode>('default')
    let showFavoritesOnly = $state(false)
    let showHidden = $state(false)
    let searchQuery = $state('')

    let contextMenu = $state<{ x: number; y: number; index: number } | null>(null)

    let allCharacters = $derived(DBState.db.characters ?? [])
    let favorites = $derived(DBState.db.characterFavorites ?? [])
    let hidden = $derived(DBState.db.characterHidden ?? [])

    // Image URL cache — keyed by chaId, survives re-sort/filter without re-fetch
    let imageUrlCache = $state(new Map<string, string | null>())
    // Non-reactive set to track which chaIds have been requested — prevents duplicate fetches
    let requestedIds = new Set<string>()

    // Progressive loading — only render items visible (or near) the viewport
    const PAGE_SIZE = 24
    let visibleCount = $state(PAGE_SIZE)

    function isFavorite(char: any): boolean {
        return favorites.includes(char.chaId)
    }
    function isHidden(char: any): boolean {
        return hidden.includes(char.chaId)
    }

    function charCreator(char: any): string {
        return (char.creator ?? '').toLowerCase()
    }
    function charTags(char: any): string[] {
        return (char.tags ?? []).map((t: string) => t.toLowerCase())
    }

    let sortedCharacters = $derived.by(() => {
        let list = allCharacters.map((char, index) => ({ char, index }))

        if (!showHidden) {
            list = list.filter(({ char }) => !isHidden(char))
        }

        if (showFavoritesOnly) {
            list = list.filter(({ char }) => isFavorite(char))
        }

        const q = searchQuery.trim().toLowerCase()
        if (q) {
            list = list.filter(({ char }) => {
                const name = (char.name ?? '').toLowerCase()
                const creator = charCreator(char)
                const tags = charTags(char)
                return name.includes(q) || creator.includes(q) || tags.some((t: string) => t.includes(q))
            })
        }

        switch (sortMode) {
            case 'name':
                return [...list].sort((a, b) =>
                    (a.char.name ?? '').localeCompare(b.char.name ?? '')
                )
            case 'recent':
                return [...list].sort((a, b) =>
                    (b.char.lastInteraction ?? 0) - (a.char.lastInteraction ?? 0)
                )
            case 'favorite':
                return [...list].sort((a, b) => {
                    const af = isFavorite(a.char) ? 1 : 0
                    const bf = isFavorite(b.char) ? 1 : 0
                    return bf - af
                })
            default:
                return list
        }
    })

    let visibleCharacters = $derived(sortedCharacters.slice(0, visibleCount))

    // Reset paging when filter/sort/search changes
    $effect(() => {
        // Touch reactive deps to track changes
        void showHidden; void showFavoritesOnly; void searchQuery; void sortMode
        visibleCount = PAGE_SIZE
    })

    // IntersectionObserver sentinel — loads next page when sentinel enters view
    let sentinelEl = $state<HTMLDivElement | null>(null)
    let observer: IntersectionObserver | null = null

    $effect(() => {
        if (!sentinelEl) return
        observer?.disconnect()
        observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting && visibleCount < sortedCharacters.length) {
                    visibleCount = Math.min(visibleCount + PAGE_SIZE, sortedCharacters.length)
                }
            }
        }, { rootMargin: '300px' })
        observer.observe(sentinelEl)
        return () => observer?.disconnect()
    })

    // Preload image URLs for visible items in batch (parallel)
    $effect(() => {
        const items = visibleCharacters
        const toLoad = items.filter(({ char }) =>
            char.image && !DBState.db.hideAllImages && !requestedIds.has(char.chaId)
        )
        if (toLoad.length === 0) return

        for (const { char } of toLoad) {
            requestedIds.add(char.chaId)
        }

        let cancelled = false
        for (const { char } of toLoad) {
            getCharImage(char.image, 'plain').then((src) => {
                if (cancelled) return
                imageUrlCache.set(char.chaId, src ?? null)
                imageUrlCache = new Map(imageUrlCache)
            }).catch(() => {
                if (cancelled) return
                imageUrlCache.set(char.chaId, null)
                imageUrlCache = new Map(imageUrlCache)
            })
        }
        return () => { cancelled = true }
    })

    function getImageUrl(chaId: string): string | null | undefined {
        return imageUrlCache.get(chaId)
    }

    function toggleFavorite(index: number) {
        const char = DBState.db.characters?.[index]
        if (!char) return
        const chaId = char.chaId
        const favs = DBState.db.characterFavorites ?? []
        const i = favs.indexOf(chaId)
        if (i >= 0) {
            DBState.db.characterFavorites = favs.filter(id => id !== chaId)
        } else {
            DBState.db.characterFavorites = [...favs, chaId]
        }
    }

    function toggleHidden(index: number) {
        const char = DBState.db.characters?.[index]
        if (!char) return
        const chaId = char.chaId
        const hid = DBState.db.characterHidden ?? []
        const i = hid.indexOf(chaId)
        if (i >= 0) {
            DBState.db.characterHidden = hid.filter(id => id !== chaId)
        } else {
            DBState.db.characterHidden = [...hid, chaId]
        }
    }

    function openContextMenu(index: number, e: MouseEvent) {
        e.preventDefault()
        e.stopPropagation()
        contextMenu = { x: e.clientX, y: e.clientY, index }
    }

    function openContextMenuTouch(index: number, e: TouchEvent) {
        e.preventDefault()
        e.stopPropagation()
        const touch = e.touches[0] ?? e.changedTouches[0]
        contextMenu = { x: touch.clientX, y: touch.clientY, index }
    }

    function closeContextMenu() {
        contextMenu = null
    }

    const sortLabels: Record<SortMode, string> = {
        default: 'Default',
        name: 'Name (A-Z)',
        recent: 'Recently Used',
        favorite: 'Favorites First',
    }
</script>
<svelte:window on:click={closeContextMenu} on:contextmenu|preventDefault={closeContextMenu} />
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
      <div class="flex items-center gap-2 mb-4 flex-wrap">
        <div class="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-darkbg rounded-md flex-1 min-w-[180px] max-w-md">
          <SearchIcon class="w-4 h-4 text-textcolor2 shrink-0" />
          <input
            type="text"
            placeholder="Search characters..."
            class="bg-transparent text-textcolor outline-none text-sm w-full placeholder:text-textcolor2/60"
            bind:value={searchQuery}
          />
        </div>
        <button
          class="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md transition-colors shrink-0 {showFavoritesOnly ? 'bg-selected text-textcolor' : 'bg-darkbg text-textcolor2 hover:text-textcolor'}"
          onclick={() => (showFavoritesOnly = !showFavoritesOnly)}
        >
          <StarIcon class="w-4 h-4" fill={showFavoritesOnly ? 'currentColor' : 'none'} />
          Favorites
        </button>
        <button
          class="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md transition-colors shrink-0 {showHidden ? 'bg-selected text-textcolor' : 'bg-darkbg text-textcolor2 hover:text-textcolor'}"
          title={showHidden ? 'Showing hidden characters' : 'Click to show hidden characters'}
          onclick={() => (showHidden = !showHidden)}
        >
          {showHidden ? 'Show Hidden' : 'Hide Hidden'}
        </button>
        <div class="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-darkbg rounded-md shrink-0">
          <SortAscIcon class="w-4 h-4 text-textcolor2" />
          <select
            class="bg-transparent text-textcolor2 outline-none cursor-pointer text-sm appearance-none"
            bind:value={sortMode}
          >
            {#each Object.entries(sortLabels) as [mode, label]}
              <option value={mode} class="bg-darkbg">{label}</option>
            {/each}
          </select>
        </div>
      </div>
      {#if visibleCharacters.length > 0}
        <div class="columns-2 sm:columns-3 md:columns-4 lg:columns-5 xl:columns-6 gap-3">
          {#each visibleCharacters as { char, index } (char.chaId)}
            <button
              class="group relative w-full mb-3 break-inside-avoid overflow-hidden rounded-xl bg-darkbg block transition-all duration-300 hover:-translate-y-1 hover:ring-2 hover:ring-selected/50 hover:shadow-xl hover:shadow-darkbg/50"
              onclick={() => changeChar(index)}
              oncontextmenu={(e) => openContextMenu(index, e)}
              ontouchstart={(e) => {
                let timer: ReturnType<typeof setTimeout>
                let moved = false
                const start = { x: e.touches[0].clientX, y: e.touches[0].clientY }
                const onStart = (ev: TouchEvent) => {
                    if (Math.abs(ev.touches[0].clientX - start.x) > 10 || Math.abs(ev.touches[0].clientY - start.y) > 10) {
                        moved = true
                        clearTimeout(timer)
                    }
                }
                const onEnd = () => {
                    clearTimeout(timer)
                    e.target.removeEventListener('touchmove', onStart)
                    e.target.removeEventListener('touchend', onEnd)
                }
                timer = setTimeout(() => {
                    if (!moved) openContextMenuTouch(index, e)
                    e.target.removeEventListener('touchmove', onStart)
                    e.target.removeEventListener('touchend', onEnd)
                }, 500)
                e.target.addEventListener('touchmove', onStart, { passive: true })
                e.target.addEventListener('touchend', onEnd, { passive: true })
              }}
            >
              {#if char.image && !DBState.db.hideAllImages}
                {@const url = getImageUrl(char.chaId)}
                {#if url === undefined}
                  <div class="w-full aspect-square bg-darkbutton animate-pulse"></div>
                {:else if url}
                  <img
                    src={url}
                    alt={char.name}
                    class="w-full h-auto block transition-transform duration-300 group-hover:scale-105 {isHidden(char) && DBState.db.blurHiddenCharacters ? 'blur-xl' : ''}"
                    loading="lazy"
                    decoding="async"
                    draggable="false"
                  />
                {:else}
                  <div class="w-full aspect-square flex items-center justify-center bg-darkbutton text-textcolor2 text-4xl font-bold">
                    {char.name?.charAt(0)?.toUpperCase() ?? '?'}
                  </div>
                {/if}
              {:else}
                <div class="w-full aspect-square flex items-center justify-center bg-darkbutton text-textcolor2 text-4xl font-bold">
                  {char.name?.charAt(0)?.toUpperCase() ?? '?'}
                </div>
              {/if}
              {#if isFavorite(char)}
                <div class="absolute top-2 right-2 z-10 flex gap-1">
                  <div class="p-1 rounded-full bg-black/40 backdrop-blur-sm text-yellow-400 pointer-events-none">
                    <StarIcon class="w-3 h-3" fill="currentColor" />
                  </div>
                </div>
              {/if}
              <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2 pt-8 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <span class="text-white text-sm font-medium truncate block">{char.name}</span>
              </div>
            </button>
          {/each}
        </div>
        {#if visibleCount < sortedCharacters.length}
          <div bind:this={sentinelEl} class="w-full h-10 flex items-center justify-center py-4">
            <div class="w-6 h-6 border-2 border-textcolor2/30 border-t-textcolor2 rounded-full animate-spin"></div>
          </div>
        {/if}
      {:else}
        <div class="text-textcolor2 text-center py-12">
          {#if searchQuery.trim()}
            No characters found matching "{searchQuery}".
          {:else if showFavoritesOnly}
            No favorite characters yet. Long-press or right-click a character to add it.
          {:else}
            No characters yet. Click "Get More" to browse the {language.hub}.
          {/if}
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

{#if contextMenu}
  {#if DBState.db.characters?.[contextMenu.index]}
    {@const char = DBState.db.characters[contextMenu.index]}
    <div
      class="fixed z-50 min-w-[180px] rounded-lg border border-borderc/20 bg-darkbg shadow-xl py-1 text-sm select-none"
      style="left: {Math.min(contextMenu.x, window.innerWidth - 200)}px; top: {Math.min(contextMenu.y, window.innerHeight - 160)}px;"
      role="menu"
      tabindex="-1"
    >
      <button
        class="w-full px-4 py-2 text-left flex items-center gap-2 hover:bg-selected/50 transition-colors text-textcolor"
        role="menuitem"
        onclick={(e) => { e.stopPropagation(); toggleFavorite(contextMenu!.index); closeContextMenu() }}
      >
        <StarIcon class="w-4 h-4" fill={isFavorite(char) ? 'currentColor' : 'none'} />
        {isFavorite(char) ? 'Remove from Favorites' : 'Add to Favorites'}
      </button>
      <button
        class="w-full px-4 py-2 text-left flex items-center gap-2 hover:bg-selected/50 transition-colors text-textcolor"
        role="menuitem"
        onclick={(e) => { e.stopPropagation(); toggleHidden(contextMenu!.index); closeContextMenu() }}
      >
        {isHidden(char) ? 'Unhide' : 'Hide'}
      </button>
    </div>
  {/if}
{/if}