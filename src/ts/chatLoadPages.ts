// Keep the low-spec DOM deliberately small: every rendered message owns a
// Svelte component, parsed HTML, event handlers, and potentially decoded media.
export const DEFAULT_CHAT_LOAD_INITIAL_PAGES = 12;
export const DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES = 8;
export const LOW_SPEC_CHAT_LOAD_INITIAL_PAGES = 4;
export const LOW_SPEC_CHAT_LOAD_ADDITIONAL_PAGES = 6;

export function normalizeChatLoadPages(
  value: unknown,
  fallback: number,
): number {
  const fallbackValue =
    Number.isFinite(fallback) && fallback >= 1 ? Math.floor(fallback) : 1;
  const numberValue = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numberValue) || numberValue < 1) {
    return fallbackValue;
  }

  return Math.floor(numberValue);
}

export function getInitialChatLoadPages(db: {
  chatLoadInitialPages?: number;
  lowSpecMode?: boolean;
}): number {
  if (db.lowSpecMode) return LOW_SPEC_CHAT_LOAD_INITIAL_PAGES;
  return normalizeChatLoadPages(
    db.chatLoadInitialPages,
    DEFAULT_CHAT_LOAD_INITIAL_PAGES,
  );
}

export function getAdditionalChatLoadPages(db: {
  chatLoadAdditionalPages?: number;
  lowSpecMode?: boolean;
}): number {
  if (db.lowSpecMode) return LOW_SPEC_CHAT_LOAD_ADDITIONAL_PAGES;
  return normalizeChatLoadPages(
    db.chatLoadAdditionalPages,
    DEFAULT_CHAT_LOAD_ADDITIONAL_PAGES,
  );
}
/**
 * Converts an index in a partially hydrated message array into the stable
 * full-chat index used by CBS/Lua APIs. UI mutations should keep using the
 * local array index; script-visible indexes must include messageOffset.
 */
export function getAbsoluteChatMessageIndex(
  localIndex: number,
  messageOffset: number | undefined,
): number {
  if (localIndex < 0) return localIndex;
  const offset =
    Number.isSafeInteger(messageOffset) && (messageOffset ?? 0) > 0
      ? messageOffset!
      : 0;
  return offset + localIndex;
}
