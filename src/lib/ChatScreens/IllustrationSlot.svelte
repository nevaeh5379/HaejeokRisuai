<script lang="ts">
  import { onMount } from "svelte";
  import { language } from "src/lang";
  import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
  import { isIllustrationBusy, type IllustrationAction, type IllustrationTarget } from "@risuai/protocol/dist/illustration.mjs";
  let { target }: { target: IllustrationTarget } = $props();
  let item = $derived(characterStore.characters.find((c) => c.chaId === target.characterId)?.chats?.find((c) => c.id === target.chatId)?.message?.find((m) => m.chatId === target.messageId)?.illustrations?.find((i) => i.id === target.illustrationId));
  let working = $state(false);
  let error = $state("");
  let busy = $derived(working || (item && isIllustrationBusy(item.status)));
  async function action(kind: IllustrationAction) {
    if (working) return;
    working = true;
    error = "";
    try {
      const { illustrationAction } = await import("src/ts/process/illustration/illustrationApp");
      await illustrationAction(target, kind);
    } catch { error = language.illustration.operationFailed; }
    finally { working = false; }
  }
  onMount(() => {
    let stopped = false;
    const recover = async () => {
      if (stopped || !item || !isIllustrationBusy(item.status)) return;
      const { recoverIllustration } = await import("src/ts/process/illustration/illustrationApp");
      if (!stopped) await recoverIllustration(target).catch(() => {});
    };
    void recover();
    const timer = setInterval(() => { void recover(); }, 5000);
    return () => { stopped = true; clearInterval(timer); };
  });
</script>

{#if item}
  <!-- Stop message click-to-edit from consuming illustration controls. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <span role="group" aria-label={language.illustration.title} class="not-prose my-2 flex flex-wrap items-center gap-2 rounded border border-darkborderc bg-darkbg p-2 text-sm text-textcolor"
    onclick={(e) => e.stopPropagation()} onpointerdown={(e) => e.stopPropagation()}>
    {#if item.status !== "complete"}<span aria-live="polite">{language.illustration[item.status]}</span>{/if}
    {#if item.error || error}<span class="text-draculared">{error || item.error}</span>{/if}
    {#if item.status === "failed" || item.status === "interrupted"}
      <button class="rounded bg-darkbutton px-2 py-1 disabled:opacity-50" disabled={busy} onclick={() => action("retry")}>{language.illustration.retry}</button>
    {/if}
    {#if item.imageId}
      <button class="rounded bg-darkbutton px-2 py-1 disabled:opacity-50" disabled={busy} onclick={() => action("regenerate")}>{language.illustration.regenerate}</button>
    {/if}
    <button class="rounded bg-darkbutton px-2 py-1 disabled:opacity-50" disabled={busy} onclick={() => action("rewrite")}>{language.illustration.rewrite}</button>
    {#if item.tags}<details><summary>{language.illustration.tags}</summary><span class="whitespace-pre-wrap">{item.tags}</span></details>{/if}
  </span>
{/if}
