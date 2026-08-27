<script lang="ts">
  import { Plus, Send, Square, Trash2, X } from "@lucide/svelte";
  import type { Chat as ChatSession, BtwSession } from "../../ts/storage/schema";
  import {
    btwRuntime,
    cancelBtwGeneration,
    closeBtwPanel,
    createBtwSession,
    deleteBtwSession,
    getBtwToggleDefinitions,
    renameBtwSession,
    selectBtwSession,
    sendBtwMessage,
    syncBtwToggleValues,
    updateBtwSessionConfig,
    type BtwToggleDefinition,
  } from "src/ts/process/btwSession.svelte";
  import { moduleStore, presetStore } from "src/ts/stores/domain";

  interface Props {
    characterIndex: number;
    chatIndex: number;
    chat?: ChatSession;
  }

  let { characterIndex, chatIndex, chat }: Props = $props();
  let input = $state("");
  let toggleDefinitions = $state<BtwToggleDefinition[]>([]);
  let settingsOpen = $state(false);

  let sessions = $derived(chat?.btwSessions ?? []);
  let activeSession = $derived(
    sessions.find((session) => session.id === chat?.activeBtwSessionId) ?? sessions.at(-1),
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
    void syncBtwToggleValues(characterIndex, chat, session).then((definitions) => {
      if (activeSession?.id === id) toggleDefinitions = definitions;
    });
  });

  function setConfig(session: BtwSession, patch: Parameters<typeof updateBtwSessionConfig>[2]) {
    if (!chat) return;
    updateBtwSessionConfig(chat, session, patch);
  }

  async function refreshToggles(session: BtwSession) {
    if (!chat) return;
    toggleDefinitions = await syncBtwToggleValues(characterIndex, chat, session);
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

  function toggleValue(session: BtwSession, definition: BtwToggleDefinition, value: string) {
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
        !["group", "groupEnd", "divider", "caption"].includes(definition.type ?? ""),
    );
  }
</script>

<div class="absolute inset-x-0 bottom-0 top-10 z-40 flex bg-bgcolor/95 backdrop-blur-sm">
  <aside class="w-44 shrink-0 border-r border-darkborderc p-2 flex flex-col gap-2 min-h-0">
    <div class="flex items-center justify-between gap-2 px-1">
      <div class="font-bold text-textcolor">BTW</div>
      <button class="p-1 rounded hover:bg-darkborderc" title="New BTW" onclick={addSession}>
        <Plus size={17} />
      </button>
    </div>
    <div class="grow min-h-0 overflow-y-auto flex flex-col gap-1">
      {#each sessions as session (session.id)}
        <button
          class="group w-full text-left px-2 py-2 rounded border {activeSession?.id === session.id ? 'border-blue-500 bg-blue-500/10' : 'border-transparent hover:bg-darkborderc/50'}"
          onclick={() => chat && selectBtwSession(chat, session.id)}
        >
          <div class="text-sm truncate text-textcolor">{session.name}</div>
          <div class="text-[10px] text-textcolor2">{session.messages.length} messages</div>
        </button>
      {/each}
    </div>
  </aside>

  <section class="grow min-w-0 min-h-0 flex flex-col">
    {#if activeSession && chat}
      <header class="h-12 shrink-0 border-b border-darkborderc px-3 flex items-center gap-2">
        <input
          class="grow min-w-0 bg-transparent text-textcolor font-semibold outline-none border-b border-transparent focus:border-blue-500"
          value={activeSession.name}
          onchange={(event) => renameBtwSession(chat, activeSession, event.currentTarget.value)}
        />
        <button
          class="px-2 py-1 text-xs rounded border border-darkborderc hover:bg-darkborderc"
          class:bg-blue-500={settingsOpen}
          onclick={() => (settingsOpen = !settingsOpen)}
        >Settings</button>
        <button
          class="p-1.5 rounded hover:bg-red-500/20 hover:text-red-400"
          title="Delete BTW"
          onclick={() => {
            const id = activeSession.id;
            deleteBtwSession(chat, id);
          }}
        ><Trash2 size={16} /></button>
        <button class="p-1.5 rounded hover:bg-darkborderc" title="Close BTW" onclick={closeBtwPanel}>
          <X size={18} />
        </button>
      </header>

      {#if settingsOpen}
        <div class="shrink-0 max-h-[45%] overflow-y-auto border-b border-darkborderc p-3 grid grid-cols-1 lg:grid-cols-2 gap-4 text-sm">
          <div class="flex flex-col gap-3">
            <label class="flex flex-col gap-1 text-textcolor2">
              <span>Prompt preset</span>
              <select
                class="bg-darkbg border border-darkborderc rounded px-2 py-1.5 text-textcolor"
                value={activeSession.config.promptPresetId ?? presetStore.activeId}
                onchange={(event) => {
                  setConfig(activeSession, { promptPresetId: event.currentTarget.value || undefined });
                  void refreshToggles(activeSession);
                }}
              >
                {#each presetStore.summaries as preset (preset.id)}
                  <option value={preset.id}>{preset.name}</option>
                {/each}
              </select>
            </label>

            <label class="flex items-center justify-between gap-3 text-textcolor">
              <span>Jailbreak prompt</span>
              <input
                type="checkbox"
                checked={activeSession.config.jailbreakToggle}
                onchange={(event) => setConfig(activeSession, { jailbreakToggle: event.currentTarget.checked })}
              />
            </label>
            <label class="flex items-center justify-between gap-3 text-textcolor">
              <span>Plugin chat hooks</span>
              <input
                type="checkbox"
                checked={activeSession.config.pluginsEnabled}
                onchange={(event) => setConfig(activeSession, { pluginsEnabled: event.currentTarget.checked })}
              />
            </label>

            <div class="flex flex-col gap-1">
              <div class="text-textcolor2">Modules ({activeSession.config.moduleIds.length})</div>
              <div class="max-h-40 overflow-y-auto border border-darkborderc rounded p-2 flex flex-col gap-1">
                {#each moduleStore.list as module (module.id)}
                  <label class="flex items-center gap-2 text-textcolor hover:bg-darkborderc/30 rounded px-1 py-1">
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
          </div>

          <div class="flex flex-col gap-2">
            <div class="text-textcolor2">Prompt / module toggles</div>
            {#if toggleDefinitions.some(isRenderableToggle)}
              <div class="border border-darkborderc rounded p-2 flex flex-col gap-2">
                {#each toggleDefinitions as toggle, index (`${toggle.key}-${index}`)}
                  {#if toggle.type === 'caption'}
                    <div class="text-xs text-textcolor2">{toggle.value}</div>
                  {:else if toggle.type === 'divider'}
                    <hr class="border-darkborderc" />
                  {:else if isRenderableToggle(toggle)}
                    <label class="flex items-center justify-between gap-3 text-textcolor">
                      <span class="min-w-0 truncate" title={toggle.value}>{toggle.value}</span>
                      {#if toggle.type === 'select'}
                        <select
                          class="w-36 bg-darkbg border border-darkborderc rounded px-1 py-1"
                          value={activeSession.config.toggleValues[`toggle_${toggle.key}`] ?? ''}
                          onchange={(event) => toggleValue(activeSession, toggle, event.currentTarget.value)}
                        >
                          <option value=""></option>
                          {#each toggle.options ?? [] as option, optionIndex}
                            <option value={optionIndex.toString()}>{option}</option>
                          {/each}
                        </select>
                      {:else if toggle.type === 'text' || toggle.type === 'textarea'}
                        <input
                          class="w-36 bg-darkbg border border-darkborderc rounded px-2 py-1"
                          value={activeSession.config.toggleValues[`toggle_${toggle.key}`] ?? ''}
                          onchange={(event) => toggleValue(activeSession, toggle, event.currentTarget.value)}
                        />
                      {:else}
                        <input
                          type="checkbox"
                          checked={activeSession.config.toggleValues[`toggle_${toggle.key}`] === '1'}
                          onchange={(event) => toggleValue(activeSession, toggle, event.currentTarget.checked ? '1' : '0')}
                        />
                      {/if}
                    </label>
                  {/if}
                {/each}
              </div>
            {:else}
              <div class="text-xs text-textcolor2 border border-dashed border-darkborderc rounded p-3">
                No toggles are defined by this prompt/module set.
              </div>
            {/if}
          </div>
        </div>
      {/if}

      <div class="grow min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
        <div class="text-xs text-textcolor2 border border-dashed border-darkborderc rounded px-3 py-2">
          Frozen from the parent chat at {activeSession.baseMessageCount} messages. BTW messages do not enter the parent history.
        </div>
        {#each activeSession.messages as message (message.chatId)}
          <div class="flex {message.role === 'user' ? 'justify-end' : 'justify-start'}">
            <div class="max-w-[85%] whitespace-pre-wrap break-words rounded-xl px-3 py-2 {message.role === 'user' ? 'bg-blue-500 text-white' : 'bg-darkbg text-textcolor border border-darkborderc'}">
              {message.data || (message.role === 'char' && generating ? '…' : '')}
            </div>
          </div>
        {/each}
        {#if btwRuntime.errors[activeSession.id]}
          <div class="text-xs text-red-400">{btwRuntime.errors[activeSession.id]}</div>
        {/if}
      </div>

      <div class="shrink-0 border-t border-darkborderc p-3 flex gap-2 items-end">
        <textarea
          class="grow resize-none min-h-10 max-h-32 rounded-lg bg-darkbg border border-darkborderc px-3 py-2 text-textcolor outline-none focus:border-blue-500"
          rows="2"
          placeholder="Ask something on the side…"
          bind:value={input}
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        ></textarea>
        {#if generating}
          <button
            class="h-10 w-10 rounded-lg border border-red-500 text-red-400 flex items-center justify-center hover:bg-red-500/10"
            title="Stop"
            onclick={() => cancelBtwGeneration(activeSession.id)}
          ><Square size={16} /></button>
        {:else}
          <button
            class="h-10 w-10 rounded-lg bg-blue-500 text-white flex items-center justify-center disabled:opacity-40"
            title="Send"
            disabled={!input.trim()}
            onclick={() => void submit()}
          ><Send size={17} /></button>
        {/if}
      </div>
    {:else}
      <div class="grow flex items-center justify-center text-textcolor2">No BTW session</div>
      <button class="absolute top-2 right-2 p-2" onclick={closeBtwPanel}><X size={18} /></button>
    {/if}
  </section>
</div>
