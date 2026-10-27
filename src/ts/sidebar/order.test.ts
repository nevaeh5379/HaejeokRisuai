import { describe, expect, it } from "vitest";
import type { folder } from "@risuai/protocol/domain/database.ts";
import { Order } from "./order";

const makeFolder = (id: string, data: string[]): folder => ({
  id,
  data,
  name: id,
  color: "",
});

describe("sidebar order with missing characters", () => {
  it("moves the displayed character rather than the missing root entry", () => {
    const items = ["missing", "A", "B"];
    const order = new Order(items);
    expect(order.move({ id: "B" }, { id: "A" })).toBe(true);
    expect(items).toEqual(["missing", "B", "A"]);
  });

  it("resolves an insertion gap by its anchor ID", () => {
    const items = ["A", "missing", "B", "C"];
    const order = new Order(items);
    order.move({ id: "C" }, { id: "B", after: true });
    expect(items).toEqual(["A", "missing", "B", "C"]);
    order.move({ id: "A" }, { id: "B", after: true });
    expect(items).toEqual(["missing", "B", "A", "C"]);
  });

  it("moves a character out of a folder containing a missing entry", () => {
    const source = makeFolder("F", ["missing", "A", "B"]);
    const items = ["missing-root", source, "C"];
    const order = new Order(items);
    order.move({ id: "B", folder: "F" }, {});
    expect(items).toEqual(["B", "missing-root", source, "C"]);
    expect(source.data).toEqual(["missing", "A"]);
  });

  it("reorders folder children and moves between folders without losing siblings", () => {
    const source = makeFolder("F", ["missing", "A", "B"]);
    const target = makeFolder("G", ["missing-target", "C"]);
    const items = [source, target];
    const order = new Order(items);
    order.move({ id: "B", folder: "F" }, { id: "A", folder: "F" });
    expect(source.data).toEqual(["missing", "B", "A"]);
    order.move({ id: "B", folder: "F" }, { id: "C", folder: "G", after: true });
    expect(source.data).toEqual(["missing", "A"]);
    expect(target.data).toEqual(["missing-target", "C", "B"]);
  });

  it("moves whole folders by ID despite missing root entries", () => {
    const source = makeFolder("F", ["A"]);
    const items = ["missing", "B", source];
    const order = new Order(items);
    order.move({ id: "F" }, { id: "B" });
    expect(items).toEqual(["missing", source, "B"]);
    expect(items[1]).toBe(source);
  });

  it("groups the requested characters, preserving the missing entry", () => {
    const items = ["missing", "A", "B"];
    const order = new Order(items);
    expect(order.group({ id: "A" }, { id: "B" })).toBe(true);
    expect(items).toEqual([
      "missing",
      expect.objectContaining({ data: ["A", "B"] }),
    ]);
  });

  it("groups a folder child with a root character", () => {
    const source = makeFolder("F", ["missing", "A"]);
    const items = ["missing-root", source, "B"];
    const order = new Order(items);
    order.group({ id: "A", folder: "F" }, { id: "B" });
    expect(source.data).toEqual(["missing"]);
    expect(items).toEqual([
      "missing-root",
      source,
      expect.objectContaining({ data: ["A", "B"] }),
    ]);
  });

  it("adds the character to the identified folder", () => {
    const target = makeFolder("F", ["B"]);
    const items = ["missing", "A", target];
    const order = new Order(items);
    order.group({ id: "A" }, { id: "F" });
    expect(items).toEqual(["missing", target]);
    expect(target.data).toEqual(["B", "A"]);
  });

  it.each([
    [{ id: "A", folder: "deleted" }, { id: "B" }],
    [{ id: "deleted" }, { id: "B" }],
    [{ id: "A" }, { id: "deleted" }],
    [{ id: "A" }, { id: "B", folder: "deleted" }],
    [{ id: "F" }, { id: "B", folder: "F" }],
    [{ id: "A" }, { id: "A" }],
  ])(
    "leaves the entire order intact for invalid or self drops (%j, %j)",
    (source, target) => {
      const items = ["A", makeFolder("F", ["B"])];
      const order = new Order(items);
      const before = structuredClone(items);
      expect(order.move(source, target)).toBe(false);
      expect(items).toEqual(before);
      expect(order.group(source, target)).toBe(false);
      expect(items).toEqual(before);
    },
  );

  it("moves a child to the end when dropped on its own folder avatar", () => {
    const items = [makeFolder("F", ["A", "B"])];
    const order = new Order(items);
    expect(order.group({ id: "A", folder: "F" }, { id: "F" })).toBe(true);
    expect(items[0].data).toEqual(["B", "A"]);
  });

  it("resolves the folder again after order changes and ignores a deleted folder", () => {
    const target = makeFolder("F", ["A"]);
    const other = makeFolder("G", ["B"]);
    const items = ["missing", target, other];
    const order = new Order(items);
    items.reverse();
    const folder = order.findFolder("F");
    folder.name = "renamed";
    expect(target.name).toBe("renamed");
    expect(other.name).toBe("G");
    items.splice(items.indexOf(target), 1);
    expect(order.findFolder("F")).toBeUndefined();
  });
});
