Gemma 3 tokenizer source
========================

Source: https://raw.githubusercontent.com/google/gemma_pytorch/014acb7ac4563a5f77c76d7ff98f31b568c16508/tokenizer/gemma3_cleaned_262144_v2.spiece.model

This is the SentencePiece vocabulary (262,144 pieces) that Google's own SDK
uses for local Gemini/Gemma token counting, so counting with it matches the
`countTokens` endpoint far more closely than the Gemma 1/2 vocabulary
(+14% Korean, -3%/-5% Chinese/Japanese) or the Llama 3 BPE file that was
wired in by mistake.

Size: 4,689,074 bytes
SHA-256: 1299c11d7cf632ef3b4e11937501358ada021bbdf7c47638d13c0ee982f2e79c

The file is unmodified. Gemma vocabularies are distributed under the Gemma
Terms of Use.
