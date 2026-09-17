<script lang="ts">
  import { untrack } from "svelte";
  import {
    ArrowLeft,
    Check,
    MessageSquare,
    Search,
    User,
    X,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
  import {
    filterRisuAgentAttachableCharacters,
    isHydratedRisuAgentCharacter,
  } from "src/ts/agent/risuAgentModel";
  import type { character } from "src/ts/storage/database/schema";

  let {
    onSelect,
    onClose,
    selectedCharacterId = null,
    selectedChatId = null,
  }: {
    onSelect: (characterId: string, chatId?: string) => void;
    onClose: () => void;
    selectedCharacterId?: string | null;
    selectedChatId?: string | null;
  } = $props();

  let search = $state("");
  let pickedCharacterId = $state<string | null>(
    untrack(() => selectedCharacterId) ?? null,
  );
  let loadingChats = $state(false);
  let loadError = $state(false);

  // Only ordinary, non-group characters. Summaries are enough to list names,
  // so nothing is eagerly hydrated here.
  const candidates = $derived(
    filterRisuAgentAttachableCharacters(characterStore.characters, search),
  );

  const pickedCharacter = $derived.by(() => {
    if (!pickedCharacterId) return null;
    const found = characterStore.characters.find(
      (candidate) => candidate?.chaId === pickedCharacterId,
    );
    // A lazy summary is not a fully loaded character. Do not show an empty
    // chat list as if it were the real thing.
    if (!isHydratedRisuAgentCharacter(found)) return null;
    return found as character;
  });

  const pickedChats = $derived(pickedCharacter?.chats ?? []);

  async function pickCharacter(chaId: string) {
    loadingChats = true;
    loadError = false;
    try {
      // Chat list lives on the character details; hydrate only this one.
      await characterStore.ensureCharacterDetails(chaId);
    } finally {
      loadingChats = false;
    }
    // Re-resolve by stable id after the await and verify hydration actually
    // succeeded (ensureCharacterDetails swallows storage errors).
    const found = characterStore.characters.find(
      (candidate) => candidate?.chaId === chaId,
    );
    if (!isHydratedRisuAgentCharacter(found)) {
      pickedCharacterId = null;
      loadError = true;
      return;
    }
    pickedCharacterId = chaId;
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }
</script>

<svelte:window onkeydown={handleEscape} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div
    class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-bgcolor text-textcolor shadow-xl ring-1 ring-textcolor/10"
  >
    <div class="flex items-center gap-2 px-3 pb-1 pt-3">
      {#if pickedCharacter}
        <button
          class="rounded-full p-1.5 text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor"
          onclick={() => (pickedCharacterId = null)}
          aria-label={language.risuAgent.back}
        >
          <ArrowLeft size={18} />
        </button>
        <div class="min-w-0 grow">
          <div class="truncate font-semibold">{pickedCharacter.name}</div>
          <div class="text-xs text-textcolor2">
            {language.risuAgent.chooseChat}
          </div>
        </div>
      {:else}
        <div class="min-w-0 grow px-1">
          <div class="font-semibold">{language.risuAgent.attachContext}</div>
          <div class="text-xs text-textcolor2">
            {language.risuAgent.chooseCharacter}
          </div>
        </div>
      {/if}
      <button
        class="shrink-0 rounded-full p-1.5 text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor"
        onclick={onClose}
        aria-label={language.risuAgent.close}
      >
        <X size={18} />
      </button>
    </div>

    {#if pickedCharacter}
      <div class="min-h-0 grow overflow-y-auto p-1.5">
        <button
          class="mb-1 flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition hover:bg-textcolor/5"
          onclick={() => onSelect(pickedCharacter.chaId, undefined)}
        >
          <User size={16} class="shrink-0 text-textcolor2" />
          <span class="grow text-sm">
            {language.risuAgent.attachWithoutChat}
          </span>
          {#if !selectedChatId && selectedCharacterId === pickedCharacter.chaId}
            <Check size={16} class="shrink-0 text-textcolor" />
          {/if}
        </button>

        {#if loadingChats}
          <div class="px-3 py-4 text-sm text-textcolor2">
            {language.loadingChatData}
          </div>
        {:else if pickedChats.length === 0}
          <div class="px-3 py-4 text-sm text-textcolor2">
            {language.risuAgent.noChats}
          </div>
        {:else}
          {#each pickedChats as chat (chat.id)}
            <button
              class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition hover:bg-textcolor/5"
              onclick={() => {
                if (chat.id) onSelect(pickedCharacter.chaId, chat.id);
              }}
            >
              <MessageSquare size={16} class="shrink-0 text-textcolor2" />
              <span class="grow truncate text-sm">
                {chat.name || language.risuAgent.session}
              </span>
              {#if selectedChatId === chat.id}
                <Check size={16} class="shrink-0 text-textcolor" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {:else}
      <div class="px-3 pb-1 pt-2">
        <div
          class="flex items-center gap-2 rounded-full bg-textcolor/5 px-3.5 py-2 ring-1 ring-transparent transition focus-within:ring-textcolor/25"
        >
          <Search size={16} class="shrink-0 text-textcolor2" />
          <input
            class="w-full bg-transparent text-sm text-textcolor outline-none placeholder:text-textcolor2"
            placeholder={language.risuAgent.searchCharacters}
            bind:value={search}
          />
        </div>
        {#if loadError}
          <div
            class="mt-2 rounded-xl bg-draculared/10 px-3 py-2 text-xs text-textcolor ring-1 ring-draculared/30"
          >
            {language.risuAgent.loadFailed}
          </div>
        {/if}
      </div>
      <div class="min-h-0 grow overflow-y-auto p-1.5">
        {#each candidates as candidate (candidate.chaId)}
          <button
            class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition hover:bg-textcolor/5"
            onclick={() => pickCharacter(candidate.chaId)}
          >
            <div
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-textcolor/10 text-sm font-semibold text-textcolor"
            >
              {(candidate.name || "?").slice(0, 1).toUpperCase()}
            </div>
            <span class="grow truncate text-sm">{candidate.name}</span>
            {#if selectedCharacterId === candidate.chaId}
              <Check size={16} class="shrink-0 text-textcolor" />
            {/if}
          </button>
        {/each}
        {#if candidates.length === 0}
          <div class="px-3 py-4 text-sm text-textcolor2">
            {language.risuAgent.noCharacters}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
