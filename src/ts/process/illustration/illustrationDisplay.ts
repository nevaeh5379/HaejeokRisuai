import {
  findIllustrationMarkers,
  type Illustration,
} from "@risuai/protocol/src/illustration.ts";

const MARKER_LEN = "<Illustration>".length;

/** Keeps each narrative position stable from an unprepared marker through every generated image. */
export function illustrationDisplayLayout(
  text = "",
  illustrations: Illustration[] = [],
) {
  const slots: { position: number; length: number; id?: string }[] = [];
  if (text.includes("<Illustration>")) {
    const markers = findIllustrationMarkers(text);
    for (let i = 0; i < markers.length; i++) {
      slots.push({ position: markers[i], length: MARKER_LEN });
    }
  }
  for (let i = 0; i < illustrations.length; i++) {
    const item = illustrations[i];
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
  const bindings: { id: string; index: number }[] = [];
  for (let index = 0; index < slots.length; index++) {
    const slot = slots[index];
    if (slot.id) {
      bindings.push({ id: slot.id, index });
    }
  }
  return {
    display,
    bindings: JSON.stringify(bindings),
  };
}
