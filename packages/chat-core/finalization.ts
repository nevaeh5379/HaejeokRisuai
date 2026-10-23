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

const COMPLETION_PUNCTUATION: ReadonlySet<string> = new Set([
  ".",
  "!",
  "?",
  "。",
  "！",
  "？",
  "…",
  "@",
  "#",
  "$",
  "%",
  "^",
  "&",
  "*",
  "(",
  ")",
  "-",
  "_",
  "+",
  "=",
  "{",
  "}",
  "[",
  "]",
  "|",
  "\\",
  ":",
  ";",
  "<",
  ">",
  ",",
  "/",
  "~",
  "`",
  " ",
  "¡",
  "¿",
  "‽",
  "⁉",
  "'",
  '"',
]);

function endsWithCompletionPunctuation(text: string): boolean {
  if (!text) return true;
  let idx = text.length - 1;
  while (idx >= 0 && /\s/.test(text[idx])) {
    idx--;
  }
  if (idx < 0) return true;
  const lastChar = text[idx];
  const code = text.charCodeAt(idx);
  return (
    COMPLETION_PUNCTUATION.has(lastChar) ||
    (code >= 0x02b0 && code <= 0x02ff) ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0590 && code <= 0x05cf) ||
    (code >= 0x3000 && code <= 0x303f)
  );
}

function decideAutoContinuation(
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

export { decideAutoContinuation, endsWithCompletionPunctuation };
