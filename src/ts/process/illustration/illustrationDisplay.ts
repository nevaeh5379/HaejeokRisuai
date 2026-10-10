import {
  findIllustrationMarkers,
  type Illustration,
} from "@risuai/protocol/src/illustration.ts";

/** Keeps each narrative position stable from an unprepared marker through every generated image. */
export function illustrationDisplayLayout(
  text = "",
  illustrations: Illustration[] = [],
) {
  const slots: { position: number; length: number; id?: string }[] = (
    text.includes("<Illustration>") ? findIllustrationMarkers(text) : []
  ).map((position) => ({ position, length: "<Illustration>".length }));
  for (const item of illustrations) {
    if (!/^[\w-]+$/.test(item.id) || !item.token) continue;
    const position = text.indexOf(item.token);
    if (position >= 0)
      slots.push({ position, length: item.token.length, id: item.id });
  }
  slots.sort((a, b) => a.position - b.position);
  let display = text;
  for (let index = slots.length - 1; index >= 0; index--) {
    const slot = slots[index];
    display =
      display.slice(0, slot.position) +
      `<span data-risu-illustration="${index}"></span>` +
      display.slice(slot.position + slot.length);
  }
  return {
    display,
    bindings: JSON.stringify(
      slots.flatMap((slot, index) => (slot.id ? [{ id: slot.id, index }] : [])),
    ),
  };
}
