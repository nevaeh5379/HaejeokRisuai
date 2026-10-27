export const LLM_TOKENIZER = {
  Unknown: 0,
  tiktokenCl100kBase: 1,
  tiktokenO200Base: 2,
  Mistral: 3,
  Llama: 4,
  NovelAI: 5,
  Claude: 6,
  NovelList: 7,
  Llama3: 8,
  Gemma: 9,
  GoogleCloud: 10,
  Cohere: 11,
  Local: 12,
  DeepSeek: 13,
  DeepSeekV4: 14,
  GLM4: 15,
  GLM5: 16,
} as const;
export type LLMTokenizer = (typeof LLM_TOKENIZER)[keyof typeof LLM_TOKENIZER];

export type LLMTokenizerValue = (typeof LLM_TOKENIZER)[keyof typeof LLM_TOKENIZER];
