<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    ArrowLeft,
    Bot,
    ChevronDown,
    Cpu,
    History,
    MessageSquarePlus,
    Paperclip,
    RefreshCw,
    Send,
    SlidersHorizontal,
    Square,
    User,
    X,
  } from "@lucide/svelte";
  import { language } from "src/lang";
  import { PlaygroundStore, openPresetList } from "src/ts/stores.svelte";
  import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
  import { compactChatMessages } from "src/ts/stores/domain/messageStore.svelte";
  import { activeGenerationChatIds } from "src/ts/process/chatRuntimeState";
  import { getGenerationModelString } from "src/ts/process/models/modelString";
  import { parseMarkdownSafe } from "src/ts/parser/parser.svelte";
  import { alertError } from "src/ts/alert";
  import { RISU_AGENT_CHARACTER_ID } from "src/ts/systemCharacters";
  import {
    appendRisuAgentUserMessage,
    getRisuAgentCharacter,
    registerRisuAgentSessionScope,
    removeLastRisuAgentReply,
    restoreRisuAgentReply,
    setRisuAgentSessionContext,
    type RemovedRisuAgentReply,
  } from "src/ts/agent/risuAgentStore";
  import {
    risuAgentRuntime,
    sortRisuAgentChats,
  } from "src/ts/agent/risuAgentRuntime.svelte";
  import {
    canMutateRisuAgentSession,
    resolveRisuAgentSessionContext,
    type RisuAgentChatContext,
  } from "src/ts/agent/risuAgentModel";
  import {
    buildRisuAgentGenerationOverrides,
    isRisuAgentPromptEnabled,
  } from "src/ts/agent/risuAgentPrompt";
  import type { character, Chat, Message } from "src/ts/storage/database/schema";
  import LazyComponent from "../Others/LazyComponent.svelte";

  let input = $state("");
  let showSessions = $state(false);
  let showContextPicker = $state(false);
  let showPromptEditor = $state(false);
  let inputEl = $state<HTMLTextAreaElement | null>(null);
  let messagesEl = $state<HTMLDivElement | null>(null);
  let abortController: AbortController | null = null;

  // Shared with the dedicated sidebar so both surfaces always agree on the
  // active session and on whether generation is in flight.
  const activeChatId = $derived(risuAgentRuntime.activeChatId);
  const loading = $derived(risuAgentRuntime.loading);
  const errorText = $derived(risuAgentRuntime.errorText);

  const agentChar = $derived(getRisuAgentCharacter() ?? null);

  const activeChat = $derived.by((): Chat | null => {
    if (!agentChar || !activeChatId) return null;
    return (
      (agentChar.chats ?? []).find((chat) => chat.id === activeChatId) ?? null
    );
  });

  const messages = $derived(activeChat?.message ?? ([] as Message[]));

  const agentChats = $derived(sortRisuAgentChats(agentChar?.chats));

  // Header shows the current conversation instead of permanent branding.
  const activeChatTitle = $derived(
    activeChat?.name?.trim() || language.risuAgent.session,
  );

  const isGenerating = $derived(
    Boolean(activeChatId && $activeGenerationChatIds.has(activeChatId)),
  );
  const busy = $derived(risuAgentRuntime.sending || isGenerating);

  const activeContext = $derived(resolveRisuAgentSessionContext(activeChat));

  const scopeCharacter = $derived.by(() => {
    const context = activeContext;
    if (!context) return null;
    const found = characterStore.characters.find(
      (candidate) => candidate?.chaId === context.characterId,
    );
    if (!found || found.type === "group") return null;
    return found as character;
  });

  const scopeChat = $derived.by(() => {
    const context = activeContext;
    if (!context?.chatId || !scopeCharacter) return null;
    return (
      (scopeCharacter.chats ?? []).find(
        (chat) => chat.id === context.chatId,
      ) ?? null
    );
  });

  const modelName = $derived(getGenerationModelString());

  const promptEnabled = $derived(
    isRisuAgentPromptEnabled(agentChar?.agentPrompt),
  );

  function stripToolCalls(text: string): string {
    return text.replace(/<tool_call>[\s\S]*?<\/tool_call>\s*/gi, "").trim();
  }

  function renderAssistant(data: string): string {
    return parseMarkdownSafe(stripToolCalls(data ?? ""));
  }

  function scrollToBottom() {
    if (!messagesEl) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === "Escape" && showSessions) {
      showSessions = false;
    }
  }

  function openContextPicker() {
    if (!canMutateRisuAgentSession(busy)) return;
    showContextPicker = true;
  }

  async function attachContext(characterId: string, chatId?: string) {
    if (!agentChar || !activeChatId) return;
    if (!canMutateRisuAgentSession(busy)) return;
    const context: RisuAgentChatContext = chatId
      ? { characterId, chatId }
      : { characterId };
    await setRisuAgentSessionContext(agentChar, activeChatId, context);
  }

  async function detachContext() {
    if (!agentChar || !activeChatId) return;
    if (!canMutateRisuAgentSession(busy)) return;
    await setRisuAgentSessionContext(agentChar, activeChatId, null);
  }

  async function switchSession(chatId: string) {
    showSessions = false;
    await risuAgentRuntime.switchTo(chatId);
    await tick();
    scrollToBottom();
  }

  async function newConversation() {
    showSessions = false;
    await risuAgentRuntime.createNewConversation();
    await tick();
    scrollToBottom();
  }

  async function resolveChatAfterAwait(
    chatId: string,
  ): Promise<Chat | undefined> {
    const character = agentChar;
    if (!character) return undefined;
    return (character.chats ?? []).find((chat) => chat.id === chatId);
  }

  async function runGeneration(options: {
    userText?: string;
    regenerate?: boolean;
  }) {
    const characterId = RISU_AGENT_CHARACTER_ID;
    const chatId = activeChatId;
    if (!chatId || busy) return;

    risuAgentRuntime.sending = true;
    risuAgentRuntime.errorText = null;
    // Captured only for regenerate: rolled back if generation does not
    // succeed, so a failed retry never destroys the prior answer.
    let removedReply: RemovedRisuAgentReply | null = null;
    let generationSucceeded = false;
    const controller = new AbortController();
    abortController = controller;
    try {
      await characterStore.ensureChatMessages(chatId, { full: true });
      const chat = await resolveChatAfterAwait(chatId);
      if (!chat) return;

      if (options.regenerate) {
        removedReply = await removeLastRisuAgentReply(chat);
        if (!removedReply) return;
      }

      if (options.userText) {
        await appendRisuAgentUserMessage(chat, options.userText);
        const defaultName = /^Conversation \d+$/.test(chat.name ?? "");
        if (defaultName && chat.id) {
          const title = options.userText.replace(/\s+/g, " ").trim();
          chat.name =
            title.length > 40 ? `${title.slice(0, 40)}…` : title || chat.name;
          characterStore.markChatDirty(chat.id);
          characterStore.markChatManifestDirty(characterId);
        }
      }

      // Keep the request scope stable: re-register this session's persisted
      // context without touching any other session.
      registerRisuAgentSessionScope(chat);
      const { sendChat } = await import("src/ts/process/index.svelte");
      // Request-local prompt overrides: cloned here so a concurrent ordinary
      // chat keeps reading presetStore untouched.
      const generation = buildRisuAgentGenerationOverrides(
        getRisuAgentCharacter()?.agentPrompt,
      );
      const ok = await sendChat(-1, {
        signal: controller.signal,
        targetCharacterId: characterId,
        targetChatId: chatId,
        generation,
      });
      generationSucceeded = ok && !controller.signal.aborted;
      if (!ok && !controller.signal.aborted) {
        risuAgentRuntime.errorText = language.risuAgent.sendFailed;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        risuAgentRuntime.errorText = message;
        alertError(message);
      }
    } finally {
      if (removedReply && !generationSucceeded) {
        const freshChat = await resolveChatAfterAwait(chatId);
        if (freshChat) await restoreRisuAgentReply(freshChat, removedReply);
      }
      abortController = null;
      risuAgentRuntime.sending = false;
      const finishedChatId = chatId;
      if (finishedChatId) compactChatMessages(finishedChatId);
      await tick();
      scrollToBottom();
      void inputEl?.focus();
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    input = "";
    await runGeneration({ userText: text });
  }

  async function regenerate() {
    if (busy) return;
    await runGeneration({ regenerate: true });
  }

  async function stop() {
    const controller = abortController;
    if (controller) controller.abort();
    if (activeChatId) {
      try {
        const { cancelNodeChatGeneration } = await import(
          "src/ts/process/nodeRealtimeSync"
        );
        await cancelNodeChatGeneration(activeChatId);
      } catch {
        // Local abort already handled the common path.
      }
    }
  }

  function handleComposerKey(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void send();
  }

  function autoResize() {
    if (!inputEl) return;
    inputEl.style.height = "0px";
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
  }

  onMount(() => {
    // Shared with the sidebar, so a concurrent mount still creates one session.
    void risuAgentRuntime.ensureInitialized();

    return () => {
      abortController?.abort();
      // Deliberately do not clear the scope registry here: an in-flight
      // generation (or another mounted surface) may still need its own scope.
    };
  });

  $effect(() => {
    void messages.length;
    void messages[messages.length - 1]?.data?.length;
    queueMicrotask(scrollToBottom);
  });

  $effect(() => {
    void input;
    tick().then(autoResize);
  });
</script>

<svelte:window onkeydown={handleEscape} />

<div class="relative flex h-full min-h-0 w-full flex-col bg-bgcolor text-textcolor">
  <!-- Compact header: back, current conversation, then quiet controls.
       Desktop session switching lives in the dedicated app sidebar. -->
  <header class="flex shrink-0 items-center gap-1 px-2 py-2 md:px-3">
    <button
      class="shrink-0 rounded-full p-2 text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor"
      onclick={() => PlaygroundStore.set(1)}
      aria-label={language.risuAgent.back}
    >
      <ArrowLeft size={18} />
    </button>

    <!-- Desktop: non-interactive current-conversation label -->
    <div
      class="hidden min-w-0 items-center gap-1.5 px-2.5 py-1.5 text-sm text-textcolor2 lg:flex"
    >
      <History size={15} class="shrink-0" />
      <span class="truncate">{activeChatTitle}</span>
    </div>

    <!-- Mobile: history control + contained sheet -->
    <div class="relative min-w-0 lg:hidden">
      <button
        class="flex min-w-0 max-w-[55vw] items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor"
        onclick={() => (showSessions = !showSessions)}
        aria-label={language.risuAgent.conversations}
        aria-expanded={showSessions}
      >
        <History size={15} class="shrink-0" />
        <span class="truncate">{activeChatTitle}</span>
        <ChevronDown
          size={14}
          class="shrink-0 transition {showSessions ? 'rotate-180' : ''}"
        />
      </button>
    </div>

    <div class="grow"></div>

    <!-- Agent prompt template/settings -->
    <button
      class="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition hover:bg-textcolor/5 {promptEnabled
        ? 'text-textcolor'
        : 'text-textcolor2 hover:text-textcolor'} disabled:opacity-40"
      onclick={() => (showPromptEditor = true)}
      disabled={busy}
      title={language.risuAgent.promptSettings}
      aria-label={language.risuAgent.promptSettings}
    >
      <SlidersHorizontal size={14} class="shrink-0" />
    </button>

    <!-- Model -->
    <button
      class="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor"
      onclick={() => openPresetList.set(true)}
      title={language.risuAgent.changeModel}
      aria-label={language.risuAgent.changeModel}
    >
      <Cpu size={14} class="shrink-0" />
      <span class="hidden max-w-[10rem] truncate sm:inline">{modelName}</span>
    </button>

    <!-- Context -->
    {#if scopeCharacter}
      <span
        class="flex min-w-0 max-w-[45vw] items-center gap-1.5 rounded-full bg-textcolor/5 px-2.5 py-1.5 text-xs sm:max-w-xs"
      >
        <User size={13} class="shrink-0 text-textcolor2" />
        <span class="truncate">{scopeCharacter.name}</span>
        {#if scopeChat}
          <span class="truncate text-textcolor2">
            · {scopeChat.name || language.risuAgent.session}
          </span>
        {/if}
        <button
          class="ml-0.5 shrink-0 rounded-full p-0.5 text-textcolor2 transition hover:text-draculared disabled:opacity-40"
          onclick={detachContext}
          disabled={busy}
          aria-label={language.risuAgent.detachContext}
        >
          <X size={13} />
        </button>
      </span>
    {:else}
      <button
        class="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor disabled:opacity-40"
        onclick={openContextPicker}
        disabled={busy}
        aria-label={language.risuAgent.attachContext}
      >
        <Paperclip size={13} class="shrink-0" />
        <span class="hidden sm:inline">{language.risuAgent.attachContext}</span>
      </button>
    {/if}
  </header>

  <!-- Mobile-only conversation history sheet: height-bounded, never a rail. -->
  {#if showSessions}
    <div
      class="absolute inset-0 z-30 bg-black/40 lg:hidden"
      role="presentation"
      onclick={() => (showSessions = false)}
    ></div>
    <div
      class="absolute left-2 top-14 z-40 flex w-[min(24rem,calc(100%_-_1rem))] flex-col overflow-hidden rounded-2xl bg-darkbg shadow-lg lg:hidden"
    >
      <div
        class="px-3 pb-1 pt-2.5 text-[11px] font-semibold uppercase tracking-wide text-textcolor2"
      >
        {language.risuAgent.conversations}
      </div>
      <div class="max-h-[min(60vh,20rem)] overflow-y-auto p-1.5">
        {#each agentChats as chat (chat.id)}
          <button
            class="flex w-full items-center rounded-xl px-3 py-2 text-start text-sm transition hover:bg-textcolor/5 disabled:opacity-40 {chat.id ===
            activeChatId
              ? 'bg-textcolor/10 font-medium text-textcolor'
              : 'text-textcolor2'}"
            onclick={() => chat.id && switchSession(chat.id)}
            disabled={busy}
            aria-current={chat.id === activeChatId ? "true" : undefined}
          >
            <span class="truncate">
              {chat.name || language.risuAgent.session}
            </span>
          </button>
        {/each}
      </div>
      <div class="p-1.5 pt-0">
        <button
          class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor disabled:opacity-40"
          onclick={newConversation}
          disabled={busy}
        >
          <MessageSquarePlus size={15} class="shrink-0" />
          {language.risuAgent.newConversation}
        </button>
      </div>
    </div>
  {/if}

  <!-- Conversation canvas: single centered column at every breakpoint -->
  <div
    bind:this={messagesEl}
    class="min-h-0 grow overflow-y-auto px-4 pb-4 pt-4 md:px-6 md:pt-8"
  >
    <div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
      {#if loading}
        <div class="py-16 text-center text-sm text-textcolor2">
          {language.risuAgent.loading}
        </div>
      {:else if messages.length === 0}
        <div class="py-14 text-center">
          <div
            class="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-textcolor/5"
          >
            <Bot size={22} class="text-textcolor2" />
          </div>
          <div class="text-lg font-semibold">
            {language.risuAgent.emptyTitle}
          </div>
          <div class="mx-auto mt-1 max-w-md text-sm text-textcolor2">
            {language.risuAgent.emptyBody}
          </div>
        </div>
      {/if}

      {#each messages as message, index (message.chatId ?? index)}
        {#if message.role === "user"}
          <div class="flex justify-end">
            <div
              class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-textcolor/10 px-4 py-2.5 text-sm leading-relaxed"
            >
              {message.data}
            </div>
          </div>
        {:else if !stripToolCalls(message.data ?? "") && index === messages.length - 1 && busy}
          <div class="flex items-center gap-2 text-textcolor2">
            <span
              class="flex h-7 w-7 items-center justify-center rounded-full bg-textcolor/5"
            >
              <Bot size={15} />
            </span>
            <span class="flex gap-1">
              <span
                class="h-1.5 w-1.5 animate-bounce rounded-full bg-textcolor2 [animation-delay:0ms]"
              ></span>
              <span
                class="h-1.5 w-1.5 animate-bounce rounded-full bg-textcolor2 [animation-delay:150ms]"
              ></span>
              <span
                class="h-1.5 w-1.5 animate-bounce rounded-full bg-textcolor2 [animation-delay:300ms]"
              ></span>
            </span>
          </div>
        {:else}
          <div class="flex gap-2.5">
            <span
              class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-textcolor/5 text-textcolor2"
            >
              <Bot size={15} />
            </span>
            <div
              class="chattext prose prose-sm min-w-0 max-w-none break-words text-sm leading-relaxed text-textcolor"
            >
              {@html renderAssistant(message.data)}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  </div>

  <!-- Floating composer surface -->
  <div class="shrink-0 px-3 pb-3 md:px-6 md:pb-5">
    <div class="mx-auto w-full max-w-3xl">
      {#if errorText}
        <div
          class="mb-2 rounded-xl bg-draculared/10 px-3 py-2 text-xs text-textcolor ring-1 ring-draculared/30"
        >
          {errorText}
        </div>
      {/if}

      <div
        class="flex items-end gap-1.5 rounded-3xl bg-textcolor/5 px-2.5 py-2 shadow-md ring-1 ring-transparent transition focus-within:ring-textcolor/25"
      >
        <textarea
          bind:this={inputEl}
          bind:value={input}
          onkeydown={handleComposerKey}
          rows="1"
          placeholder={language.risuAgent.inputPlaceholder}
          class="max-h-[200px] min-h-[22px] w-full resize-none bg-transparent px-1.5 py-1.5 text-sm leading-relaxed text-textcolor outline-none placeholder:text-textcolor2"
        ></textarea>
        {#if busy}
          <button
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-draculared text-white transition hover:opacity-90"
            onclick={stop}
            aria-label={language.risuAgent.stop}
          >
            <Square size={14} />
          </button>
        {:else}
          <button
            class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-textcolor text-bgcolor transition hover:opacity-90 disabled:opacity-30"
            onclick={send}
            disabled={!input.trim()}
            aria-label={language.risuAgent.send}
          >
            <Send size={14} />
          </button>
        {/if}
      </div>

      <div class="mt-1.5 flex items-center justify-between gap-2 px-2">
        <span class="truncate text-[11px] text-textcolor2">
          {scopeCharacter
            ? language.risuAgent.contextAttached
            : language.risuAgent.noContext}
        </span>
        {#if !busy && messages[messages.length - 1]?.role === "char"}
          <button
            class="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-textcolor2 transition hover:text-textcolor"
            onclick={regenerate}
          >
            <RefreshCw size={12} />
            {language.risuAgent.regenerate}
          </button>
        {/if}
      </div>
    </div>
  </div>
</div>

{#if showPromptEditor && agentChar}
  <LazyComponent
    loader={() => import("./RisuAgentPromptModal.svelte")}
    props={{
      agentCharacter: agentChar,
      onClose: () => (showPromptEditor = false),
    }}
  />
{/if}

{#if showContextPicker}
  <LazyComponent
    loader={() => import("./RisuAgentContextPicker.svelte")}
    props={{
      selectedCharacterId: activeContext?.characterId ?? null,
      selectedChatId: activeContext?.chatId ?? null,
      onSelect: (characterId: string, chatId?: string) => {
        showContextPicker = false;
        void attachContext(characterId, chatId);
      },
      onClose: () => (showContextPicker = false),
    }}
  />
{/if}
