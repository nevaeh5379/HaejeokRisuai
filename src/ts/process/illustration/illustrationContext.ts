import type {
  Illustration,
  IllustrationContext,
  IllustrationSettings,
  IllustrationTarget,
} from "@risuai/protocol/dist/illustration.mjs";
import { readIllustrationHistory } from "@risuai/protocol/dist/illustrationStorage.mjs";
import type { ISqlStorage } from "../../storage/sql/ISqlStorage";
import type { character, Chat, Message } from "../../storage/database/schema";
import { getPersonaPrompt } from "../../util";
import { risuChatParser } from "../scripts";
import { settingsStore } from "../../stores/domain/settingsStore.svelte";
import { safeStructuredClone } from "../../polyfill";

/** Explicit rewrites use current settings and cached memories ending before this scene. No summarizer is called. */
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
