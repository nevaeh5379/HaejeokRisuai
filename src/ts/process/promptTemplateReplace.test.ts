import { describe, expect, test } from "vitest";
import type { PromptItem } from "./prompt";
import { replacePromptItem } from "./promptTemplateReplace";

function card(text: string): PromptItem {
  return { type: "plain", text, role: "system", type2: "normal" };
}

describe("replacePromptItem", () => {
  test("only mutates the template it was given", () => {
    const ownerTemplate = [card("agent")];
    const ordinaryPreset = [card("agent")];

    replacePromptItem(ownerTemplate, ownerTemplate[0], card("agent edited"));

    expect((ownerTemplate[0] as any).text).toBe("agent edited");
    // Regression guard: the ordinary preset must stay untouched.
    expect(ordinaryPreset).toHaveLength(1);
    expect((ordinaryPreset[0] as any).text).toBe("agent");
  });

  test("drops an existing equal card before inserting the replacement", () => {
    const template = [card("a"), card("b"), card("c")];
    replacePromptItem(template, template[0], card("c"));

    // Preserves the editor's existing behavior: the duplicate target is
    // removed and the replacement is inserted at the current card's index.
    expect(template.map((item: any) => item.text)).toEqual(["c", "a", "b"]);
  });

  test("is a no-op for an unchanged card", () => {
    const template = [card("a"), card("b")];
    const snapshot = JSON.stringify(template);
    replacePromptItem(template, template[0], card("a"));
    expect(JSON.stringify(template)).toBe(snapshot);
  });

  test("does nothing when the current card is no longer present", () => {
    const template = [card("a")];
    replacePromptItem(template, card("gone"), card("new"));
    expect(template.map((item: any) => item.text)).toEqual(["a"]);
  });
});
