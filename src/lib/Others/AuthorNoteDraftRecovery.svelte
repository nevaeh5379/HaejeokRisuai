<script lang="ts">
  import { failedAuthorNoteDrafts, hasUnsavedAuthorNoteDrafts, flushAuthorNoteEditors } from "src/ts/authorNoteEditor";
  import { language } from "src/lang";
  import { alertConfirm, alertError } from "src/ts/alert";
  import { onMount } from "svelte";
  import { isTauri } from "src/ts/platform";
  onMount(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedAuthorNoteDrafts()) return;
      void flushAuthorNoteEditors().catch(() => undefined);
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (isTauri) void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const current = getCurrentWindow();
      const cleanup = await current.onCloseRequested(async (event) => {
        if (!hasUnsavedAuthorNoteDrafts()) return;
        event.preventDefault();
        try { await flushAuthorNoteEditors(); await current.destroy(); }
        catch (error) { alertError(String(error)); }
      });
      if (disposed) cleanup(); else unlisten = cleanup;
    });
    return () => { disposed = true; unlisten?.(); window.removeEventListener("beforeunload", beforeUnload); };
  });
  let hidden = $state(false);
  $effect(() => { $failedAuthorNoteDrafts; hidden = false; });
</script>
{#if $failedAuthorNoteDrafts.length}
  <div class="fixed bottom-4 right-4 z-[10000] max-w-md rounded border border-draculared bg-bgcolor p-4 text-textcolor shadow-lg" role="alert">
    {#if hidden}
      <button onclick={() => hidden = false}>{language.globalAuthorNote.unsaved}</button>
    {:else}
      <p>{language.globalAuthorNote.saveFailed}</p>
      {#each $failedAuthorNoteDrafts as editor}
        <p class="mt-2">{editor.note.name}</p>
        <textarea class="mt-1 w-full bg-darkbg" readonly value={editor.draft} aria-label={language.globalAuthorNote.unsaved}></textarea>
        <div class="flex flex-wrap gap-2">
          <button onclick={async () => { try { if (await alertConfirm(language.globalAuthorNote.discardConfirm)) await editor.reload(); } catch (e) { alertError(String(e)); } }}>{language.globalAuthorNote.reload}</button>
          <button onclick={async () => { try { if (await alertConfirm(language.globalAuthorNote.overwriteConfirm)) await editor.overwrite(); } catch (e) { alertError(String(e)); } }}>{language.globalAuthorNote.overwrite}</button>
          <button onclick={async () => { if (await alertConfirm(language.globalAuthorNote.discardDraftConfirm)) editor.discard(); }}>{language.globalAuthorNote.discard}</button>
          <button onclick={() => hidden = true}>{language.cancel}</button>
        </div>
      {/each}
    {/if}
  </div>
{/if}
