export interface RecentChatActivityCharacter {
  chaId?: string;
  trashTime?: number;
  lastInteraction?: number;
  chatPage?: number;
  chats?: readonly { id?: string }[];
}

export interface RecentChatActiveTarget {
  characterId: string;
  chatId: string;
  timestamp: number;
}

function targetForCharacter(
  character: RecentChatActivityCharacter | undefined,
): RecentChatActiveTarget | null {
  if (!character?.chaId || character.trashTime) return null;
  const chat = character.chats?.[character.chatPage ?? 0];
  if (!chat?.id) return null;
  const interaction = Number(character.lastInteraction ?? 0);
  return {
    characterId: character.chaId,
    chatId: chat.id,
    timestamp: Number.isFinite(interaction) ? Math.max(0, interaction) : 0,
  };
}

/**
 * Resolves the one chat allowed to inherit character-level interaction time.
 * The selected character is authoritative while a chat is open. Home clears
 * that selection before recent-session surfaces mount, so they recover the
 * same stable target from the latest in-memory character interaction.
 */
export function resolveRecentChatActiveTarget(
  characters: readonly RecentChatActivityCharacter[],
  selectedIndex = -1,
): RecentChatActiveTarget | null {
  if (selectedIndex >= 0) {
    const selected = targetForCharacter(characters[selectedIndex]);
    if (selected) return selected;
  }

  let latest: RecentChatActiveTarget | null = null;
  for (const character of characters) {
    const candidate = targetForCharacter(character);
    if (!candidate || candidate.timestamp <= 0) continue;
    if (!latest || candidate.timestamp > latest.timestamp) latest = candidate;
  }
  return latest;
}
