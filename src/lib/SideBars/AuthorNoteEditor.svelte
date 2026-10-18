<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { language } from "src/lang";
  import { NoteSource } from "src/ts/authorNote";
  import { AuthorNoteEditor } from "src/ts/authorNoteEditor";
  import { globalAuthorNoteStore, type GlobalAuthorNote } from "src/ts/stores/domain/globalAuthorNoteStore";
  import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
  import { requireChatTarget, type ChatTarget } from "src/ts/chatTarget";
  import { getAuthorNoteDefaultText } from "src/ts/util";
  import { alertConfirm, alertInput } from "src/ts/alert";
  import TextAreaInput from "../UI/GUI/TextAreaInput.svelte";
  let { target }: { target: ChatTarget } = $props();
  let notes = $state<readonly GlobalAuthorNote[]>([]);
  let editor = $state.raw<AuthorNoteEditor | null>(null);
  let version = $state(0);
  let inputText = $state("");
  $effect(() => { inputText = draft; });
  let error = $state("");
  let busy = $state(false);
  let selection = $state("local");
  let disposed = false;
  const chat = $derived(requireChatTarget(target).chat);
  const draft = $derived.by(() => { version; return editor?.draft ?? ""; });
  const saveError = $derived.by(() => { version; return editor?.error; });
  const editorReady = $derived.by(() => { version; return editor?.isReady ?? false; });
  const buttonClass = "rounded bg-darkbutton px-3 py-1 text-textcolor hover:bg-selected disabled:opacity-50";
  async function load() {
    busy = true;
    try {
      notes = await globalAuthorNoteStore.list();
      if (disposed) return;
      const source = NoteSource.get(chat);
      selection = source.mode === "local" ? "local" : notes.some((note) => note.id === source.noteId) ? source.noteId : "__none__";
      if (selection !== "local" && selection !== "__none__") {
        const note = await globalAuthorNoteStore.get(selection);
        if (note && !disposed) { editor = new AuthorNoteEditor(note, () => version++); const loading = editor; await loading.load(); if (disposed) await loading.detach(); }
      }
    } catch (e) { error = String(e); }
    finally { busy = false; }
  }
  async function action(task: () => Promise<void>) {
    busy = true; error = "";
    try { await task(); } catch (e) { error = String(e); } finally { busy = false; }
  }
  async function switchTo(id: string) {
    await editor?.flush();
    await editor?.detach(); editor = null;
    await NoteSource.set(target, id === "local" ? { mode: "local" } : { mode: "global", noteId: id });
    await load();
  }
  $effect(() => { target.characterId; target.chatId; untrack(() => void load()); });
  onDestroy(() => { disposed = true; if (editor) void editor.detach(); });
</script>

<div class="flex min-h-0 flex-1 flex-col gap-2 text-textcolor">
  <select class="rounded border border-borderc bg-bgcolor p-2" aria-label={language.authorNote} value={selection} disabled={busy} onchange={(event) => { const id = event.currentTarget.value; event.currentTarget.value = selection; void action(() => switchTo(id)); }}>
    <option value="local">{language.globalAuthorNote.local}</option>
    {#each notes as note (note.id)}
      <option value={note.id}>{note.id === '__none__' ? language.none : note.name}</option>
    {/each}
  </select>
  <div class="flex flex-wrap gap-2">
    <button class={buttonClass} disabled={busy} onclick={() => action(async () => {
      await editor?.flush();
      const name = await alertInput(language.globalAuthorNote.name);
      if (name == null || name === '') return;
      const note = await globalAuthorNoteStore.create(name);
      await switchTo(note.id);
    })}>{language.globalAuthorNote.create}</button>
    {#if selection !== 'local' && selection !== '__none__'}
      <button class={buttonClass} disabled={busy} onclick={() => action(async () => {
        const name = await alertInput(language.globalAuthorNote.name);
        if (name == null || name === '') return;
        await globalAuthorNoteStore.rename(selection, name);
        notes = await globalAuthorNoteStore.list();
      })}>{language.globalAuthorNote.rename}</button>
      <button class={buttonClass} disabled={busy} onclick={() => action(async () => {
        if (!(await alertConfirm(language.globalAuthorNote.deleteConfirm))) return;
        await editor?.flush();
        await globalAuthorNoteStore.remove(selection);
        await editor?.detach(); editor = null;
        await switchTo('__none__');
      })}>{language.delete}</button>
    {/if}
  </div>
  {#if selection === 'local'}
    <TextAreaInput height="full" className="flex-1 min-h-0" highlight autocomplete="off" bind:value={chat.note} onInput={() => characterStore.markChatDirty(target.chatId)} placeholder={getAuthorNoteDefaultText()} />
  {:else if selection !== '__none__' && editor && editorReady}
    <div class="flex min-h-0 flex-1" inert={busy}>
      <TextAreaInput height="full" className="flex-1 min-h-0" highlight autocomplete="off" bind:value={inputText} onInput={() => editor?.input(inputText)} placeholder={getAuthorNoteDefaultText()} />
    </div>
  {/if}
  {#if saveError}
    <div role="alert" class="rounded border border-draculared p-2">
      <p>{language.globalAuthorNote.saveFailed}</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <button class={buttonClass} onclick={() => action(async () => { if (await alertConfirm(language.globalAuthorNote.discardConfirm)) await editor?.reload(); })}>{language.globalAuthorNote.reload}</button>
        <button class={buttonClass} onclick={() => action(async () => { if (await alertConfirm(language.globalAuthorNote.overwriteConfirm)) await editor?.overwrite(); })}>{language.globalAuthorNote.overwrite}</button>
        <button class={buttonClass} onclick={() => { error = ''; }}>{language.cancel}</button>
      </div>
    </div>
  {/if}
  {#if error}<p role="alert" class="text-draculared">{error}</p>{/if}
</div>
