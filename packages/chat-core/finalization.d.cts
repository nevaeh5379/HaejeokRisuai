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
): AutoContinuationDecision;

export function endsWithCompletionPunctuation(text: string): boolean;
