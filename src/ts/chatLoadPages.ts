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
