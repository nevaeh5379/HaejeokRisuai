/**
 * Tokenizer routing tables.
 *
 * 한국어: 설정값·플러그인·모델이 지정한 토크나이저 이름을 실제 어휘/로더로 연결하는 순수 매핑 테이블.
 *
 * Keeping every mapping in one place is what prevents the settings value, the model
 * declaration and the vendored vocabulary file from drifting apart.
 */
import { LLMTokenizer } from "./model/types.ts";

/** Ids of the vocabularies vendored under `public/token/`. */
export type WebTokenizerTarget =
  | "claude"
  | "cohere"
  | "DeepSeek"
  | "DeepSeekV4"
  | "GLM4"
  | "GLM5"
  | "gemma"
  | "llama"
  | "llama3"
  | "mistral"
  | "novelai"
  | "novellist";

export type TiktokenEncodingName = "cl100k_base" | "o200k_base";

export type TokenizeRoute =
  /** A vocabulary file served from the app's own static assets. */
  | { kind: "web"; target: WebTokenizerTarget }
  /** A tiktoken (BPE) encoding evaluated in the browser or delegated to the server. */
  | { kind: "tiktoken"; encoding: TiktokenEncodingName }
  /** The vocabulary embedded in the loaded GGUF model. */
  | { kind: "gguf" }
  /** Google's own `countTokens` endpoint. */
  | { kind: "googleCloud" }
  /** A tokenizer function supplied by a custom provider plugin. */
  | { kind: "plugin" };

/**
 * Vocabulary files and the loader each one needs.
 *
 * `gemma` points at the Gemma 3 SentencePiece model: Gemini reports the same token
 * counts with that vocabulary, while the Gemma 1/2 file over-counts Korean by ~14%
 * and under-counts Chinese/Japanese, and the Llama 3 BPE file is not Gemma at all.
 */
export const webTokenizerSources: Record<
  WebTokenizerTarget,
  { loader: "json" | "sentencePiece"; path: string }
> = {
  claude: { loader: "json", path: "/token/claude/claude.json" },
  cohere: { loader: "json", path: "/token/cohere/tokenizer.json" },
  DeepSeek: { loader: "json", path: "/token/deepseek/tokenizer.json" },
  DeepSeekV4: { loader: "json", path: "/token/deepseek/v4/tokenizer.json" },
  GLM4: { loader: "json", path: "/token/glm4/tokenizer.json" },
  GLM5: { loader: "json", path: "/token/glm5/tokenizer.json" },
  gemma: { loader: "sentencePiece", path: "/token/gemma3/tokenizer.model" },
  llama: { loader: "sentencePiece", path: "/token/llama/llama.model" },
  llama3: { loader: "json", path: "/token/llama/llama3.json" },
  mistral: { loader: "sentencePiece", path: "/token/mistral/tokenizer.model" },
  novelai: { loader: "sentencePiece", path: "/token/nai/nerdstash_v2.model" },
  novellist: { loader: "sentencePiece", path: "/token/trin/spiece.model" },
};

export const DEFAULT_TIKTOKEN_ROUTE: TokenizeRoute = {
  kind: "tiktoken",
  encoding: "o200k_base",
};

/** Used when nothing at all is selected, matching the historical cl100k default. */
export const FALLBACK_TIKTOKEN_ROUTE: TokenizeRoute = {
  kind: "tiktoken",
  encoding: "cl100k_base",
};

/** Tokenizer function provided by the active custom provider plugin. */
export const PLUGIN_TOKENIZER_ROUTE: TokenizeRoute = { kind: "plugin" };

const WEB_ROUTE = (target: WebTokenizerTarget): TokenizeRoute => ({
  kind: "web",
  target,
});

/**
 * Tokenizer ids a user can select: `settings.customTokenizer` (openrouter / reverse
 * proxy), the tokenizer name a provider plugin declares, and the playground picker.
 *
 * The bare "tik" (tiktoken) id is deliberately absent: it has no fixed vocabulary, so
 * it resolves to the caller's tiktoken default — o200k for provider settings (which is
 * also what the Node server counts with) and cl100k for the playground picker.
 */
export const namedTokenizerRoutes: Record<string, TokenizeRoute> = {
  mistral: WEB_ROUTE("mistral"),
  novelai: WEB_ROUTE("novelai"),
  claude: WEB_ROUTE("claude"),
  llama: WEB_ROUTE("llama"),
  // Llama 3 is a 128k tiktoken BPE model; it must not fall back to the 32k
  // Llama 1/2 SentencePiece vocabulary, which inflates CJK counts 1.5x-3x.
  llama3: WEB_ROUTE("llama3"),
  novellist: WEB_ROUTE("novellist"),
  gemma: WEB_ROUTE("gemma"),
  cohere: WEB_ROUTE("cohere"),
  deepseek: WEB_ROUTE("DeepSeek"),
  "deepseek-v4": WEB_ROUTE("DeepSeekV4"),
  glm4: WEB_ROUTE("GLM4"),
  glm5: WEB_ROUTE("GLM5"),
  // Provider plugins may declare a tiktoken encoding instead of a tokenizer id.
  cl100k_base: { kind: "tiktoken", encoding: "cl100k_base" },
  o200k_base: DEFAULT_TIKTOKEN_ROUTE,
};

/** Tokenizers the model list declares, used when no user or plugin override applies. */
export const modelTokenizerRoutes: Record<LLMTokenizer, TokenizeRoute> = {
  [LLMTokenizer.Unknown]: FALLBACK_TIKTOKEN_ROUTE,
  [LLMTokenizer.tiktokenCl100kBase]: {
    kind: "tiktoken",
    encoding: "cl100k_base",
  },
  [LLMTokenizer.tiktokenO200Base]: DEFAULT_TIKTOKEN_ROUTE,
  [LLMTokenizer.Mistral]: WEB_ROUTE("mistral"),
  [LLMTokenizer.Llama]: WEB_ROUTE("llama"),
  [LLMTokenizer.Llama3]: WEB_ROUTE("llama3"),
  [LLMTokenizer.NovelAI]: WEB_ROUTE("novelai"),
  [LLMTokenizer.Claude]: WEB_ROUTE("claude"),
  [LLMTokenizer.NovelList]: WEB_ROUTE("novellist"),
  [LLMTokenizer.Gemma]: WEB_ROUTE("gemma"),
  [LLMTokenizer.GoogleCloud]: { kind: "googleCloud" },
  [LLMTokenizer.Cohere]: WEB_ROUTE("cohere"),
  [LLMTokenizer.Local]: { kind: "gguf" },
  [LLMTokenizer.DeepSeek]: WEB_ROUTE("DeepSeek"),
  [LLMTokenizer.DeepSeekV4]: WEB_ROUTE("DeepSeekV4"),
  [LLMTokenizer.GLM4]: WEB_ROUTE("GLM4"),
  [LLMTokenizer.GLM5]: WEB_ROUTE("GLM5"),
};

/**
 * Selected tokenizer ids the Node server cannot count with tiktoken, so token
 * accounting has to stay in the browser. Derived from the route table by design.
 */
export const nonTiktokenNamedRoutes: ReadonlySet<string> = new Set(
  Object.keys(namedTokenizerRoutes).filter(
    (name) => namedTokenizerRoutes[name].kind !== "tiktoken",
  ),
);

export function resolveNamedTokenizerRoute(
  name: string | null | undefined,
  fallback: TokenizeRoute,
): TokenizeRoute {
  if (!name) return fallback;
  return namedTokenizerRoutes[name] ?? fallback;
}

export function resolveModelTokenizerRoute(
  tokenizer: LLMTokenizer,
  googleClaudeTokenizing: boolean,
): TokenizeRoute {
  const route = modelTokenizerRoutes[tokenizer] ?? FALLBACK_TIKTOKEN_ROUTE;
  // The Google API endpoint is only used when the user opted into it; otherwise
  // Gemini and Gemma models share the local Gemma vocabulary.
  if (route.kind === "googleCloud" && !googleClaudeTokenizing) {
    return WEB_ROUTE("gemma");
  }
  return route;
}
