import type {
  Illustration,
  IllustrationContext,
  IllustrationSettings,
  IllustrationTarget,
} from "@risuai/protocol/src/illustration.ts";
import { readIllustrationHistory } from "@risuai/protocol/src/illustrationStorage.ts";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type { character, Chat, Message } from "../../storage/database/schema";
import { getPersonaPrompt } from "../../util";
import { risuChatParser } from "../scripts";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { safeStructuredClone } from "../../polyfill";

/**
 * Reconstructs optional context for an explicit tag rewrite at a historical illustration slot.
 *
 * 한국어: 과거 삽화 자리의 명시적 태그 재작성을 위해 선택한 문맥을 재구성하는 함수.
 *
 * @param storage - Storage used for bounded history/cache reads. / 제한된 이력·캐시 조회용 저장소.
 * @param target - Stable target identifiers. / 안정적인 대상 ID.
 * @param char - Current character configuration. / 현재 캐릭터 설정.
 * @param chat - Chat metadata for module and persona selection. / 모듈·페르소나 선택에 사용할 채팅 메타데이터.
 * @param message - Target answer. / 대상 답변.
 * @param item - Slot defining the scene boundary. / 장면의 끝을 지정하는 삽화 자리.
 * @param position - Absolute answer position in storage. / 저장소에서 답변의 절대 위치.
 * @param settings - Current context inclusion settings. / 현재 문맥 포함 설정.
 * @returns Selected descriptions, read-only lore and eligible cached memory. / 선택한 설명·읽기 전용 로어·사용 가능한 캐시 메모리.
 * @remarks
 * Lore scanning uses only history and the answer prefix; cached summaries must precede the answer.
 * Does not update lore activation flags or run a memory summarizer.
 * 한국어: 이전 대화·표식 직전 답변만으로 로어를 조회하고 답변 이전 메시지에 해당하는 캐시 요약만 사용.
 * 로어 활성화 상태 변경과 메모리 요약 생성은 실행하지 않는 방식.
 */
export async function currentIllustrationContext(
  storage: ISqlStorage,
  target: IllustrationTarget,
  char: character,
  chat: Chat,
  message: Message,
  item: Illustration,
  position: number,
  settings: IllustrationSettings,
): Promise<IllustrationContext> {
  const chatTarget = { characterId: target.characterId, chatId: target.chatId };
  /**
   * Expands chat placeholders using the explicit character/chat target.
   *
   * 한국어: 명시한 캐릭터·채팅 대상으로 문맥 텍스트의 치환 구문을 해석하는 함수.
   */
  const parse = (text: string) =>
    risuChatParser(text, { chara: char, chatTarget });
  const context: IllustrationContext = {
    description: settings.includeDescription
      ? parse(
          [char.desc, char.personality, char.scenario]
            .filter(Boolean)
            .join("\n\n"),
        )
      : undefined,
    persona: settings.includePersona
      ? parse(getPersonaPrompt(chatTarget))
      : undefined,
  };
  if (settings.includeLorebook) {
    const scanDepth = Math.max(
      settings.recentMessages,
      char.loreSettings?.scanDepth ?? settingsStore.state.loreBookDepth,
    );
    const history = await readIllustrationHistory(
      storage,
      target.chatId,
      position,
      scanDepth,
    );
    const scene = {
      ...message,
      data: message.data.slice(0, message.data.indexOf(item.token)),
    };
    const { loadLoreBookV3Prompt } = await import("../lorebook.svelte");
    const lore = await loadLoreBookV3Prompt(chatTarget, {
      chat: { ...chat, message: [...history, scene] } as Chat,
      moduleIds: chat.modules,
      chatVariables: safeStructuredClone(
        settingsStore.state.globalChatVariables ?? {},
      ),
      readOnly: true,
    });
    context.lorebook = lore.actives.map((l) => parse(l.prompt)).join("\n\n");
  }
  if (settings.includeMemory) {
    const metadata = await storage.loadChat(target.chatId, { messageLimit: 1 });
    const candidates = [
      ...(metadata?.hypaV3Data?.summaries ?? []),
      ...(metadata?.hypaV2Data?.mainChunks ?? []),
    ];
    const needed = new Set(candidates.flatMap((c) => c.chatMemos));
    const supa = metadata?.supaMemoryData?.split("\n") ?? [];
    // Older HypaMemory keeps cumulative summaries keyed by their last message.
    if (supa[0]?.startsWith("hypa:")) {
      try {
        const legacy = JSON.parse(supa.slice(1).join("\n"));
        if (Array.isArray(legacy))
          for (const summary of legacy) {
            if (
              typeof summary.id === "string" &&
              typeof summary.supa === "string"
            )
              candidates.push({
                chatMemos: [summary.id],
                text: summary.supa,
              } as (typeof candidates)[number]);
          }
      } catch {
        /* A malformed old cache must not trigger memory regeneration. */
      }
    }
    for (const candidate of candidates)
      for (const id of candidate.chatMemos) needed.add(id);
    if (supa[0] && !supa[0].startsWith("hypa:")) needed.add(supa[0]);
    const preceding = new Set<string>();
    let before = position;
    while (needed.size && before > 0) {
      const page = await storage.loadChatMessagePage(target.chatId, before, 50);
      for (const m of page.messages)
        if (needed.delete(m.chatId)) preceding.add(m.chatId);
      if (!page.hasMore || page.offset >= before) break;
      before = page.offset;
    }
    context.memory = candidates
      .filter(
        (c) =>
          c.chatMemos.length && c.chatMemos.every((id) => preceding.has(id)),
      )
      .map((c) => c.text)
      .join("\n\n");
    if (!context.memory && preceding.has(supa[0]))
      context.memory = supa.slice(1).join("\n");
  }
  return context;
}
