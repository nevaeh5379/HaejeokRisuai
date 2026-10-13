import { describe, expect, it } from "vitest";
import type { folder } from "./storage/database/schema";
import {
  findSidebarFolder,
  groupSidebarItem,
  moveSidebarItem,
} from "./sidebarOrder";

const makeFolder = (id: string, data: string[]): folder => ({
  id,
  data,
  name: id,
  color: "",
});

describe("sidebar order with missing characters", () => {
  it("moves the displayed character rather than the missing root entry", () => {
    const order = ["missing", "A", "B"];
    expect(moveSidebarItem(order, { id: "B" }, { id: "A" })).toBe(true);
    expect(order).toEqual(["missing", "B", "A"]);
  });

  it("resolves an insertion gap by its anchor ID", () => {
    const order = ["A", "missing", "B", "C"];
    moveSidebarItem(order, { id: "C" }, { id: "B", after: true });
    expect(order).toEqual(["A", "missing", "B", "C"]);
    moveSidebarItem(order, { id: "A" }, { id: "B", after: true });
    expect(order).toEqual(["missing", "B", "A", "C"]);
  });

  it("moves a character out of a folder containing a missing entry", () => {
    const source = makeFolder("F", ["missing", "A", "B"]);
    const order = ["missing-root", source, "C"];
    moveSidebarItem(order, { id: "B", folder: "F" }, {});
    expect(order).toEqual(["B", "missing-root", source, "C"]);
    expect(source.data).toEqual(["missing", "A"]);
  });

  it("reorders folder children and moves between folders without losing siblings", () => {
    const source = makeFolder("F", ["missing", "A", "B"]);
    const target = makeFolder("G", ["missing-target", "C"]);
    const order = [source, target];
    moveSidebarItem(order, { id: "B", folder: "F" }, { id: "A", folder: "F" });
    expect(source.data).toEqual(["missing", "B", "A"]);
    moveSidebarItem(
      order,
      { id: "B", folder: "F" },
      { id: "C", folder: "G", after: true },
    );
    expect(source.data).toEqual(["missing", "A"]);
    expect(target.data).toEqual(["missing-target", "C", "B"]);
  });

  it("moves whole folders by ID despite missing root entries", () => {
    const source = makeFolder("F", ["A"]);
    const order = ["missing", "B", source];
    moveSidebarItem(order, { id: "F" }, { id: "B" });
    expect(order).toEqual(["missing", source, "B"]);
    expect(order[1]).toBe(source);
  });

  it("groups the requested characters, preserving the missing entry", () => {
    const order = ["missing", "A", "B"];
    expect(groupSidebarItem(order, { id: "A" }, { id: "B" })).toBe(true);
    expect(order).toEqual([
      "missing",
      expect.objectContaining({ data: ["A", "B"] }),
    ]);
  });

  it("groups a folder child with a root character", () => {
    const source = makeFolder("F", ["missing", "A"]);
    const order = ["missing-root", source, "B"];
    groupSidebarItem(order, { id: "A", folder: "F" }, { id: "B" });
    expect(source.data).toEqual(["missing"]);
    expect(order).toEqual([
      "missing-root",
      source,
      expect.objectContaining({ data: ["A", "B"] }),
    ]);
  });

  it("adds the character to the identified folder", () => {
    const target = makeFolder("F", ["B"]);
    const order = ["missing", "A", target];
    groupSidebarItem(order, { id: "A" }, { id: "F" });
    expect(order).toEqual(["missing", target]);
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
      const order = ["A", makeFolder("F", ["B"])];
      const before = structuredClone(order);
      expect(moveSidebarItem(order, source, target)).toBe(false);
      expect(order).toEqual(before);
      expect(groupSidebarItem(order, source, target)).toBe(false);
      expect(order).toEqual(before);
    },
  );

  it("moves a child to the end when dropped on its own folder avatar", () => {
    const order = [makeFolder("F", ["A", "B"])];
    expect(groupSidebarItem(order, { id: "A", folder: "F" }, { id: "F" })).toBe(
      true,
    );
    expect(order[0].data).toEqual(["B", "A"]);
  });

  it("resolves the folder again after order changes and ignores a deleted folder", () => {
    const target = makeFolder("F", ["A"]);
    const other = makeFolder("G", ["B"]);
    const order = ["missing", target, other];
    order.reverse();
    const folder = findSidebarFolder(order, "F");
    folder.name = "renamed";
    expect(target.name).toBe("renamed");
    expect(other.name).toBe("G");
    order.splice(order.indexOf(target), 1);
    expect(findSidebarFolder(order, "F")).toBeUndefined();
  });
});
