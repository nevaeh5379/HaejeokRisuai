import { v4 } from "uuid";
import type { folder } from "@risuai/protocol/domain/database.ts";

type CharacterOrder = (string | folder)[];

export interface DragItem {
  id: string;
  folder?: string;
}

export interface DropPosition {
  id?: string;
  folder?: string;
  after?: boolean;
}

export class Order {
  constructor(private readonly items: CharacterOrder) {}

  findFolder(id: string) {
    return this.items.find(
      (item): item is folder => typeof item !== "string" && item.id === id,
    );
  }

  private resolvePosition(position: DropPosition) {
    const items = position.folder
      ? this.findFolder(position.folder)?.data
      : this.items;
    if (!items) return;
    const index =
      position.id === undefined
        ? 0
        : items.findIndex(
            (item) =>
              (typeof item === "string" ? item : item.id) === position.id,
          );
    if (index < 0) return;
    return { items, index };
  }

  move(source: DragItem, target: DropPosition) {
    const from = this.resolvePosition(source);
    const to = this.resolvePosition(target);
    if (!from || !to) return false;
    const item = from.items[from.index];
    if (typeof item !== "string" && target.folder) return false;

    let insertionIndex = to.index + (target.after ? 1 : 0);
    if (from.items === to.items && from.index < insertionIndex)
      insertionIndex--;
    if (from.items === to.items && from.index === insertionIndex) return false;

    from.items.splice(from.index, 1);
    to.items.splice(insertionIndex, 0, item);
    return true;
  }

  group(source: DragItem, target: DragItem) {
    if (target.folder || source.id === target.id) return false;
    const from = this.resolvePosition(source);
    const to = this.resolvePosition(target);
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
}
