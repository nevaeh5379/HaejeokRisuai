<script lang="ts">
  import {
    SettingsIcon,
    GlobeIcon,
    HouseIcon,
    Volume2Icon,
    Braces,
    ActivityIcon,
    BookIcon,
    SmileIcon,
    UserIcon,
    UsersIcon,
    SlidersHorizontal,
    HistoryIcon
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import { characterStore } from "src/ts/stores/domain";
  import {
    CharConfigSubMenu,
    MobileGUIStack,
    MobileSideBar,
    selectedCharID
  } from "src/ts/stores.svelte";

  let currentChar = $derived(characterStore.characters[$selectedCharID]);
  let isGroup = $derived(currentChar?.type === 'group');
</script>

<!-- ================= 1. HOME SCREEN BOTTOM NAVIGATION (3 TABS) ================= -->
{#if $selectedCharID === -1}
  <nav class="w-full px-4 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] border-t border-t-darkborderc bg-darkbg/95 backdrop-blur-md flex items-center justify-around text-textcolor2 shrink-0 z-30 select-none shadow-xs">
    <!-- Tab 0: RisuRealm -->
    <button
      class="flex-1 flex justify-center items-center flex-col gap-1 py-1.5 px-3 rounded-2xl transition-all cursor-pointer {$MobileGUIStack === 0 ? 'text-selected font-bold bg-selected/10' : 'text-textcolor2 hover:text-textcolor'}"
      onclick={() => { MobileGUIStack.set(0); }}
      aria-label="RisuRealm tab"
    >
      <GlobeIcon size={22} />
      <span class="text-[11px] leading-tight">RisuRealm</span>
    </button>

    <!-- Tab 1: Characters (Home) -->
    <button
      class="flex-1 flex justify-center items-center flex-col gap-1 py-1.5 px-3 rounded-2xl transition-all cursor-pointer {$MobileGUIStack === 1 ? 'text-selected font-bold bg-selected/10' : 'text-textcolor2 hover:text-textcolor'}"
      onclick={() => { MobileGUIStack.set(1); }}
      aria-label="Characters tab"
    >
      <HouseIcon size={22} />
      <span class="text-[11px] leading-tight">{language.character || "Characters"}</span>
    </button>

    <!-- Tab 2: Settings -->
    <button
      class="flex-1 flex justify-center items-center flex-col gap-1 py-1.5 px-3 rounded-2xl transition-all cursor-pointer {$MobileGUIStack === 2 ? 'text-selected font-bold bg-selected/10' : 'text-textcolor2 hover:text-textcolor'}"
      onclick={() => { MobileGUIStack.set(2); }}
      aria-label="Settings tab"
    >
      <SettingsIcon size={22} />
      <span class="text-[11px] leading-tight">{language.settings || "Settings"}</span>
    </button>
  </nav>
{/if}

<!-- ================= 2. CHARACTER CONFIGURATION BOTTOM BAR ($MobileSideBar === 2) ================= -->
{#if $selectedCharID !== -1 && $MobileSideBar === 2}
  <nav class="w-full px-2 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] border-t border-t-darkborderc bg-darkbg/95 backdrop-blur-md flex items-center justify-around text-textcolor2 shrink-0 z-30 select-none">
    <!-- Submenu 0: Basic Info -->
    <button
      class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 0 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
      onclick={() => { CharConfigSubMenu.set(0); }}
      title={language.basicInfo || "Basic"}
      aria-label={language.basicInfo || "Basic"}
    >
      <UserIcon size={22} />
    </button>

    <!-- Submenu 1: Display / Icon -->
    <button
      class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 1 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
      onclick={() => { CharConfigSubMenu.set(1); }}
      title={language.characterDisplay || "Display"}
      aria-label={language.characterDisplay || "Display"}
    >
      {#if isGroup}
        <UsersIcon size={22} />
      {:else}
        <SmileIcon size={22} />
      {/if}
    </button>

    <!-- Submenu 3: LoreBook -->
    <button
      class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 3 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
      onclick={() => { CharConfigSubMenu.set(3); }}
      title={language.loreBook || "LoreBook"}
      aria-label={language.loreBook || "LoreBook"}
    >
      <BookIcon size={22} />
    </button>

    <!-- Submenu 5: TTS (Individual Characters only) -->
    {#if !isGroup}
      <button
        class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 5 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
        onclick={() => { CharConfigSubMenu.set(5); }}
        title="TTS"
        aria-label="TTS"
      >
        <Volume2Icon size={22} />
      </button>

      <!-- Submenu 4: Scripts (Individual Characters only) -->
      <button
        class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 4 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
        onclick={() => { CharConfigSubMenu.set(4); }}
        title={language.scripts || "Scripts"}
        aria-label={language.scripts || "Scripts"}
      >
        <Braces size={22} />
      </button>

      <!-- Submenu 7: Character snapshots -->
      <button
        class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 7 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
        onclick={() => { CharConfigSubMenu.set(7); }}
        title={language.characterSnapshots.title}
        aria-label={language.characterSnapshots.title}
      >
        <HistoryIcon size={22} />
      </button>
    {/if}

    <!-- Submenu 2: Advanced -->
    <button
      class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 2 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
      onclick={() => { CharConfigSubMenu.set(2); }}
      title={language.advanced || "Advanced"}
      aria-label={language.advanced || "Advanced"}
    >
      <ActivityIcon size={22} />
    </button>

    <!-- Submenu 6: Manage / Export / Delete -->
    <button
      class="flex justify-center items-center p-2.5 rounded-2xl transition-all cursor-pointer {$CharConfigSubMenu === 6 ? 'text-selected bg-selected/20 font-bold scale-105' : 'text-textcolor2 hover:text-textcolor hover:bg-darkbutton'}"
      onclick={() => { CharConfigSubMenu.set(6); }}
      title={language.shareExport || "Manage"}
      aria-label={language.shareExport || "Manage"}
    >
      <SlidersHorizontal size={22} />
    </button>
  </nav>
{/if}