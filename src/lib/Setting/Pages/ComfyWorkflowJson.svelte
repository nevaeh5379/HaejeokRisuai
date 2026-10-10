<script lang="ts">
  import { untrack } from "svelte";
  import { JsonView, collapseAllNested } from "@humanspeak/svelte-json-view-lite";
  import { language } from "src/lang";
  import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";

  let { workflow = $bindable() }: { workflow: string } = $props();
  let editing = $state(untrack(() => !workflow.trim()));
  let validationError = $state("");

  function parseWorkflow(): object {
    const value: unknown = JSON.parse(workflow);
    if (value === null || typeof value !== "object") {
      throw new Error(language.comfyWorkflows.invalidJson);
    }
    return value;
  }

  // Keep only the selected workflow parsed, and release its tree while editing.
  const parsed = $derived.by(() => {
    if (editing) return { data: null, error: "" };
    try {
      return { data: parseWorkflow(), error: "" };
    } catch {
      return { data: null, error: language.comfyWorkflows.invalidJson };
    }
  });

  function toggleEditing() {
    validationError = "";
    if (editing) {
      try {
        parseWorkflow();
      } catch {
        validationError = language.comfyWorkflows.invalidJson;
        return;
      }
    }
    editing = !editing;
  }
</script>

<div class="flex flex-col gap-2">
  <button
    class="self-start rounded-md border border-darkborderc px-3 py-2 text-sm text-textcolor hover:bg-textcolor/5"
    aria-pressed={editing}
    onclick={toggleEditing}
  >
    {editing ? language.comfyWorkflows.viewJson : language.comfyWorkflows.editJson}
  </button>
  {#if editing}
    <TextAreaInput size="sm" height="32" bind:value={workflow} />
  {:else if parsed.data}
    <div class="workflow-json max-h-96 overflow-auto rounded-md border border-darkborderc text-sm">
      <JsonView data={parsed.data} shouldExpandNode={collapseAllNested} clickToExpandNode aria-label={language.comfyWorkflows.viewJson} />
    </div>
  {/if}
  {#if parsed.error || validationError}
    <p class="text-sm text-draculared" role="alert">{parsed.error || validationError}</p>
  {/if}
</div>

<style>
  .workflow-json :global(div[role="tree"]) {
    --sjv-background: var(--risu-theme-darkbg);
    --sjv-label: var(--risu-theme-textcolor);
    --sjv-punctuation: var(--risu-theme-textcolor2);
    --sjv-string: var(--risu-theme-textcolor);
    --sjv-number: var(--risu-theme-textcolor2);
    --sjv-boolean: var(--risu-theme-textcolor2);
    --sjv-null: var(--risu-theme-draculared);
    --sjv-undefined: var(--risu-theme-draculared);
    --sjv-other: var(--risu-theme-textcolor2);
    --sjv-expander: var(--risu-theme-textcolor);
    overflow-wrap: anywhere;
  }
</style>
