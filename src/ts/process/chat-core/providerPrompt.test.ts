import { describe, expect, it } from "vitest";
import { formatProviderMessages } from "@risuai/chat-core/providerPrompt.cjs";
import { LLM_FLAGS } from "../../../../packages/protocol/modelFlags.cjs";

describe("provider prompt formatting", () => {
  it("merges leading system prompts without crashing on system-only input", () => {
    expect(formatProviderMessages(
      [{ role: "system", content: "one" }, { role: "system", content: "two" }],
      [LLM_FLAGS.hasFirstSystemPrompt],
    )).toEqual([{ role: "system", content: "one\n\ntwo" }]);
  });

  it("replaces unsupported system messages with configured role and template", () => {
    expect(formatProviderMessages(
      [{ role: "system", content: "rules" }],
      [],
      { systemContentReplacement: "SYS={{slot}}", systemRoleReplacement: "assistant" },
    )).toEqual([{ role: "assistant", content: "SYS=rules" }]);
  });

  it("merges consecutive roles and preserves attached metadata", () => {
    const result = formatProviderMessages([
      { role: "user", content: "a", cachePoint: false },
      { role: "user", content: "b", thoughts: ["t"], cachePoint: true },
    ], [LLM_FLAGS.hasFullSystemPrompt, LLM_FLAGS.requiresAlternateRole]);
    expect(result).toEqual([{ role: "user", content: "a\nb", thoughts: ["t"], cachePoint: true }]);
  });

  it("inserts a user message when required", () => {
    expect(formatProviderMessages(
      [{ role: "assistant", content: "hello" }],
      [LLM_FLAGS.hasFullSystemPrompt, LLM_FLAGS.mustStartWithUserInput],
    )[0]).toEqual({ role: "user", content: " " });
  });
});
