'use strict';

function decideAutoContinuation(input) {
  const belowMinimum = input.minimumTokens > 0 && input.resultTokens < input.minimumTokens;
  if (belowMinimum) {
    return {
      shouldContinue: true,
      resultTokens: input.resultTokens,
      reason: 'minimum-tokens',
    };
  }

  if (input.continueIncomplete && !input.endsWithPunctuation) {
    return {
      shouldContinue: true,
      resultTokens: input.resultTokens,
      reason: 'incomplete',
    };
  }

  return {
    shouldContinue: false,
    resultTokens: input.resultTokens,
    reason: null,
  };
}

module.exports = { decideAutoContinuation };
