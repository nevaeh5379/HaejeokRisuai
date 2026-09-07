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
  it("ignores blank editing lines without making an empty rule match", () => {
    expect(
      matchesModuleRequestRule(
        { enabled: true, phrases: ["weather", "", " "] },
        [{ role: "user", content: "weather" }],
      ),
    ).toBe(true);
  });
  it("requires every literal phrase in the same message when matchMode is all", () => {
    const allRule: ModuleRequestRule = { ...rule, matchMode: "all" };
    expect(
      matchesModuleRequestRule(allRule, [
        { role: "user", content: "weather format" },
      ]),
    ).toBe(true);
    expect(
      matchesModuleRequestRule(allRule, [
        { role: "user", content: "weather" },
        { role: "user", content: "format" },
      ]),
    ).toBe(false);
    expect(
      matchesModuleRequestRule(allRule, [
        { role: "user", content: "Weather format" },
      ]),
    ).toBe(false);
    expect(
      matchesModuleRequestRule({ ...allRule, phrases: ["[a.*]"] }, [
        { role: "user", content: "[a.*]" },
      ]),
    ).toBe(true);
  });
  it("matches any phrase by default and trims whitespace", () => {
    expect(
      matchesModuleRequestRule(rule, [
        { role: "user", content: "weather only" },
      ]),
    ).toBe(true);
    expect(
      matchesModuleRequestRule(
        { enabled: true, phrases: [" weather ", "format\r"] },
        [{ role: "user", content: "weather only" }],
      ),
    ).toBe(true);
  });
  it("matches all phrases across the request when matchMode is all_request", () => {
    const requestRule: ModuleRequestRule = { ...rule, matchMode: "all_request" };
    expect(
      matchesModuleRequestRule(requestRule, [
        { role: "system", content: "weather header" },
        { role: "user", content: "output format" },
      ]),
    ).toBe(true);
    expect(
      matchesModuleRequestRule(requestRule, [
        { role: "system", content: "weather header" },
        { role: "user", content: "other content" },
      ]),
    ).toBe(false);
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
  it("forgives mistakenly selecting the module itself as sourceModuleId", () => {
    const messages = [{ role: "user", content: "weather" }];
    const selfSourceModule = {
      id: "a",
      name: "A",
      subModel: "model-a",
      subModelRequestRules: [{ enabled: true, phrases: ["weather"], sourceModuleId: "a" }],
    };
    expect(
      resolveModuleRequestRules([selfSourceModule], messages, "backend"),
    ).toMatchObject({ status: "matched", model: "model-a" });
  });
  it("resolves conflicts in favor of the more specific (longer) matched phrase", () => {
    const messages = [{ role: "user", content: "detailed weather report" }];
    const genericModule = {
      id: "generic",
      name: "Generic",
      subModel: "generic-model",
      subModelRequestRules: [{ enabled: true, phrases: ["weather"] }],
    };
    const specificModule = {
      id: "specific",
      name: "Specific",
      subModel: "specific-model",
      subModelRequestRules: [{ enabled: true, phrases: ["detailed weather"] }],
    };
    expect(
      resolveModuleRequestRules([genericModule, specificModule], messages),
    ).toMatchObject({ status: "matched", model: "specific-model" });
  });
});
