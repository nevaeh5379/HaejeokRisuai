<script lang="ts">
  import { onMount } from "svelte";
  import { Bot, MessageSquarePlus } from "@lucide/svelte";
  import { language } from "src/lang";
  import { activeGenerationChatIds } from "src/ts/process/chatRuntimeState";
  import {
    risuAgentRuntime,
    sortRisuAgentChats,
  } from "src/ts/agent/risuAgentRuntime.svelte";
  import { getRisuAgentCharacter } from "src/ts/agent/risuAgentStore";

  // Reuses the reserved Risu Agent character only; the ordinary bot session
  // list and character avatars are never part of this panel.
  const agentChar = $derived(getRisuAgentCharacter() ?? null);
  const chats = $derived(sortRisuAgentChats(agentChar?.chats));
  const activeChatId = $derived(risuAgentRuntime.activeChatId);
  const busy = $derived(
    risuAgentRuntime.sending ||
      Boolean(
        activeChatId && $activeGenerationChatIds.has(activeChatId),
      ),
  );

  onMount(() => {
    void risuAgentRuntime.ensureInitialized();
  });

  async function selectSession(chatId: string | undefined) {
    if (!chatId) return;
    await risuAgentRuntime.switchTo(chatId);
  }

  async function createSession() {
    await risuAgentRuntime.createNewConversation();
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col">
  <div class="flex items-center gap-2 px-4 pb-2 pt-5">
    <span
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-textcolor/5 text-textcolor2"
    >
      <Bot size={14} />
    </span>
    <span class="truncate text-sm font-semibold">{language.risuAgent.title}</span>
  </div>

  <div class="px-3 pb-2">
    <button
      class="flex w-full items-center gap-2 rounded-xl bg-textcolor/5 px-3 py-2 text-sm text-textcolor transition hover:bg-textcolor/10 disabled:opacity-40"
      onclick={createSession}
      disabled={busy}
    >
      <MessageSquarePlus size={15} class="shrink-0" />
      <span class="truncate">{language.risuAgent.newConversation}</span>
    </button>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
    {#if risuAgentRuntime.loading}
      <div class="px-2 py-3 text-xs text-textcolor2">
        {language.risuAgent.loading}
      </div>
    {/if}
    {#each chats as chat (chat.id)}
      <button
        class="flex w-full items-center rounded-xl px-3 py-2 text-start text-sm transition hover:bg-textcolor/5 disabled:opacity-40 {chat.id ===
        activeChatId
          ? 'bg-textcolor/10 font-medium text-textcolor'
          : 'text-textcolor2'}"
        onclick={() => selectSession(chat.id)}
        disabled={busy}
        aria-current={chat.id === activeChatId ? "true" : undefined}
      >
        <span class="truncate">{chat.name || language.risuAgent.session}</span>
      </button>
    {/each}
  </div>
</div>
