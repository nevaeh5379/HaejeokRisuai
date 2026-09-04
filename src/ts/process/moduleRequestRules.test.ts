import { describe, expect, it } from "vitest";
import {
  matchesModuleRequestRule,
  resolveModuleRequestRules,
  type ModuleRequestRule,
} from "./moduleRequestRules";

const rule: ModuleRequestRule = {
  enabled: true,
  phrases: ["weather", "format"],
};
const modules = [
  { id: "a", name: "A", subModel: "model-a", subModelRequestRules: [rule] },
];
describe("module request rules", () => {
  it("requires every literal phrase in the same message", () => {
    expect(
      matchesModuleRequestRule(rule, [
        { role: "user", content: "weather format" },
      ]),
    ).toBe(true);
    expect(
      matchesModuleRequestRule(rule, [
        { role: "user", content: "weather" },
        { role: "user", content: "format" },
      ]),
    ).toBe(false);
    expect(
      matchesModuleRequestRule(rule, [
        { role: "user", content: "Weather format" },
      ]),
    ).toBe(false);
    expect(
      matchesModuleRequestRule({ ...rule, phrases: ["[a.*]"] }, [
        { role: "user", content: "[a.*]" },
      ]),
    ).toBe(true);
  });
  it("restricts source, role and optional tail without confusing role-relative positions", () => {
    const messages = [
      { role: "user", content: "weather format" },
      { role: "assistant", content: "ok" },
    ];
    expect(
      matchesModuleRequestRule(
        { ...rule, sourceModuleId: "backend" },
        messages,
        "other",
      ),
    ).toBe(false);
    expect(
      matchesModuleRequestRule(
        { ...rule, sourceModuleId: "backend" },
        messages,
      ),
    ).toBe(false);
    expect(
      matchesModuleRequestRule({ ...rule, role: "assistant" }, messages),
    ).toBe(false);
    expect(
      matchesModuleRequestRule({ ...rule, lastMessages: 1 }, messages),
    ).toBe(false);
    expect(
      matchesModuleRequestRule(
        { ...rule, lastMessages: 2, role: "user", sourceModuleId: "backend" },
        messages,
        "backend",
      ),
    ).toBe(true);
  });
  it.each([
    null,
    {},
    { ...rule, enabled: false },
    { ...rule, phrases: [] },
    { ...rule, phrases: [""] },
    { ...rule, phrases: [" "] },
    { ...rule, phrases: [12] },
    { ...rule, lastMessages: 0 },
    { ...rule, lastMessages: -1 },
    { ...rule, lastMessages: 1.5 },
  ])("ignores disabled or malformed rules: %j", (value) => {
    expect(
      matchesModuleRequestRule(value as ModuleRequestRule, [
        { role: "user", content: "weather format" },
      ]),
    ).toBe(false);
  });
  it("selects one owner, deduplicates its rules, and preserves fallback on conflicts", () => {
    const messages = [{ role: "user", content: "weather format" }];
    expect(
      resolveModuleRequestRules(
        [{ ...modules[0], subModelRequestRules: [rule, rule] }],
        messages,
      ),
    ).toMatchObject({ status: "matched", model: "model-a" });
    expect(
      resolveModuleRequestRules(
        [...modules, { ...modules[0], id: "b" }],
        messages,
      ),
    ).toMatchObject({ status: "conflict", model: undefined });
    expect(
      resolveModuleRequestRules(
        [{ ...modules[0], subModel: undefined }],
        messages,
      ).status,
    ).toBe("unmatched");
    expect(resolveModuleRequestRules(modules, []).status).toBe("unmatched");
  });
});
