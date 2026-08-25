<script lang="ts">
  import { settingsStore } from 'src/ts/stores/domain';
  import { getHordeModels } from "src/ts/horde/getModels";
  import { language } from "src/lang";
  import CheckInput from "../GUI/CheckInput.svelte";
  import { getModelInfo, getModelList, LLMFlags, LLMProvider, ProviderNames, type LLMModel } from 'src/ts/model/modellist';
  import { modelFavoritesStore } from 'src/ts/model/modelFavorites.svelte';
  import { 
    SearchIcon, 
    XIcon, 
    StarIcon, 
    SparkleIcon, 
    EyeIcon, 
    BrainIcon, 
    ZapIcon, 
    BotIcon, 
    CheckIcon,
    LayersIcon,
    RotateCcwIcon,
    ChevronDownIcon
  } from "@lucide/svelte";

  interface Props {
    value?: string;
    onChange?: (v: string) => void;
    blankable?: boolean;
    excludesPrefix?: string;
  }

  let { 
    value = $bindable(""), 
    onChange = (v) => {}, 
    blankable = false, 
    excludesPrefix
  }: Props = $props();

  let searchQuery = $state('');
  let activeCategory = $state<'all' | 'recommended' | 'favorites' | 'recent' | string>('all');
  let activeTag = $state<'all' | 'vision' | 'thinking' | 'custom'>('all');
  let selectedProvider = $state<string>('all');
  let showUnrecommended = $state(false);

  function selectModel(modelId: string) {
    value = modelId;
    if (modelId) {
      modelFavoritesStore.addRecent(modelId);
    }
    onChange(modelId);
  }

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

    // Deduplicate models by id
    const seen = new Set<string>();
    return models.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  });

  // Providers list
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
    }

    // Provider filter
    if (selectedProvider !== 'all') {
      list = list.filter(m => {
        const pName = ProviderNames.get(m.provider) || 'Unknown';
        return pName === selectedProvider || (selectedProvider === 'Plugins' && m.id.startsWith('plugin'));
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

    // Unrecommended filter
    if (!showUnrecommended && !query && activeCategory === 'all' && activeTag === 'all' && selectedProvider === 'all') {
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

<div class="w-full flex flex-col gap-3">
  <!-- Controls & Smart Filters Bar (Top Bar Integration) -->
  <div class="flex flex-col gap-2.5 pb-2.5 border-b border-darkborderc/60">
    <!-- Search Bar -->
    <div class="relative w-full">
      <div class="absolute inset-y-0 left-3 flex items-center pointer-events-none text-textcolor2">
        <SearchIcon size={16} />
      </div>
      <input 
        type="text"
        bind:value={searchQuery}
        placeholder={language.searchModelPlaceholder || "Search models (name, ID, provider)..."}
        class="w-full pl-9 pr-8 py-2 rounded-xl border border-darkborderc bg-darkbutton/80 text-textcolor placeholder-textcolor2/60 text-sm focus:outline-none focus:ring-1 focus:ring-textcolor/30 transition-all"
      />
      {#if searchQuery}
        <button 
          class="absolute inset-y-0 right-3 flex items-center text-textcolor2 hover:text-textcolor"
          onclick={() => { searchQuery = ''; }}
          title={language.clearSearch || "Clear"}
        >
          <XIcon size={14} />
        </button>
      {/if}
    </div>

    <!-- Filter Buttons & Provider Select Dropdown (All on Top) -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
      <!-- Left Category & Tag Chips (Horizontal scroll on mobile, flex-wrap on desktop) -->
      <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-nowrap sm:flex-wrap pb-1 sm:pb-0">
        <button 
          class="px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1 font-medium shrink-0 whitespace-nowrap {activeCategory === 'all' && selectedProvider === 'all' ? 'bg-darkbutton text-textcolor font-bold border border-darkborderc shadow-xs' : 'text-textcolor2 hover:bg-darkbutton/50 hover:text-textcolor'}"
          onclick={() => { activeCategory = 'all'; selectedProvider = 'all'; }}
        >
          <BotIcon size={13} /> {language.filterAll || "All"}
        </button>

        <button 
          class="px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1 font-medium shrink-0 whitespace-nowrap {activeCategory === 'recommended' ? 'bg-darkbutton text-textcolor font-bold border border-darkborderc shadow-xs' : 'text-textcolor2 hover:bg-darkbutton/50 hover:text-textcolor'}"
          onclick={() => { activeCategory = activeCategory === 'recommended' ? 'all' : 'recommended'; }}
        >
          <SparkleIcon size={13} /> {language.filterRecommended || "Recommended"}
        </button>

        <button 
          class="px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1 font-medium shrink-0 whitespace-nowrap {activeCategory === 'favorites' ? 'bg-darkbutton text-textcolor font-bold border border-darkborderc shadow-xs' : 'text-textcolor2 hover:bg-darkbutton/50 hover:text-textcolor'}"
          onclick={() => { activeCategory = activeCategory === 'favorites' ? 'all' : 'favorites'; }}
        >
          <StarIcon size={13} class={modelFavoritesStore.favorites.length > 0 ? "fill-current" : ""} />
          <span>{language.filterFavorites || "Favorites"}</span>
          {#if modelFavoritesStore.favorites.length > 0}
            <span class="px-1 py-0.2 rounded-full text-[9px] bg-textcolor/10 text-textcolor font-bold">{modelFavoritesStore.favorites.length}</span>
          {/if}
        </button>

        <button 
          class="px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1 font-medium shrink-0 whitespace-nowrap {activeCategory === 'recent' ? 'bg-darkbutton text-textcolor font-bold border border-darkborderc shadow-xs' : 'text-textcolor2 hover:bg-darkbutton/50 hover:text-textcolor'}"
          onclick={() => { activeCategory = activeCategory === 'recent' ? 'all' : 'recent'; }}
        >
          <RotateCcwIcon size={13} /> {language.filterRecent || "Recent"}
        </button>

        <!-- Provider Select Dropdown -->
        <div class="relative inline-flex items-center shrink-0">
          <select 
            bind:value={selectedProvider}
            class="appearance-none pl-2.5 pr-6 py-1.5 rounded-lg border border-darkborderc bg-darkbutton/70 text-textcolor text-xs font-medium focus:outline-none cursor-pointer"
          >
            <option value="all">{language.providerNames || "All Providers"}</option>
            {#each providerGroups as group}
              {#if group.providerName !== '@as-is'}
                <option value={group.providerName}>{group.providerName} ({group.models.length})</option>
              {/if}
            {/each}
            <option value="Horde">Horde</option>
          </select>
          <div class="pointer-events-none absolute right-2 text-textcolor2">
            <ChevronDownIcon size={12} />
          </div>
        </div>

        <div class="h-4 w-px bg-darkborderc/60 mx-1 hidden sm:block shrink-0"></div>

        <!-- Capability Tags -->
        <button 
          class="px-2 py-1 rounded-md transition-colors flex items-center gap-1 text-[11px] shrink-0 whitespace-nowrap {activeTag === 'vision' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton/50 hover:text-textcolor'}"
          onclick={() => { activeTag = activeTag === 'vision' ? 'all' : 'vision'; }}
        >
          <EyeIcon size={11} /> Vision
        </button>
        <button 
          class="px-2 py-1 rounded-md transition-colors flex items-center gap-1 text-[11px] shrink-0 whitespace-nowrap {activeTag === 'thinking' ? 'bg-selected text-textcolor font-bold' : 'text-textcolor2 hover:bg-darkbutton/50 hover:text-textcolor'}"
          onclick={() => { activeTag = activeTag === 'thinking' ? 'all' : 'thinking'; }}
        >
          <BrainIcon size={11} /> Thinking
        </button>
      </div>

      <!-- Unrecommended toggle -->
      <div class="text-xs text-textcolor2 flex items-center shrink-0">
        <CheckInput name={language.showUnrecommended} grayText bind:check={showUnrecommended} />
      </div>
    </div>
  </div>

  <!-- Models Area: Full Width 2-Column Balanced Grid (No Sidebar, No Dead Space) -->
  <div class="w-full">
    {#if selectedProvider === 'Horde'}
      <!-- Horde Async Models -->
      <div class="flex flex-col gap-3">
        <h4 class="font-bold text-sm text-textcolor flex items-center gap-1.5">
          <BotIcon size={16} /> AI Horde Models
        </h4>
        {#await getHordeModels()}
          <div class="py-16 flex flex-col items-center justify-center gap-3 text-textcolor2">
            <div class="h-7 w-7 rounded-full border-2 border-textcolor/30 border-t-textcolor animate-spin"></div>
            <span class="text-xs">Fetching Horde models...</span>
          </div>
        {:then hordeModels}
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[2200px]:grid-cols-5 gap-2.5">
            <button 
              class="w-full p-2.5 rounded-xl border text-left transition-all flex flex-col justify-between gap-1.5 {value === 'horde:::auto' ? 'border-selected bg-selected/20 ring-1 ring-selected/70 shadow-xs' : 'border-darkborderc/60 bg-darkbg/30 hover:bg-darkbutton hover:border-textcolor/30'}"
              onclick={() => { selectModel('horde:::auto'); }}
            >
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5 min-w-0">
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-textcolor/10 text-textcolor shrink-0">Horde</span>
                  <span class="font-bold text-sm text-textcolor truncate">Auto Model</span>
                </div>
                <span class="text-[10px] text-textcolor2 shrink-0">Auto Selection</span>
              </div>
              <div class="flex items-center justify-between text-[11px] text-textcolor2/70 pt-1.5 border-t border-darkborderc/30 mt-auto">
                <span class="truncate">Automatic best worker</span>
                {#if value === 'horde:::auto'}
                  <span class="text-textcolor font-bold flex items-center gap-1 text-[10px] shrink-0">
                    <CheckIcon size={11} /> Selected
                  </span>
                {/if}
              </div>
            </button>

            {#each hordeModels as hm}
              <button 
                class="w-full p-2.5 rounded-xl border text-left transition-all flex flex-col justify-between gap-1.5 {value === 'horde:::' + hm.name ? 'border-selected bg-selected/20 ring-1 ring-selected/70 shadow-xs' : 'border-darkborderc/60 bg-darkbg/30 hover:bg-darkbutton hover:border-textcolor/30'}"
                onclick={() => { selectModel('horde:::' + hm.name); }}
              >
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-textcolor/10 text-textcolor shrink-0">Horde</span>
                    <span class="font-bold text-sm text-textcolor truncate">{hm.name}</span>
                  </div>
                </div>
                <div class="flex items-center justify-between text-[10px] text-textcolor2/70 pt-1.5 border-t border-darkborderc/30 mt-auto">
                  <span class="truncate">Workers: {hm.count ?? 1} | Perf: {hm.performance?.toFixed(1) ?? '1.0'}</span>
                  {#if value === 'horde:::' + hm.name}
                    <span class="text-textcolor font-bold flex items-center gap-1 text-[10px] shrink-0">
                      <CheckIcon size={11} /> Selected
                    </span>
                  {/if}
                </div>
              </button>
            {/each}
          </div>
        {/await}
      </div>

    {:else}
      <!-- Regular Models Responsive Multi-Column Grid -->
      {#if blankable}
        <div class="mb-2.5">
          <button 
            class="w-full p-2.5 rounded-xl border border-dashed border-darkborderc hover:border-selected hover:bg-selected/10 transition-all flex items-center justify-between text-left {value === '' ? 'border-selected bg-selected/20' : 'text-textcolor2'}"
            onclick={() => { selectModel(''); }}
          >
            <div class="flex items-center gap-2">
              <span class="font-semibold text-sm text-textcolor">{language.none || "None"}</span>
              <span class="text-xs text-textcolor2">({language.unselect || "Clear selection"})</span>
            </div>
            {#if value === ''}
              <CheckIcon size={15} class="text-textcolor" />
            {/if}
          </button>
        </div>
      {/if}

      {#if displayedModels.length === 0}
        <div class="py-16 flex flex-col items-center justify-center text-center gap-3">
          <div class="p-4 rounded-full bg-darkbutton text-textcolor2">
            <SearchIcon size={28} />
          </div>
          <div>
            <h4 class="font-bold text-base text-textcolor">{language.noModelsFound || "No models found"}</h4>
            <p class="text-xs text-textcolor2 mt-1">
              {#if activeCategory === 'favorites'}
                {language.noFavoriteModelsDesc || "No favorites yet. Star a model to access it quickly!"}
              {:else if activeCategory === 'recent'}
                {language.noRecentModelsDesc || "No recently used models yet."}
              {:else}
                Try adjusting your search query or provider filter.
              {/if}
            </p>
          </div>
        </div>
      {:else}
        <!-- Responsive Multi-Column Layout (1 -> 2 -> 3 -> 4 -> 5 cols on ultra-wide) -->
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 min-[2200px]:grid-cols-5 gap-2.5">
          {#each displayedModels as model}
            {@const isSelected = value === model.id}
            {@const isFav = modelFavoritesStore.isFavorite(model.id)}
            <div 
              class="group w-full p-2.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-2 {isSelected ? 'border-selected bg-selected/20 ring-1 ring-selected/70 shadow-xs' : 'border-darkborderc/60 bg-darkbg/30 hover:bg-darkbutton hover:border-textcolor/30'}"
              role="button"
              tabindex="0"
              onclick={() => { selectModel(model.id); }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectModel(model.id); }}
            >
              <!-- Top Line: Provider Badge + Model Name + Recommended + Favorite -->
              <div class="flex items-start justify-between gap-1.5">
                <div class="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">
                  <span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-textcolor/10 text-textcolor shrink-0">
                    {getProviderDisplayName(model)}
                  </span>
                  <span class="font-bold text-sm text-textcolor line-clamp-2 leading-snug break-words" title={model.fullName || model.name}>
                    {model.fullName || model.name}
                  </span>
                  {#if model.recommended}
                    <span title="Recommended" class="text-textcolor2 shrink-0 inline-flex items-center">
                      <SparkleIcon size={12} />
                    </span>
                  {/if}
                </div>

                <button 
                  class="p-1 rounded text-textcolor2/40 hover:text-textcolor transition-colors shrink-0 -mr-1 -mt-1"
                  onclick={(e) => {
                    e.stopPropagation();
                    modelFavoritesStore.toggleFavorite(model.id);
                  }}
                  title="Toggle Favorite"
                >
                  <StarIcon size={15} class={isFav ? "text-textcolor fill-textcolor" : ""} />
                </button>
              </div>

              <!-- Bottom Line: Model ID + Badges + Selected State -->
              <div class="flex items-center justify-between gap-1.5 text-[10px] pt-1.5 border-t border-darkborderc/30 mt-auto">
                <span class="text-[11px] text-textcolor2/60 font-mono truncate min-w-0" title={model.id}>
                  {model.id}
                </span>

                <div class="flex items-center gap-1 shrink-0 flex-wrap justify-end">
                  {#if hasVision(model)}
                    <span class="px-1.5 py-0.5 rounded bg-textcolor/8 text-textcolor2 flex items-center gap-0.5 text-[9px] leading-tight">
                      <EyeIcon size={10} /> Vision
                    </span>
                  {/if}
                  {#if hasThinking(model)}
                    <span class="px-1.5 py-0.5 rounded bg-textcolor/8 text-textcolor2 flex items-center gap-0.5 text-[9px] leading-tight">
                      <BrainIcon size={10} /> Thinking
                    </span>
                  {/if}
                  {#if hasStreaming(model)}
                    <span class="px-1.5 py-0.5 rounded bg-textcolor/8 text-textcolor2 flex items-center gap-0.5 text-[9px] leading-tight">
                      <ZapIcon size={10} /> Stream
                    </span>
                  {/if}
                  {#if isSelected}
                    <span class="px-1.5 py-0.5 rounded bg-selected text-textcolor font-bold flex items-center gap-1 text-[10px] leading-tight">
                      <CheckIcon size={11} /> Selected
                    </span>
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
