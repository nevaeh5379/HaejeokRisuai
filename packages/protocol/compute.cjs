"use strict";

const TOKENIZER_ENCODINGS = Object.freeze(["cl100k_base", "o200k_base"]);
const VECTOR_SEARCH_METRICS = Object.freeze(["cosine", "dot"]);

module.exports = {
  TOKENIZER_ENCODINGS,
  VECTOR_SEARCH_METRICS,
};
