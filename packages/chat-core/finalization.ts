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
("use strict");

const COMPLETION_PUNCTUATION: any = new Set([
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

function endsWithCompletionPunctuation(text: string): boolean;
function endsWithCompletionPunctuation(text?: any): any {
  const lastChar: any = text.trim().at(-1);
  if (!lastChar) return true;
  const code: any = lastChar.charCodeAt(0);
  return Boolean(
    COMPLETION_PUNCTUATION.has(lastChar) ||
    (code >= 0x02b0 && code <= 0x02ff) ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0590 && code <= 0x05cf) ||
    (code >= 0x3000 && code <= 0x303f),
  );
}

function decideAutoContinuation(
  input: AutoContinuationPolicyInput,
): AutoContinuationDecision;
function decideAutoContinuation(input?: any): any {
  const belowMinimum: any =
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
