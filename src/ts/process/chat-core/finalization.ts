export interface AutoContinuationPolicyInput {
  resultTokens: number;
  minimumTokens: number;
  continueIncomplete: boolean;
  endsWithPunctuation: boolean;
}

export interface AutoContinuationDecision {
  shouldContinue: boolean;
  resultTokens: number;
  reason: "minimum-tokens" | "incomplete" | null;
}

export function decideAutoContinuation(
  input: AutoContinuationPolicyInput,
): AutoContinuationDecision {
  const belowMinimum =
    input.minimumTokens > 0 && input.resultTokens < input.minimumTokens;
  if (belowMinimum) {
    return {
      shouldContinue: true,
      resultTokens: input.resultTokens,
      reason: "minimum-tokens",
    };
  }

  if (input.continueIncomplete && !input.endsWithPunctuation) {
    return {
      shouldContinue: true,
      resultTokens: input.resultTokens,
      reason: "incomplete",
    };
  }

  return {
    shouldContinue: false,
    resultTokens: input.resultTokens,
    reason: null,
  };
}
