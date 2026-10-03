<script lang="ts">
  import { onMount } from "svelte";
  import { language } from "src/lang";
  import { globalAuthorNoteStore } from "src/ts/stores/domain/globalAuthorNoteStore";
  import { alertError } from "src/ts/alert";
  let enabled = $state(false);
  let ready = $state(false);
  onMount(() => { void globalAuthorNoteStore.getAllowScriptWrite().then((value) => { enabled = value; ready = true; }).catch((e) => alertError(String(e))); });
</script>
<label class="my-3 flex items-center gap-2 text-textcolor">
  <input type="checkbox" checked={enabled} disabled={!ready} onchange={async (event) => {
    const value = event.currentTarget.checked;
    event.currentTarget.checked = enabled;
    ready = false;
    try { await globalAuthorNoteStore.setAllowScriptWrite(value); enabled = value; }
    catch (e) { alertError(String(e)); }
    finally { ready = true; }
  }} />
  {language.globalAuthorNote.allowScriptWrite}
</label>
