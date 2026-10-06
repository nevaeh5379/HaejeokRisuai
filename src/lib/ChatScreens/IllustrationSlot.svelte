<script lang="ts">
  import { onMount } from "svelte";
  import { language } from "src/lang";
  import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
  import { describeIllustrationError, isIllustrationBusy, type IllustrationAction, type IllustrationTarget, type IllustrationErrorDetails } from "@risuai/protocol/dist/illustration.mjs";
  let { target }: { target: IllustrationTarget } = $props();
  let item = $derived(characterStore.characters.find((c) => c.chaId === target.characterId)?.chats?.find((c) => c.id === target.chatId)?.message?.find((m) => m.chatId === target.messageId)?.illustrations?.find((i) => i.id === target.illustrationId));
  let working = $state(false);
  let error = $state("");
  let busy = $derived(working || (item && isIllustrationBusy(item.status)));
  function formatError(details: IllustrationErrorDetails) {
    const reason = details.stage === "save" && details.code === "unknown"
      ? language.illustration.saveError : language.illustration.errorReasons[details.code];
    return `${language.illustration.errorStages[details.stage]}: ${reason}${details.status ? ` (HTTP ${details.status})` : ""}`;
  }
  let itemError = $derived(item?.errorDetails ? formatError(item.errorDetails) : item?.error);
  /**
   * Lazily dispatches a user action and prevents duplicate clicks while acceptance is pending.
   *
   * 한국어: 사용자 조작 모듈을 지연 로딩하고 접수 중 중복 클릭을 막는 함수.
   *
   * @param kind - Retry, same-tag regeneration or tag rewrite. / 재시도·같은 태그 재생성·태그 재작성.
   * @remarks
   * Displays a localized error when acceptance fails; image execution continues independently.
   * 한국어: 접수 실패 시 번역된 오류를 표시하며 그림 실행은 별도 진행 상태로 처리.
   */
  async function action(kind: IllustrationAction) {
    if (working) return;
    working = true;
    error = "";
    try {
      const { illustrationAction } = await import("src/ts/process/illustration/illustrationApp");
      await illustrationAction(target, kind);
    } catch (caught) { error = formatError(describeIllustrationError(caught, "prepare")); }
    finally { working = false; }
  }
  onMount(() => {
    let stopped = false;
    /**
     * Polls a visible busy slot for progress or interruption without starting new generation.
     *
     * 한국어: 보이는 처리 중 삽화의 진행·중단 상태를 조회하며 새 생성 요청은 시작하지 않는 함수.
     *
     * @remarks
     * Checks component disposal before and after lazy loading to avoid updating an unmounted slot.
     * 한국어: 지연 로딩 전후 해제 여부를 확인해 사라진 화면의 삽화 갱신을 방지.
     */
    const recover = async () => {
      if (stopped || !item || !isIllustrationBusy(item.status)) return;
      try {
        const { recoverIllustration } = await import("src/ts/process/illustration/illustrationApp");
        if (!stopped) {
          await recoverIllustration(target);
          if (!stopped) error = "";
        }
      } catch (caught) {
        if (!stopped) error = formatError(describeIllustrationError(caught, "status"));
      }
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
    {#if itemError || error}<span role="alert" class="text-draculared">{error || itemError}</span>{/if}
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
