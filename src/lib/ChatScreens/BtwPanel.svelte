<script lang="ts">
  import {
    ChevronDown,
    ChevronUp,
    MessageCircleMore,
    Plus,
    Send,
    Square,
    Trash2,
    X,
  } from "@lucide/svelte";
  import { tick } from "svelte";
  import type { BtwSession } from "../../ts/storage/schema";
  import { getCharImage } from "../../ts/characterImage";
  import { createSimpleCharacter } from "../../ts/stores.svelte";
  import { chatTargetFromIndexes } from "../../ts/chatTarget";
  import {
    getUserIcon,
    getUserIconProtrait,
    getUserName,
  } from "../../ts/util";
  import {
    cancelBtwGeneration,
    closeBtwPanel,
    createBtwSession,
    deleteBtwSession,
    renameBtwSession,
    selectBtwSession,
    sendBtwMessage,
    syncBtwToggleValues,
    updateBtwSessionConfig,
    type BtwToggleDefinition,
  } from "src/ts/process/btwSession.svelte";
  import { btwRuntime } from "src/ts/process/btwRuntime.svelte";
  import { characterStore, moduleStore, presetStore } from "src/ts/stores/domain";
  import ChatMessage from "./Chat.svelte";

  let input = $state("");
  let toggleDefinitions = $state<BtwToggleDefinition[]>([]);
  let settingsOpen = $state(false);
  let messagesElement: HTMLDivElement | undefined = $state();

  let characterIndex = $derived(btwRuntime.characterIndex);
  let chatIndex = $derived(btwRuntime.chatIndex);
  let chat = $derived(
    characterStore.characters[characterIndex]?.chats?.[chatIndex],
  );
  let room = $derived(characterStore.characters[characterIndex]);
  let chatTarget = $derived(
    chatTargetFromIndexes(characterIndex, chatIndex) ?? undefined,
  );
  let simpleCharacter = $derived(room ? createSimpleCharacter(room) : null);
  let userName = $derived(getUserName(chatTarget));
  let userIcon = $derived(
    getCharImage(getUserIcon(chatTarget), "css", { thumbnail: true }),
  );
  let userLargePortrait = $derived(getUserIconProtrait(chatTarget));
  let characterIcon = $derived(
    room ? getCharImage(room.image, "css", { thumbnail: true }) : "",
  );
  let sessions = $derived(chat?.btwSessions ?? []);
  let activeSession = $derived(
    sessions.find((session) => session.id === chat?.activeBtwSessionId) ??
      sessions.at(-1),
  );
  let generating = $derived(
    activeSession ? Boolean(btwRuntime.generating[activeSession.id]) : false,
  );

  $effect(() => {
    const session = activeSession;
    if (!session || !chat) {
      toggleDefinitions = [];
      return;
    }
    const id = session.id;
    void syncBtwToggleValues(characterIndex, chat, session).then(
      (definitions) => {
        if (activeSession?.id === id) toggleDefinitions = definitions;
      },
    );
  });

  $effect(() => {
    const session = activeSession;
    const lastMessage = session?.messages.at(-1);
    const messageCount = session?.messages.length;
    void messageCount;
    lastMessage?.data;
    void tick().then(() => {
      if (messagesElement) messagesElement.scrollTop = messagesElement.scrollHeight;
    });
  });

  function setConfig(
    session: BtwSession,
    patch: Parameters<typeof updateBtwSessionConfig>[2],
  ) {
    if (!chat) return;
    updateBtwSessionConfig(chat, session, patch);
  }

  async function refreshToggles(session: BtwSession) {
    if (!chat) return;
    toggleDefinitions = await syncBtwToggleValues(
      characterIndex,
      chat,
      session,
    );
  }

  async function addSession() {
    if (!chat) return;
    const session = await createBtwSession(characterIndex, chatIndex);
    selectBtwSession(chat, session.id);
    input = "";
  }

  async function submit() {
    const session = activeSession;
    const text = input.trim();
    if (!session || !text || generating) return;
    input = "";
    await sendBtwMessage(characterIndex, chatIndex, session.id, text);
  }

  function toggleModule(session: BtwSession, moduleId: string) {
    const ids = new Set(session.config.moduleIds);
    if (ids.has(moduleId)) ids.delete(moduleId);
    else ids.add(moduleId);
    setConfig(session, { moduleIds: [...ids] });
    void refreshToggles(session);
  }

  function toggleValue(
    session: BtwSession,
    definition: BtwToggleDefinition,
    value: string,
  ) {
    if (!definition.key) return;
    setConfig(session, {
      toggleValues: {
        ...session.config.toggleValues,
        [`toggle_${definition.key}`]: value,
      },
    });
  }

  function isRenderableToggle(definition: BtwToggleDefinition) {
    return Boolean(
      definition.key &&
        !["group", "groupEnd", "divider", "caption"].includes(
          definition.type ?? "",
        ),
    );
  }
</script>

<div class="flex h-full min-h-0 w-full flex-col bg-darkbg text-textcolor">
  <header class="flex min-h-12 shrink-0 items-center gap-2 border-b border-darkborderc px-2">
    <MessageCircleMore size={19} class="shrink-0 text-textcolor2" />
    <strong class="grow truncate">BTW</strong>
    <button
      class="rounded-md p-1.5 text-textcolor2 hover:bg-darkborderc hover:text-textcolor"
      title="New BTW"
      aria-label="New BTW"
      onclick={() => void addSession()}
    ><Plus size={18} /></button>
    <button
      class="rounded-md p-1.5 text-textcolor2 hover:bg-darkborderc hover:text-textcolor"
      title="Close BTW"
      aria-label="Close BTW"
      onclick={closeBtwPanel}
    ><X size={19} /></button>
  </header>

  {#if activeSession && chat}
    <div class="shrink-0 border-b border-darkborderc p-2">
      <div class="flex items-center gap-1.5">
        <select
          class="min-w-0 grow rounded-md border border-darkborderc bg-bgcolor px-2 py-1.5 text-sm text-textcolor"
          value={activeSession.id}
          aria-label="BTW session"
          onchange={(event) => selectBtwSession(chat, event.currentTarget.value)}
        >
          {#each sessions as session (session.id)}
            <option value={session.id}>{session.name} ({session.messages.length})</option>
          {/each}
        </select>
        <button
          class="rounded-md p-2 text-textcolor2 hover:bg-red-500/15 hover:text-red-400"
          title="Delete BTW"
          aria-label="Delete BTW"
          onclick={() => deleteBtwSession(chat, activeSession.id)}
        ><Trash2 size={16} /></button>
      </div>
      <input
        class="mt-1.5 w-full border-b border-transparent bg-transparent px-1 text-sm font-medium text-textcolor outline-none focus:border-selected"
        value={activeSession.name}
        aria-label="BTW name"
        onchange={(event) =>
          renameBtwSession(chat, activeSession, event.currentTarget.value)}
      />
      <button
        class="mt-1 flex w-full items-center justify-between rounded px-1 py-1 text-xs text-textcolor2 hover:bg-darkborderc/50"
        aria-expanded={settingsOpen}
        onclick={() => (settingsOpen = !settingsOpen)}
      >
        <span>Prompt settings</span>
        {#if settingsOpen}<ChevronUp size={15} />{:else}<ChevronDown size={15} />{/if}
      </button>
    </div>

    {#if settingsOpen}
      <div class="max-h-[45%] shrink-0 space-y-3 overflow-y-auto border-b border-darkborderc p-3 text-sm">
        <label class="flex flex-col gap-1 text-textcolor2">
          <span>Prompt preset</span>
          <select
            class="rounded border border-darkborderc bg-bgcolor px-2 py-1.5 text-textcolor"
            value={activeSession.config.promptPresetId ?? presetStore.activeId}
            onchange={(event) => {
              setConfig(activeSession, {
                promptPresetId: event.currentTarget.value || undefined,
              });
              void refreshToggles(activeSession);
            }}
          >
            {#each presetStore.summaries as preset (preset.id)}
              <option value={preset.id}>{preset.name}</option>
            {/each}
          </select>
        </label>

        <label class="flex items-center justify-between gap-3">
          <span>Jailbreak prompt</span>
          <input
            type="checkbox"
            checked={activeSession.config.jailbreakToggle}
            onchange={(event) =>
              setConfig(activeSession, {
                jailbreakToggle: event.currentTarget.checked,
              })}
          />
        </label>
        <label class="flex items-center justify-between gap-3">
          <span>Plugin chat hooks</span>
          <input
            type="checkbox"
            checked={activeSession.config.pluginsEnabled}
            onchange={(event) =>
              setConfig(activeSession, {
                pluginsEnabled: event.currentTarget.checked,
              })}
          />
        </label>

        <div class="space-y-1">
          <div class="text-textcolor2">Modules ({activeSession.config.moduleIds.length})</div>
          <div class="max-h-36 space-y-1 overflow-y-auto rounded border border-darkborderc p-2">
            {#each moduleStore.list as module (module.id)}
              <label class="flex items-center gap-2 rounded px-1 py-1 hover:bg-darkborderc/40">
                <input
                  type="checkbox"
                  checked={activeSession.config.moduleIds.includes(module.id)}
                  onchange={() => toggleModule(activeSession, module.id)}
                />
                <span class="truncate">{module.name || module.namespace || module.id}</span>
              </label>
            {/each}
          </div>
        </div>

        {#if toggleDefinitions.some(isRenderableToggle)}
          <div class="space-y-2 rounded border border-darkborderc p-2">
            <div class="text-textcolor2">Prompt / module toggles</div>
            {#each toggleDefinitions as toggle, index (`${toggle.key}-${index}`)}
              {#if toggle.type === "caption"}
                <div class="text-xs text-textcolor2">{toggle.value}</div>
              {:else if toggle.type === "divider"}
                <hr class="border-darkborderc" />
              {:else if isRenderableToggle(toggle)}
                <label class="flex items-center justify-between gap-2">
                  <span class="min-w-0 truncate" title={toggle.value}>{toggle.value}</span>
                  {#if toggle.type === "select"}
                    <select
                      class="w-32 rounded border border-darkborderc bg-bgcolor px-1 py-1"
                      value={activeSession.config.toggleValues[`toggle_${toggle.key}`] ?? ""}
                      onchange={(event) =>
                        toggleValue(activeSession, toggle, event.currentTarget.value)}
                    >
                      <option value=""></option>
                      {#each toggle.options ?? [] as option, optionIndex}
                        <option value={optionIndex.toString()}>{option}</option>
                      {/each}
                    </select>
                  {:else if toggle.type === "text" || toggle.type === "textarea"}
                    <input
                      class="w-32 rounded border border-darkborderc bg-bgcolor px-2 py-1"
                      value={activeSession.config.toggleValues[`toggle_${toggle.key}`] ?? ""}
                      onchange={(event) =>
                        toggleValue(activeSession, toggle, event.currentTarget.value)}
                    />
                  {:else}
                    <input
                      type="checkbox"
                      checked={activeSession.config.toggleValues[`toggle_${toggle.key}`] === "1"}
                      onchange={(event) =>
                        toggleValue(
                          activeSession,
                          toggle,
                          event.currentTarget.checked ? "1" : "0",
                        )}
                    />
                  {/if}
                </label>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div bind:this={messagesElement} class="min-h-0 grow space-y-3 overflow-y-auto p-3">
      <div class="rounded-md border border-dashed border-darkborderc px-2 py-1.5 text-[11px] leading-relaxed text-textcolor2">
        Parent context frozen at {activeSession.baseMessageCount} messages. This thread stays out of the main chat.
      </div>
      {#if room && chatTarget}
        {#each activeSession.messages as message, index (message.chatId)}
          <ChatMessage
            message={message.data}
            name={message.role === "user" ? userName : message.name || room.name}
            largePortrait={message.role === "user"
              ? userLargePortrait
              : room.type === "character" && room.largePortrait}
            isLastMemory={false}
            img={message.role === "user" ? userIcon : characterIcon}
            idx={index}
            scriptIdx={activeSession.baseMessageCount + index}
            messageGenerationInfo={message.generationInfo}
            role={message.role}
            totalLength={activeSession.messages.length}
            character={simpleCharacter}
            isComment={message.isComment ?? false}
            disabled={message.disabled ?? false}
            hideButtons={true}
            targetCharacterIndex={characterIndex}
            targetChatIndex={chatIndex}
            sourceMessage={message}
            {chatTarget}
          />
        {/each}
      {/if}
    </div>

    <div class="flex shrink-0 items-end gap-2 border-t border-darkborderc p-2">
      <textarea
        class="max-h-28 min-h-11 grow resize-none rounded-lg border border-darkborderc bg-bgcolor px-3 py-2 text-sm text-textcolor outline-none focus:border-selected"
        rows="2"
        placeholder="Ask on the side…"
        bind:value={input}
        onkeydown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
      ></textarea>
      {#if generating}
        <button
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-red-500 text-red-400 hover:bg-red-500/10"
          title="Stop"
          aria-label="Stop"
          onclick={() => cancelBtwGeneration(activeSession.id)}
        ><Square size={16} /></button>
      {:else}
        <button
          class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-selected text-white disabled:opacity-40"
          title="Send"
          aria-label="Send"
          disabled={!input.trim()}
          onclick={() => void submit()}
        ><Send size={17} /></button>
      {/if}
    </div>
  {:else}
    <div class="flex grow flex-col items-center justify-center gap-3 p-4 text-center text-textcolor2">
      <MessageCircleMore size={28} />
      <span>No BTW session</span>
      <button
        class="rounded-md bg-selected px-3 py-2 text-sm text-white"
        onclick={() => void addSession()}
      >New BTW</button>
    </div>
  {/if}
</div>
