<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    ArrowLeft,
    Bot,
    ChevronDown,
    Cpu,
    MessageSquarePlus,
    Paperclip,
    RefreshCw,
    Send,
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
    createRisuAgentSession,
    ensureRisuAgentCharacter,
    registerRisuAgentSessionScope,
    removeLastRisuAgentReply,
    resolveRisuAgentSession,
    selectRisuAgentSession,
    setRisuAgentSessionContext,
  } from "src/ts/agent/risuAgentStore";
  import {
    canMutateRisuAgentSession,
    resolveRisuAgentSessionContext,
    type RisuAgentChatContext,
  } from "src/ts/agent/risuAgentModel";
  import type { character, Chat, Message } from "src/ts/storage/database/schema";
  import LazyComponent from "../Others/LazyComponent.svelte";

  let loading = $state(true);
  let sending = $state(false);
  let errorText = $state<string | null>(null);
  let input = $state("");
  let activeChatId = $state<string | null>(null);
  let showSessions = $state(false);
  let showContextPicker = $state(false);
  let inputEl = $state<HTMLTextAreaElement | null>(null);
  let messagesEl = $state<HTMLDivElement | null>(null);
  let abortController: AbortController | null = null;

  const agentChar = $derived.by((): character | null => {
    const found = characterStore.characters.find(
      (candidate) => candidate?.chaId === RISU_AGENT_CHARACTER_ID,
    );
    if (!found || found.type === "group") return null;
    return found as character;
  });

  const activeChat = $derived.by((): Chat | null => {
    if (!agentChar || !activeChatId) return null;
    return (agentChar.chats ?? []).find((chat) => chat.id === activeChatId) ?? null;
  });

  const messages = $derived(activeChat?.message ?? ([] as Message[]));

  const agentChats = $derived.by(() => {
    const chats = [...(agentChar?.chats ?? [])];
    chats.sort((a, b) => (b.lastDate ?? 0) - (a.lastDate ?? 0));
    return chats;
  });

  const isGenerating = $derived(
    Boolean(activeChatId && $activeGenerationChatIds.has(activeChatId)),
  );
  const busy = $derived(sending || isGenerating);

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

  async function loadChat(chatId: string | null | undefined) {
    if (!chatId) return;
    // Loads only the recent page; the standard pipeline pulls full history
    // when a generation actually starts.
    await characterStore.ensureChatMessages(chatId);
  }

  async function switchSession(chatId: string) {
    if (!agentChar || !chatId || chatId === activeChatId) {
      showSessions = false;
      return;
    }
    // Session switching is disabled while generating so the in-flight request
    // keeps the scope it started with.
    if (!canMutateRisuAgentSession(busy)) return;
    activeChatId = chatId;
    selectRisuAgentSession(agentChar, chatId);
    showSessions = false;
    await loadChat(chatId);
    const chat = await resolveChatAfterAwait(chatId);
    if (chat) registerRisuAgentSessionScope(chat);
    await tick();
    scrollToBottom();
  }

  async function newConversation() {
    if (!agentChar || !canMutateRisuAgentSession(busy)) return;
    const created = await createRisuAgentSession(agentChar);
    const createdId = created.id ?? null;
    if (!createdId) return;
    activeChatId = createdId;
    selectRisuAgentSession(agentChar, createdId);
    showSessions = false;
    await loadChat(createdId);
    const chat = await resolveChatAfterAwait(createdId);
    if (chat) registerRisuAgentSessionScope(chat);
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

    sending = true;
    errorText = null;
    const controller = new AbortController();
    abortController = controller;
    try {
      await characterStore.ensureChatMessages(chatId, { full: true });
      const chat = await resolveChatAfterAwait(chatId);
      if (!chat) return;

      if (options.regenerate) {
        const removed = await removeLastRisuAgentReply(chat);
        if (!removed) return;
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
      const ok = await sendChat(-1, {
        signal: controller.signal,
        targetCharacterId: characterId,
        targetChatId: chatId,
      });
      if (!ok && !controller.signal.aborted) {
        errorText = language.risuAgent.sendFailed;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        errorText = message;
        alertError(message);
      }
    } finally {
      abortController = null;
      sending = false;
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
    let disposed = false;
    void (async () => {
      try {
        const { character } = await ensureRisuAgentCharacter();
        if (disposed) return;
        const existing = resolveRisuAgentSession(character, activeChatId);
        let chatId = existing?.id ?? null;
        if (!chatId) {
          const created = await createRisuAgentSession(character);
          chatId = created.id ?? null;
        }
        if (disposed) return;
        activeChatId = chatId;
        if (chatId) {
          selectRisuAgentSession(character, chatId);
          await loadChat(chatId);
          const chat = await resolveChatAfterAwait(chatId);
          if (chat) registerRisuAgentSessionScope(chat);
        }
      } catch (error) {
        if (!disposed) {
          errorText = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (!disposed) loading = false;
      }
    })();

    return () => {
      disposed = true;
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

<div class="flex h-full min-h-0 w-full flex-col bg-bgcolor text-textcolor">
  <!-- Header -->
  <header
    class="flex flex-wrap items-center gap-2 border-b border-borderc px-3 py-2 md:px-4"
  >
    <button
      class="rounded-lg p-2 text-textcolor2 transition hover:bg-darkbutton hover:text-textcolor"
      onclick={() => PlaygroundStore.set(1)}
      aria-label={language.risuAgent.back}
    >
      <ArrowLeft size={18} />
    </button>
    <button
      class="flex items-center gap-2 rounded-lg p-2 text-textcolor2 transition hover:bg-darkbutton hover:text-textcolor lg:hidden"
      onclick={() => (showSessions = !showSessions)}
      aria-label={language.risuAgent.conversations}
    >
      <ChevronDown size={18} />
    </button>

    <div class="flex min-w-0 items-center gap-2">
      <div
        class="flex h-8 w-8 items-center justify-center rounded-full bg-selected"
      >
        <Bot size={18} />
      </div>
      <div class="min-w-0">
        <div class="truncate text-sm font-semibold">
          {language.risuAgent.title}
        </div>
        <div class="truncate text-[11px] text-textcolor2">
          {language.risuAgent.subtitle}
        </div>
      </div>
    </div>

    <div class="grow"></div>

    <!-- Model chip -->
    <button
      class="flex max-w-[45vw] items-center gap-1.5 rounded-full border border-borderc bg-darkbg px-3 py-1 text-xs text-textcolor2 transition hover:text-textcolor"
      onclick={() => openPresetList.set(true)}
      title={language.risuAgent.changeModel}
    >
      <Cpu size={13} />
      <span class="truncate">{modelName}</span>
    </button>

    <!-- Context chip -->
    {#if scopeCharacter}
      <span
        class="flex max-w-[60vw] items-center gap-1.5 rounded-full border border-borderc bg-darkbg px-3 py-1 text-xs"
      >
        <User size={13} class="shrink-0 text-textcolor2" />
        <span class="truncate">{scopeCharacter.name}</span>
        {#if scopeChat}
          <span class="truncate text-textcolor2">
            · {scopeChat.name || language.risuAgent.session}
          </span>
        {/if}
        <button
          class="ml-0.5 shrink-0 text-textcolor2 transition hover:text-draculared disabled:opacity-40"
          onclick={detachContext}
          disabled={busy}
          aria-label={language.risuAgent.detachContext}
        >
          <X size={13} />
        </button>
      </span>
    {:else}
      <button
        class="flex items-center gap-1.5 rounded-full border border-dashed border-borderc px-3 py-1 text-xs text-textcolor2 transition hover:border-textcolor2 hover:text-textcolor disabled:opacity-40"
        onclick={openContextPicker}
        disabled={busy}
      >
        <Paperclip size={13} />
        {language.risuAgent.attachContext}
      </button>
    {/if}
  </header>

  <div class="relative flex min-h-0 grow">
    <!-- Session rail (desktop) -->
    <aside
      class="hidden w-64 shrink-0 flex-col border-r border-borderc lg:flex"
    >
      <div class="p-3">
        <button
          class="flex w-full items-center justify-center gap-2 rounded-xl border border-borderc bg-darkbg px-3 py-2 text-sm transition hover:bg-darkbutton"
          onclick={newConversation}
          disabled={busy}
        >
          <MessageSquarePlus size={16} />
          {language.risuAgent.newConversation}
        </button>
      </div>
      <div class="min-h-0 grow overflow-y-auto px-2 pb-3">
        {#each agentChats as chat (chat.id)}
          <button
            class="mb-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-start text-sm transition hover:bg-darkbutton disabled:opacity-40 {chat.id ===
            activeChatId
              ? 'bg-selected'
              : ''}"
            onclick={() => chat.id && switchSession(chat.id)}
            disabled={busy}
          >
            <span class="truncate">
              {chat.name || language.risuAgent.session}
            </span>
          </button>
        {/each}
      </div>
    </aside>

    <!-- Session drawer (narrow) -->
    {#if showSessions}
      <div
        class="absolute inset-0 z-30 bg-black/40 lg:hidden"
        role="presentation"
        onclick={() => (showSessions = false)}
      >
        <div
          class="h-full w-72 max-w-[80%] overflow-y-auto border-r border-borderc bg-bgcolor p-3"
          role="presentation"
          onclick={(event) => event.stopPropagation()}
        >
          <button
            class="mb-2 flex w-full items-center justify-center gap-2 rounded-xl border border-borderc bg-darkbg px-3 py-2 text-sm transition hover:bg-darkbutton"
            onclick={newConversation}
            disabled={busy}
          >
            <MessageSquarePlus size={16} />
            {language.risuAgent.newConversation}
          </button>
          {#each agentChats as chat (chat.id)}
            <button
              class="mb-1 flex w-full items-center rounded-lg px-3 py-2 text-start text-sm transition hover:bg-darkbutton disabled:opacity-40 {chat.id ===
              activeChatId
                ? 'bg-selected'
                : ''}"
              onclick={() => chat.id && switchSession(chat.id)}
              disabled={busy}
            >
              <span class="truncate">
                {chat.name || language.risuAgent.session}
              </span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Conversation -->
    <div class="flex min-h-0 min-w-0 grow flex-col">
      <div
        bind:this={messagesEl}
        class="min-h-0 grow overflow-y-auto px-3 py-4 md:px-6"
      >
        <div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {#if loading}
            <div class="py-16 text-center text-sm text-textcolor2">
              {language.risuAgent.loading}
            </div>
          {:else if messages.length === 0}
            <div class="py-16 text-center">
              <div
                class="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-selected"
              >
                <Bot size={24} />
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
                  class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-selected px-4 py-2.5 text-sm leading-relaxed"
                >
                  {message.data}
                </div>
              </div>
            {:else if !stripToolCalls(message.data ?? "") && index === messages.length - 1 && busy}
              <div class="flex items-center gap-2 text-textcolor2">
                <span
                  class="flex h-7 w-7 items-center justify-center rounded-full bg-darkbg"
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
              <div class="flex gap-2">
                <span
                  class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-darkbg"
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

      {#if errorText}
        <div
          class="mx-auto mb-2 w-full max-w-3xl rounded-lg border border-draculared/40 bg-draculared/10 px-3 py-2 text-xs text-textcolor"
        >
          {errorText}
        </div>
      {/if}

      <!-- Composer -->
      <div class="border-t border-borderc px-3 pb-3 pt-2 md:px-6 md:pb-4">
        <div class="mx-auto w-full max-w-3xl">
          <div
            class="flex items-end gap-2 rounded-2xl border border-borderc bg-darkbg px-3 py-2"
          >
            <textarea
              bind:this={inputEl}
              bind:value={input}
              onkeydown={handleComposerKey}
              rows="1"
              placeholder={language.risuAgent.inputPlaceholder}
              class="max-h-[200px] min-h-[24px] w-full resize-none bg-transparent py-1 text-sm leading-relaxed text-textcolor outline-none placeholder:text-textcolor2"
            ></textarea>
            {#if busy}
              <button
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-draculared text-white transition hover:opacity-90"
                onclick={stop}
                aria-label={language.risuAgent.stop}
              >
                <Square size={15} />
              </button>
            {:else}
              <button
                class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-selected text-textcolor transition hover:opacity-90 disabled:opacity-40"
                onclick={send}
                disabled={!input.trim()}
                aria-label={language.risuAgent.send}
              >
                <Send size={15} />
              </button>
            {/if}
          </div>
          <div class="mt-1.5 flex items-center justify-between gap-2">
            <span class="truncate text-[11px] text-textcolor2">
              {scopeCharacter
                ? language.risuAgent.contextAttached
                : language.risuAgent.noContext}
            </span>
            {#if !busy && messages[messages.length - 1]?.role === "char"}
              <button
                class="flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-textcolor2 transition hover:text-textcolor"
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
  </div>
</div>

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
