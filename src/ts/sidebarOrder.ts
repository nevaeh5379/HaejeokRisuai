import { v4 } from "uuid";
import type { folder } from "./storage/database/schema";

type CharacterOrder = (string | folder)[];

export interface SidebarDragItem {
  id: string;
  folder?: string;
}

export interface SidebarDropPosition {
  id?: string;
  folder?: string;
  after?: boolean;
}

export function findSidebarFolder(order: CharacterOrder, id: string) {
  return order.find(
    (item): item is folder => typeof item !== "string" && item.id === id,
  );
}

function resolvePosition(order: CharacterOrder, position: SidebarDropPosition) {
  const items = position.folder
    ? findSidebarFolder(order, position.folder)?.data
    : order;
  if (!items) return;
  const index =
    position.id === undefined
      ? 0
      : items.findIndex(
          (item) => (typeof item === "string" ? item : item.id) === position.id,
        );
  if (index < 0) return;
  return { items, index };
}

export function moveSidebarItem(
  order: CharacterOrder,
  source: SidebarDragItem,
  target: SidebarDropPosition,
) {
  const from = resolvePosition(order, source);
  const to = resolvePosition(order, target);
  if (!from || !to) return false;
  const item = from.items[from.index];
  if (typeof item !== "string" && target.folder) return false;

  let insertionIndex = to.index + (target.after ? 1 : 0);
  if (from.items === to.items && from.index < insertionIndex) insertionIndex--;
  if (from.items === to.items && from.index === insertionIndex) return false;

  from.items.splice(from.index, 1);
  to.items.splice(insertionIndex, 0, item);
  return true;
}

export function groupSidebarItem(
  order: CharacterOrder,
  source: SidebarDragItem,
  target: SidebarDragItem,
) {
  if (target.folder || source.id === target.id) return false;
  const from = resolvePosition(order, source);
  const to = resolvePosition(order, target);
  if (!from || !to) return false;
  const item = from.items[from.index];
  const destination = to.items[to.index];
  if (typeof item !== "string") return false;

  if (typeof destination === "string") {
    to.items[to.index] = {
      name: "New Folder",
      data: [item, destination],
      color: "",
      id: v4(),
    };
  } else {
    destination.data.push(item);
  }
  from.items.splice(from.index, 1);
  return true;
}
