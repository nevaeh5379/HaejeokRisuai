import { describe, expect, it } from "vitest";
import {
  decideAutoContinuation,
  endsWithCompletionPunctuation,
} from "@risuai/chat-core/finalization.cjs";

describe("decideAutoContinuation", () => {
  it("continues when the generated token count is below the configured minimum", () => {
    expect(
      decideAutoContinuation({
        resultTokens: 40,
        minimumTokens: 50,
        continueIncomplete: false,
        endsWithPunctuation: true,
      }),
    ).toEqual({
      shouldContinue: true,
      resultTokens: 40,
      reason: "minimum-tokens",
    });
  });

  it("continues incomplete text when that policy is enabled", () => {
    expect(
      decideAutoContinuation({
        resultTokens: 80,
        minimumTokens: 50,
        continueIncomplete: true,
        endsWithPunctuation: false,
      }).reason,
    ).toBe("incomplete");
  });

  it("stops when neither continuation rule applies", () => {
    expect(
      decideAutoContinuation({
        resultTokens: 80,
        minimumTokens: 50,
        continueIncomplete: true,
        endsWithPunctuation: true,
      }).shouldContinue,
    ).toBe(false);
  });

  it("prioritizes the minimum-token reason when both rules apply", () => {
    expect(
      decideAutoContinuation({
        resultTokens: 10,
        minimumTokens: 50,
        continueIncomplete: true,
        endsWithPunctuation: false,
      }).reason,
    ).toBe("minimum-tokens");
  });
});


describe("completion punctuation", () => {
  it("preserves the legacy completion character rules", () => {
    expect(endsWithCompletionPunctuation("finished.")).toBe(true);
    expect(endsWithCompletionPunctuation("끝났사와요！")).toBe(true);
    expect(endsWithCompletionPunctuation("unfinished")).toBe(false);
    expect(endsWithCompletionPunctuation("   ")).toBe(true);
    expect(endsWithCompletionPunctuation("word、")).toBe(true);
  });
});
