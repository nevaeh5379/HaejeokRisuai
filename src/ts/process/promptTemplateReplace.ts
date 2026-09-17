import type { PromptItem } from "./prompt";

/**
 * Replace one prompt card with another inside the caller's own template array.
 *
 * Mutates `template` in place (matching the editor's existing behavior) and is
 * deliberately free of store access: the ordinary Prompt Settings page passes
 * `presetStore.state.promptTemplate`, while Risu Agent passes its own draft.
 * Keeping the owner explicit is what stops the agent editor from rewriting the
 * ordinary preset.
 *
 * No-op when the card is unchanged; when an equal card already exists it is
 * removed first so the list cannot gain duplicates.
 */
export function replacePromptItem(
  template: PromptItem[],
  current: PromptItem,
  next: PromptItem,
): void {
  if (JSON.stringify(current) === JSON.stringify(next)) return;

  const existingIndex = template.findIndex(
    (item) => JSON.stringify(item) === JSON.stringify(next),
  );
  if (existingIndex !== -1) {
    template.splice(existingIndex, 1);
  }

  const currentIndex = template.findIndex(
    (item) => JSON.stringify(item) === JSON.stringify(current),
  );
  if (currentIndex === -1) return;
  template.splice(currentIndex, 0, next);
}
