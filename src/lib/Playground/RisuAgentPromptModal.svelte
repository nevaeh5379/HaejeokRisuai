<script lang="ts">
  import { onMount } from "svelte";
  import { SlidersHorizontal, X } from "@lucide/svelte";
  import { language } from "src/lang";
  import Check from "src/lib/UI/GUI/CheckInput.svelte";
  import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
  import TextInput from "src/lib/UI/GUI/TextInput.svelte";
  import PromptTemplateEditor from "src/lib/UI/PromptTemplateEditor.svelte";
  import { getUtilityBotTemplate } from "src/ts/process/chatPromptSections";
  import {
    createDefaultRisuAgentPromptConfig,
    normalizeRisuAgentPromptConfig,
    type RisuAgentPromptConfig,
  } from "src/ts/agent/risuAgentPrompt";
  import {
    getRisuAgentPromptConfig,
    setRisuAgentPromptConfig,
  } from "src/ts/agent/risuAgentStore";
  import { safeStructuredClone } from "src/ts/polyfill";
  import type { character } from "src/ts/storage/database/schema";

  let {
    agentCharacter,
    onClose,
  }: {
    agentCharacter: character;
    onClose: () => void;
  } = $props();

  let subMenu = $state(0);
  let saving = $state(false);
  let closing = $state(false);

  /** Persisted baseline, used only for the dirty check. */
  const stored = $derived(
    normalizeRisuAgentPromptConfig(agentCharacter.agentPrompt),
  );
  const storedSignature = $derived(JSON.stringify(stored ?? null));

  /**
   * A fresh draft seeds the agent with a working template (the utility-bot
   * template, which includes the chat history card) but leaves the master
   * switch off, so opening this modal never changes generation by itself.
   */
  function createDraft(): RisuAgentPromptConfig {
    return (
      getRisuAgentPromptConfig(agentCharacter) ??
      createDefaultRisuAgentPromptConfig(
        safeStructuredClone(getUtilityBotTemplate()),
      )
    );
  }

  let draft = $state<RisuAgentPromptConfig>(createDraft());
  const draftSignature = $derived(JSON.stringify(normalizeRisuAgentPromptConfig(draft)));
  const dirty = $derived(draftSignature !== storedSignature);

  async function persist(config: RisuAgentPromptConfig | null) {
    saving = true;
    try {
      await setRisuAgentPromptConfig(agentCharacter, config);
    } finally {
      saving = false;
    }
  }

  /** Save the draft, then close. The only path that persists edits. */
  async function saveAndClose() {
    if (closing) return;
    closing = true;
    try {
      if (dirty) await persist(draft);
    } finally {
      onClose();
    }
  }

  /** Discard the draft and close. Used by Cancel, the X, backdrop and Escape. */
  function cancelAndClose() {
    if (closing) return;
    closing = true;
    onClose();
  }

  /** Restore defaults (remove the stored config) and close. */
  async function resetToDefaults() {
    if (closing) return;
    closing = true;
    try {
      await persist(null);
    } finally {
      onClose();
    }
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === "Escape") cancelAndClose();
  }

  onMount(() => {
    // Re-read after mounting so a legacy character (missing field) starts from
    // valid defaults rather than the pre-mount snapshot.
    draft = createDraft();
  });
</script>

<svelte:window onkeydown={handleEscape} />

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) cancelAndClose();
  }}
>
  <div
    class="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-bgcolor text-textcolor shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-label={language.risuAgent.promptSettings}
  >
    <div class="flex items-center gap-2 px-3 pb-1 pt-3">
      <span
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-textcolor/5 text-textcolor2"
      >
        <SlidersHorizontal size={15} />
      </span>
      <div class="min-w-0 grow px-1">
        <div class="truncate font-semibold">
          {language.risuAgent.promptSettings}
        </div>
        <div class="text-xs text-textcolor2">
          {language.risuAgent.promptHint}
        </div>
      </div>
      <button
        class="shrink-0 rounded-full p-1.5 text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor"
        onclick={cancelAndClose}
        aria-label={language.risuAgent.close}
      >
        <X size={18} />
      </button>
    </div>

    <div class="flex w-full gap-1 px-3 pt-1">
      <button
        class="rounded-full px-3 py-1.5 text-sm transition {subMenu === 0
          ? 'bg-textcolor/10 font-medium text-textcolor'
          : 'text-textcolor2 hover:bg-textcolor/5 hover:text-textcolor'}"
        onclick={() => (subMenu = 0)}
      >
        {language.template}
      </button>
      <button
        class="rounded-full px-3 py-1.5 text-sm transition {subMenu === 1
          ? 'bg-textcolor/10 font-medium text-textcolor'
          : 'text-textcolor2 hover:bg-textcolor/5 hover:text-textcolor'}"
        onclick={() => (subMenu = 1)}
      >
        {language.settings}
      </button>
    </div>

    <div class="min-h-0 grow overflow-y-auto px-3 py-2">
      {#if subMenu === 0}
        <PromptTemplateEditor
          bind:template={draft.promptTemplate}
          promptSettings={draft.promptSettings}
        />
      {:else}
        <Check
          bind:check={draft.promptSettings.utilOverride}
          name={language.risuAgent.promptEnabled}
          className="mt-2"
        />
        <span class="text-textcolor mt-4">{language.postEndInnerFormat}</span>
        <TextInput bind:value={draft.promptSettings.postEndInnerFormat} />
        <Check
          bind:check={draft.promptSettings.sendChatAsSystem}
          name={language.sendChatAsSystem}
          className="mt-4"
        />
        <Check
          bind:check={draft.promptSettings.sendName}
          name={language.formatGroupInSingle}
          className="mt-4"
        />
        <Check
          bind:check={draft.promptSettings.trimStartNewChat}
          name={language.trimStartNewChat}
          className="mt-4"
        />
        <Check
          bind:check={draft.promptSettings.customChainOfThought}
          name={language.customChainOfThought}
          className="mt-4"
        />
        <span class="text-textcolor mt-4">{language.maxThoughtTagDepth}</span>
        <NumberInput bind:value={draft.promptSettings.maxThoughtTagDepth} />
      {/if}
    </div>

    <div class="flex items-center justify-end gap-1 px-3 pb-3 pt-2">
      <button
        class="rounded-full px-3 py-1.5 text-sm text-textcolor2 transition hover:bg-textcolor/5 hover:text-textcolor disabled:opacity-40"
        onclick={() => void resetToDefaults()}
        disabled={saving || closing}
      >
        {language.risuAgent.promptReset}
      </button>
      <button
        class="rounded-full bg-textcolor/5 px-3 py-1.5 text-sm text-textcolor2 transition hover:bg-textcolor/10 hover:text-textcolor disabled:opacity-40"
        onclick={cancelAndClose}
        disabled={saving || closing}
      >
        {language.cancel}
      </button>
      <button
        class="rounded-full bg-textcolor px-4 py-1.5 text-sm text-bgcolor transition hover:opacity-90 disabled:opacity-40"
        onclick={() => void saveAndClose()}
        disabled={saving || closing || !dirty}
      >
        {language.risuAgent.promptSave}
      </button>
    </div>
  </div>
</div>
