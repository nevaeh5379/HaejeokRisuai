<script lang="ts">
  import { settingsStore } from 'src/ts/stores/domain';
  import { getHordeModels } from "src/ts/horde/getModels";
  import { language } from "src/lang";
  import CheckInput from "./GUI/CheckInput.svelte";
  import { getModelInfo, getModelList, LLMFlags, LLMProvider, ProviderNames, type LLMModel } from 'src/ts/model/modellist';
  import { modelFavoritesStore } from 'src/ts/model/modelFavorites.svelte';
  import { 
    XIcon, 
    SearchIcon, 
    StarIcon, 
    SparkleIcon, 
    ChevronDownIcon, 
    EyeIcon, 
    BrainIcon, 
    ZapIcon, 
    BotIcon, 
    CheckIcon,
    LayersIcon,
    RotateCcwIcon
  } from "@lucide/svelte";

  interface Props {
    value?: string;
    onChange?: (v: string) => void;
    onclick?: (event: MouseEvent & {
      currentTarget: EventTarget & HTMLDivElement;
    }) => any;
    blankable?: boolean;
    excludesPrefix?: string;
    noMargin?: boolean;
    inlineCard?: boolean;
  }

  let { 
    value = $bindable(""), 
    onChange = (v) => {}, 
    onclick, 
    blankable, 
    excludesPrefix, 
    noMargin,
    inlineCard = false
  }: Props = $props();

  let openOptions = $state(false);
  let searchQuery = $state('');
  let activeCategory = $state<'all' | 'recommended' | 'favorites' | 'recent' | string>('all');
  let activeTag = $state<'all' | 'vision' | 'thinking' | 'custom'>('all');
  let showUnrecommended = $state(false);

  function changeModel(name: string) {
    value = name;
    modelFavoritesStore.addRecent(name);
    openOptions = false;
    onChange(name);
  }

  let currentModelInfo = $derived(value ? getModelInfo(value) : null);

  // Raw models list
  let allRawModels = $derived.by(() => {
    const list = getModelList({ recommendedOnly: false, groupedByProvider: false });
    let models: LLMModel[] = [...list];
    
    // Append custom models
    if (settingsStore.state.customModels?.length > 0) {
      for (const cm of settingsStore.state.customModels) {
        models.push({
          id: cm.id,
          name: cm.name || "Custom Model",
          fullName: `Custom: ${cm.name || cm.id}`,
          provider: LLMProvider.AsIs,
          flags: [],
          format: 0 as any,
          parameters: [],
          tokenizer: 0 as any,
          recommended: true
        });
      }
    }
    return models;
  });

  // Providers list for sidebar
  let providerGroups = $derived.by(() => {
    return getModelList({ recommendedOnly: false, groupedByProvider: true });
  });

  function hasVision(model: LLMModel): boolean {
    return model.flags?.includes(LLMFlags.hasImageInput) ?? false;
  }

  function hasThinking(model: LLMModel): boolean {
    if (!model.flags) return false;
    return model.flags.includes(LLMFlags.claudeThinking) ||
      model.flags.includes(LLMFlags.geminiThinking) ||
      model.flags.includes(LLMFlags.deepSeekThinkingInput) ||
      model.flags.includes(LLMFlags.deepSeekThinkingOutput) ||
      model.flags.includes(LLMFlags.deepSeekThinkingToggle);
  }

  function hasStreaming(model: LLMModel): boolean {
    return model.flags?.includes(LLMFlags.hasStreaming) ?? false;
  }

  function isCustomOrPlugin(model: LLMModel): boolean {
    return model.id.startsWith('custom') || model.id.startsWith('plugin') || model.provider === LLMProvider.AsIs;
  }

  // Filtered models
  let displayedModels = $derived.by(() => {
    let list = allRawModels.filter(m => !excludesPrefix || !m.id.startsWith(excludesPrefix));

    // Search query filter
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      list = list.filter(m => {
        const pName = ProviderNames.get(m.provider) || '';
        return m.name.toLowerCase().includes(query) ||
          (m.fullName && m.fullName.toLowerCase().includes(query)) ||
          m.id.toLowerCase().includes(query) ||
          pName.toLowerCase().includes(query);
      });
    }

    // Category filter
    if (activeCategory === 'favorites') {
      list = list.filter(m => modelFavoritesStore.isFavorite(m.id));
    } else if (activeCategory === 'recent') {
      const recentIds = modelFavoritesStore.recent;
      list = list
        .filter(m => recentIds.includes(m.id))
        .sort((a, b) => recentIds.indexOf(a.id) - recentIds.indexOf(b.id));
    } else if (activeCategory === 'recommended') {
      list = list.filter(m => m.recommended);
    } else if (activeCategory.startsWith('provider_')) {
      const targetProviderName = activeCategory.replace('provider_', '');
      list = list.filter(m => {
        const pName = ProviderNames.get(m.provider) || 'Unknown';
        return pName === targetProviderName || (targetProviderName === 'Plugins' && m.id.startsWith('plugin'));
      });
    }

    // Tag filter
    if (activeTag === 'vision') {
      list = list.filter(m => hasVision(m));
    } else if (activeTag === 'thinking') {
      list = list.filter(m => hasThinking(m));
    } else if (activeTag === 'custom') {
      list = list.filter(m => isCustomOrPlugin(m));
    }

    // Unrecommended filter (only when not searching and not specifically in category)
    if (!showUnrecommended && !query && activeCategory === 'all' && activeTag === 'all') {
      list = list.filter(m => m.recommended);
    }

    return list;
  });

  function getProviderDisplayName(model: LLMModel): string {
    if (model.id.startsWith('plugin')) return 'Plugin';
    if (model.id.startsWith('horde:::')) return 'Horde';
    return ProviderNames.get(model.provider) || 'AI';
  }
</script>

{#if openOptions}
  <!-- Modal Backdrop -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div 
    class="fixed inset-0 bg-black/65 backdrop-blur-xs z-50 flex items-center justify-center p-3 sm:p-5" 
    role="button" 
    tabindex="0" 
    onclick={() => { openOptions = false; }}
  >
    <!-- Modal Dialog -->
    <div 
      class="w-full max-w-4xl h-[90vh] sm:h-[82vh] max-h-[760px] bg-bgcolor border border-darkborderc rounded-2xl shadow-2xl flex flex-col overflow-hidden text-textcolor animate-in fade-in zoom-in-95 duration-150" 
      role="button" 
      tabindex="0" 
      onclick={(e) => { e.stopPropagation(); onclick?.(e); }}
    >
      <!-- Header -->
      <div class="flex items-center justify-between px-5 py-4 border-b border-darkborderc bg-darkbg/40">
        <div class="flex items-center gap-3">
          <div class="p-2 rounded-xl bg-textcolor/10 text-textcolor">
            <BotIcon size={22} />
          </div>
          <div>
            <h2 class="font-bold text-lg leading-tight">{language.selectModel || language.model}</h2>
            <p class="text-xs text-textcolor2">
              {#if currentModelInfo}
                {language.model}: <span class="font-semibold text-textcolor">{currentModelInfo.fullName || currentModelInfo.name}</span>
              {:else if value}
                {language.model}: <span class="font-semibold text-textcolor">{value}</span>
              {:else}
                <span class="text-textcolor2">{language.none}</span>
              {/if}
            </p>
          </div>
        </div>
        <button 
          class="p-2 rounded-xl text-textcolor2 hover:text-textcolor hover:bg-selected/30 transition-colors"
          onclick={() => { openOptions = false; }}
          aria-label="Close"
        >
          <XIcon size={20} />
        </button>
      </div>

      <!-- Controls & Filters Bar -->
      <div class="p-3 sm:px-5 sm:py-3 border-b border-darkborderc bg-bgcolor flex flex-col gap-2.5">
        <!-- Search bar -->
        <div class="relative w-full">
          <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none text-textcolor2">
            <SearchIcon size={18} />
          </div>
          <input 
            type="text"
            bind:value={searchQuery}
            placeholder={language.searchModelPlaceholder || "Search models (name, ID, provider)..."}
            class="w-full pl-10 pr-9 py-2 rounded-xl border border-darkborderc bg-darkbutton text-textcolor placeholder-textcolor2/60 text-sm focus:outline-none focus:ring-2 focus:ring-textcolor/30 transition-all"
          />
          {#if searchQuery}
            <button 
              class="absolute inset-y-0 right-3 flex items-center text-textcolor2 hover:text-textcolor"
              onclick={() => { searchQuery = ''; }}
              title={language.clearSearch || "Clear"}
            >
              <XIcon size={16} />
            </button>
          {/if}
        </div>

        <!-- Quick filter chips & Unrecommended toggle -->
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full text-xs font-medium scrollbar-none">
            <button 
              class="px-3 py-1.5 rounded-lg transition-colors shrink-0 {activeTag === 'all' ? 'bg-selected text-textcolor font-bold ring-1 ring-textcolor/30' : 'bg-darkbutton/80 text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
              onclick={() => { activeTag = 'all'; }}
            >
              {language.filterAll || "All"}
            </button>
            <button 
              class="px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 shrink-0 {activeTag === 'vision' ? 'bg-selected text-textcolor font-bold ring-1 ring-textcolor/30' : 'bg-darkbutton/80 text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
              onclick={() => { activeTag = 'vision'; }}
            >
              <EyeIcon size={13} /> {language.filterVision || "Vision"}
            </button>
            <button 
              class="px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 shrink-0 {activeTag === 'thinking' ? 'bg-selected text-textcolor font-bold ring-1 ring-textcolor/30' : 'bg-darkbutton/80 text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
              onclick={() => { activeTag = 'thinking'; }}
            >
              <BrainIcon size={13} /> {language.filterThinking || "Thinking"}
            </button>
            <button 
              class="px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1 shrink-0 {activeTag === 'custom' ? 'bg-selected text-textcolor font-bold ring-1 ring-textcolor/30' : 'bg-darkbutton/80 text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
              onclick={() => { activeTag = 'custom'; }}
            >
              <LayersIcon size={13} /> {language.filterCustom || "Custom"}
            </button>
          </div>

          <div class="text-xs text-textcolor2 flex items-center shrink-0">
            <CheckInput name={language.showUnrecommended} grayText bind:check={showUnrecommended} />
          </div>
        </div>
      </div>

      <!-- Main Body: 2-Panel Layout (Categories Sidebar + Models Grid) -->
      <div class="flex-1 flex overflow-hidden">
        <!-- Sidebar Navigation -->
        <div class="w-44 sm:w-52 border-r border-darkborderc bg-darkbg/30 p-2 overflow-y-auto flex flex-col gap-1 text-xs shrink-0">
          <button 
            class="flex items-center gap-2 px-3 py-2 rounded-xl text-left font-medium transition-colors {activeCategory === 'all' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => { activeCategory = 'all'; }}
          >
            <BotIcon size={15} />
            <span class="truncate flex-1">{language.allModels || language.model}</span>
          </button>

          <button 
            class="flex items-center gap-2 px-3 py-2 rounded-xl text-left font-medium transition-colors {activeCategory === 'recommended' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => { activeCategory = 'recommended'; }}
          >
            <SparkleIcon size={15} class="text-amber-400" />
            <span class="truncate flex-1">{language.filterRecommended || "Recommended"}</span>
          </button>

          <button 
            class="flex items-center gap-2 px-3 py-2 rounded-xl text-left font-medium transition-colors {activeCategory === 'favorites' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => { activeCategory = 'favorites'; }}
          >
            <StarIcon size={15} class="text-yellow-400 fill-yellow-400" />
            <span class="truncate flex-1">{language.filterFavorites || "Favorites"}</span>
            {#if modelFavoritesStore.favorites.length > 0}
              <span class="px-1.5 py-0.5 rounded-full text-[10px] bg-textcolor/10 text-textcolor font-semibold">{modelFavoritesStore.favorites.length}</span>
            {/if}
          </button>

          <button 
            class="flex items-center gap-2 px-3 py-2 rounded-xl text-left font-medium transition-colors {activeCategory === 'recent' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => { activeCategory = 'recent'; }}
          >
            <RotateCcwIcon size={15} class="text-sky-400" />
            <span class="truncate flex-1">{language.filterRecent || "Recent"}</span>
          </button>

          <div class="my-1.5 border-t border-darkborderc/60"></div>
          <span class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-textcolor2/70">{language.providerNames || "Providers"}</span>

          {#each providerGroups as group}
            {#if group.providerName !== '@as-is'}
              <button 
                class="flex items-center justify-between px-3 py-1.5 rounded-lg text-left transition-colors {activeCategory === 'provider_' + group.providerName ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
                onclick={() => { activeCategory = 'provider_' + group.providerName; }}
              >
                <span class="truncate">{group.providerName}</span>
                <span class="text-[10px] text-textcolor2/60">{group.models.length}</span>
              </button>
            {/if}
          {/each}

          <button 
            class="flex items-center justify-between px-3 py-1.5 rounded-lg text-left transition-colors {activeCategory === 'provider_Horde' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton hover:text-textcolor'}"
            onclick={() => { activeCategory = 'provider_Horde'; }}
          >
            <span class="truncate">Horde</span>
          </button>
        </div>

        <!-- Models Grid Area -->
        <div class="flex-1 overflow-y-auto p-4 bg-bgcolor">
          {#if activeCategory === 'provider_Horde'}
            <!-- Horde Async Models -->
            <div class="flex flex-col gap-3">
              <h3 class="font-bold text-sm text-textcolor flex items-center gap-1.5">
                <BotIcon size={16} /> AI Horde Models
              </h3>
              {#await getHordeModels()}
                <div class="py-12 flex flex-col items-center justify-center gap-3 text-textcolor2">
                  <div class="h-7 w-7 rounded-full border-2 border-textcolor/30 border-t-textcolor animate-spin"></div>
                  <span class="text-xs">Fetching Horde models...</span>
                </div>
              {:then hordeModels}
                <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                  <button 
                    class="p-3 rounded-xl border text-left transition-all flex flex-col justify-between {value === 'horde:::auto' ? 'border-selected bg-selected/20 ring-1 ring-selected shadow-md' : 'border-darkborderc bg-darkbg/50 hover:bg-selected/10 hover:border-selected/50'}"
                    onclick={() => { changeModel('horde:::auto'); }}
                  >
                    <div>
                      <div class="flex items-center justify-between mb-1">
                        <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-textcolor/10 text-textcolor">Horde</span>
                        <span class="text-[10px] font-bold text-emerald-400">Auto</span>
                      </div>
                      <span class="font-bold text-sm text-textcolor block">Auto Model</span>
                      <span class="text-xs text-textcolor2">Automatic best worker selection</span>
                    </div>
                  </button>
                  {#each hordeModels as hm}
                    <button 
                      class="p-3 rounded-xl border text-left transition-all flex flex-col justify-between {value === 'horde:::' + hm.name ? 'border-selected bg-selected/20 ring-1 ring-selected shadow-md' : 'border-darkborderc bg-darkbg/50 hover:bg-selected/10 hover:border-selected/50'}"
                      onclick={() => { changeModel('horde:::' + hm.name); }}
                    >
                      <div>
                        <div class="flex items-center justify-between mb-1">
                          <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-textcolor/10 text-textcolor">Horde</span>
                          <span class="text-[10px] text-textcolor2">Perf: {hm.performance?.toFixed(1) ?? '1.0'}</span>
                        </div>
                        <span class="font-bold text-sm text-textcolor block truncate">{hm.name}</span>
                        <span class="text-xs text-textcolor2">Workers: {hm.count ?? 1}</span>
                      </div>
                    </button>
                  {/each}
                </div>
              {/await}
            </div>

          {:else}
            <!-- Regular / Filtered Models Grid -->
            {#if blankable}
              <div class="mb-3">
                <button 
                  class="w-full p-2.5 rounded-xl border border-dashed border-darkborderc hover:border-selected hover:bg-selected/10 transition-all flex items-center justify-between text-left {value === '' ? 'border-selected bg-selected/20' : 'text-textcolor2'}"
                  onclick={() => { changeModel(''); }}
                >
                  <div class="flex items-center gap-2">
                    <span class="font-semibold text-sm text-textcolor">{language.none || "None"}</span>
                    <span class="text-xs text-textcolor2">({language.unselect || "Clear selection"})</span>
                  </div>
                  {#if value === ''}
                    <CheckIcon size={16} class="text-textcolor" />
                  {/if}
                </button>
              </div>
            {/if}

            {#if displayedModels.length === 0}
              <div class="py-16 flex flex-col items-center justify-center text-center gap-3">
                <div class="p-4 rounded-full bg-darkbutton text-textcolor2">
                  <SearchIcon size={30} />
                </div>
                <div>
                  <h4 class="font-bold text-base text-textcolor">{language.noModelsFound || "No models found"}</h4>
                  <p class="text-xs text-textcolor2 mt-1">
                    {#if activeCategory === 'favorites'}
                      {language.noFavoriteModelsDesc || "No favorites yet. Star a model to access it quickly!"}
                    {:else if activeCategory === 'recent'}
                      {language.noRecentModelsDesc || "No recently used models yet."}
                    {:else}
                      Try adjusting your search query or tag filters.
                    {/if}
                  </p>
                </div>
              </div>
            {:else}
              <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
                {#each displayedModels as model}
                  {@const isSelected = value === model.id}
                  {@const isFav = modelFavoritesStore.isFavorite(model.id)}
                  <div 
                    class="group relative p-3 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between gap-2.5 {isSelected ? 'border-selected bg-selected/20 ring-1 ring-selected shadow-md' : 'border-darkborderc bg-darkbg/40 hover:bg-selected/10 hover:border-selected/60'}"
                    role="button"
                    tabindex="0"
                    onclick={() => { changeModel(model.id); }}
                    onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') changeModel(model.id); }}
                  >
                    <!-- Top row: Provider badge & Favorite button -->
                    <div class="flex items-center justify-between gap-1">
                      <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-textcolor/10 text-textcolor tracking-tight truncate max-w-[120px]">
                        {getProviderDisplayName(model)}
                      </span>
                      <button 
                        class="p-1 rounded-lg text-textcolor2/60 hover:text-yellow-400 transition-colors"
                        onclick={(e) => {
                          e.stopPropagation();
                          modelFavoritesStore.toggleFavorite(model.id);
                        }}
                        title="Toggle Favorite"
                      >
                        <StarIcon size={15} class={isFav ? "text-yellow-400 fill-yellow-400" : "hover:text-yellow-400"} />
                      </button>
                    </div>

                    <!-- Model Name and ID -->
                    <div>
                      <div class="flex items-center gap-1.5">
                        <span class="font-bold text-sm text-textcolor leading-snug truncate" title={model.fullName || model.name}>
                          {model.name}
                        </span>
                        {#if model.recommended}
                          <span class="text-amber-400 shrink-0" title="Recommended">
                            <SparkleIcon size={12} />
                          </span>
                        {/if}
                      </div>
                      <span class="text-[11px] text-textcolor2/70 block truncate font-mono mt-0.5">
                        {model.id}
                      </span>
                    </div>

                    <!-- Bottom row: Feature tags -->
                    <div class="flex items-center gap-1 flex-wrap text-[10px] font-medium pt-1 border-t border-darkborderc/40">
                      {#if hasVision(model)}
                        <span class="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 flex items-center gap-0.5">
                          <EyeIcon size={10} /> Vision
                        </span>
                      {/if}
                      {#if hasThinking(model)}
                        <span class="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400 flex items-center gap-0.5">
                          <BrainIcon size={10} /> Thinking
                        </span>
                      {/if}
                      {#if hasStreaming(model)}
                        <span class="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-400 flex items-center gap-0.5">
                          <ZapIcon size={10} /> Stream
                        </span>
                      {/if}
                      {#if isSelected}
                        <span class="ml-auto text-textcolor font-bold flex items-center gap-0.5 text-[11px]">
                          <CheckIcon size={13} /> Selected
                        </span>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}

<!-- Trigger View (Outside Modal) -->
<button 
  type="button"
  onclick={() => { openOptions = true; }}
  class={{
    "w-full text-left transition-all group flex items-center justify-between rounded-xl border border-darkborderc bg-darkbutton/80 hover:bg-selected/15 hover:border-selected/70": true,
    "p-3": !noMargin && !inlineCard,
    "p-2 text-xs": noMargin,
    "my-1.5": !noMargin,
  }}
>
  <div class="flex items-center gap-2.5 min-w-0">
    {#if currentModelInfo}
      <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-textcolor/10 text-textcolor2 shrink-0">
        {ProviderNames.get(currentModelInfo.provider) || "Model"}
      </span>
    {/if}
    <div class="min-w-0 flex items-center gap-2 flex-wrap">
      <span class="font-bold text-sm text-textcolor truncate">
        {currentModelInfo?.fullName || currentModelInfo?.name || value || language.none}
      </span>
      {#if value && currentModelInfo}
        {#if hasVision(currentModelInfo)}
          <span class="text-[10px] text-emerald-400 flex items-center gap-0.5 shrink-0"><EyeIcon size={10} /> Vision</span>
        {/if}
        {#if hasThinking(currentModelInfo)}
          <span class="text-[10px] text-purple-400 flex items-center gap-0.5 shrink-0"><BrainIcon size={10} /> Thinking</span>
        {/if}
      {/if}
    </div>
  </div>

  <div class="flex items-center gap-1.5 pl-2 text-textcolor2 group-hover:text-textcolor shrink-0">
    <span class="text-xs font-semibold hidden sm:inline">{language.changeModel || "Change"}</span>
    <ChevronDownIcon size={15} class="transition-transform group-hover:translate-y-0.5" />
  </div>
</button>
