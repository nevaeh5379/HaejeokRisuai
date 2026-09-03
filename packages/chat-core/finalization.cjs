"use strict";

const COMPLETION_PUNCTUATION = new Set([
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

function endsWithCompletionPunctuation(text) {
  const lastChar = text.trim().at(-1);
  if (!lastChar) return true;
  const code = lastChar.charCodeAt(0);
  return Boolean(
    COMPLETION_PUNCTUATION.has(lastChar) ||
    (code >= 0x02b0 && code <= 0x02ff) ||
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x0590 && code <= 0x05cf) ||
    (code >= 0x3000 && code <= 0x303f),
  );
}

function decideAutoContinuation(input) {
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

module.exports = { decideAutoContinuation, endsWithCompletionPunctuation };
