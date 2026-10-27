import { presetStore } from "src/ts/stores/domain/presetStore.svelte";
import { characterStore } from "src/ts/stores/domain/characterStore.svelte";
import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import type { Tiktoken } from "@dqbd/tiktoken";
import type { Tokenizer } from "@mlc-ai/web-tokenizers";
import type {
  groupChat,
  character,
  Chat,
} from "@risuai/protocol/domain/database.ts";

import type { MultiModal, OpenAIChat } from "@risuai/chat-core/types.ts";
import {
  calculateMultimodalTokenCost,
  countChatTokensDetailed,
  type ChatTokenAccountingOptions,
} from "@risuai/chat-core/tokenAccounting.ts";
import { supportsInlayImage } from "./process/files/inlays";
import { risuChatParser } from "./parser/parser.svelte";
import { tokenizeGGUFModel } from "./process/models/local";
import { forageStorage, globalFetch } from "./globalApi.svelte";
import { getModelInfo, LLMTokenizer, type LLMModel } from "./model/modellist";
import { pluginV2 } from "./plugins/plugins.svelte";
import { LRUMap } from "mnemonist";
import { isNodeServer } from "./platform";
import { NodeStorage } from "./storage/files/nodeStorage";
import type { TokenizerEncoding } from "../../packages/protocol/compute.ts";
import { createTokenizerQueue } from "./tokenizerQueue.ts";
import {
  type TokenizeRoute,
  type WebTokenizerTarget,
  DEFAULT_TIKTOKEN_ROUTE,
  FALLBACK_TIKTOKEN_ROUTE,
  PLUGIN_TOKENIZER_ROUTE,
  nonTiktokenNamedRoutes,
  resolveModelTokenizerRoute,
  resolveNamedTokenizerRoute,
  webTokenizerSources,
} from "./tokenizerRoutes.ts";

const MAX_CACHE_SIZE = 128;

const encodeCache = new LRUMap<string, number[] | Uint32Array | Int32Array>(
  MAX_CACHE_SIZE,
);
const tokenCountCache = new LRUMap<string, number>(MAX_CACHE_SIZE * 4);

function getHash(
  data: string,
  aiModel: string,
  customTokenizer: string,
  currentPluginProvider: string,
  googleClaudeTokenizing: boolean,
  modelInfo: LLMModel,
  pluginTokenizer: string,
): string {
  const combined = `${data}::${aiModel}::${customTokenizer}::${currentPluginProvider}::${googleClaudeTokenizing ? "1" : "0"}::${modelInfo.tokenizer}::${pluginTokenizer}`;
  return combined;
}

export const tokenizerList = [
  ["tik", "Tiktoken (OpenAI)"],
  ["mistral", "Mistral"],
  ["novelai", "NovelAI"],
  ["claude", "Claude"],
  ["llama", "Llama"],
  ["llama3", "Llama3"],
  ["novellist", "Novellist"],
  ["gemma", "Gemma"],
  ["cohere", "Cohere"],
  ["deepseek", "DeepSeek"],
  ["deepseek-v4", "DeepSeek V4"],
  ["glm4", "GLM4"],
  ["glm5", "GLM5"],
] as const;

export async function encodeWithTokenizer(
  data: string,
  tokenizerType: string,
): Promise<number[] | Uint32Array | Int32Array> {
  return await tokenizeWithRoute(
    data,
    resolveNamedTokenizerRoute(tokenizerType, FALLBACK_TIKTOKEN_ROUTE),
  );
}

function resolveServerTiktokenEncoding(
  modelInfo: LLMModel,
  pluginTokenizer: string,
): TokenizerEncoding | null {
  const db = settingsStore.state;

  if (
    presetStore.state.aiModel === "openrouter" ||
    presetStore.state.aiModel === "reverse_proxy"
  ) {
    return nonTiktokenNamedRoutes.has(db.customTokenizer) ? null : "o200k_base";
  }
  if (presetStore.state.aiModel === "custom" && pluginTokenizer) {
    if (pluginTokenizer === "custom") return null;
    if (pluginTokenizer === "cl100k_base") return "cl100k_base";
    if (pluginTokenizer === "o200k_base") return "o200k_base";
    return nonTiktokenNamedRoutes.has(pluginTokenizer) ? null : "o200k_base";
  }
  if (modelInfo.tokenizer === LLMTokenizer.tiktokenO200Base)
    return "o200k_base";
  if (modelInfo.tokenizer === LLMTokenizer.tiktokenCl100kBase)
    return "cl100k_base";
  if (modelInfo.tokenizer === LLMTokenizer.Unknown) return "cl100k_base";
  return null;
}

export function getServerTiktokenEncoding(): TokenizerEncoding | null {
  const db = settingsStore.state;
  const modelInfo = getModelInfo(presetStore.state.aiModel);
  const pluginTokenizer =
    pluginV2.providerOptions.get(presetStore.state.currentPluginProvider)
      ?.tokenizer ?? "none";
  return resolveServerTiktokenEncoding(modelInfo, pluginTokenizer);
}

export async function countTokenTexts(texts: string[]): Promise<number[]> {
  if (texts.length === 0) return [];
  const db = settingsStore.state;
  const modelInfo = getModelInfo(presetStore.state.aiModel);
  const pluginTokenizer =
    pluginV2.providerOptions.get(presetStore.state.currentPluginProvider)
      ?.tokenizer ?? "none";
  const results = new Array<number>(texts.length);
  const missingTexts: string[] = [];
  const missingIndexes: number[] = [];

  for (let i = 0; i < texts.length; i++) {
    const key = getHash(
      texts[i],
      presetStore.state.aiModel,
      db.customTokenizer,
      presetStore.state.currentPluginProvider,
      db.googleClaudeTokenizing,
      modelInfo,
      pluginTokenizer,
    );
    const cached = db.useTokenizerCaching
      ? tokenCountCache.get(key)
      : undefined;
    if (cached !== undefined) results[i] = cached;
    else {
      missingTexts.push(texts[i]);
      missingIndexes.push(i);
    }
  }

  if (missingTexts.length > 0) {
    let counts: number[] | null = null;
    const encoding = resolveServerTiktokenEncoding(modelInfo, pluginTokenizer);
    if (
      encoding &&
      isNodeServer &&
      forageStorage.realStorage instanceof NodeStorage
    ) {
      try {
        counts = await forageStorage.realStorage.tokenizeCountBatch(
          missingTexts,
          encoding,
        );
      } catch (error) {
        console.warn(
          "Server tokenization failed; falling back to browser tokenizer",
          error,
        );
      }
    }
    if (!counts) {
      counts = new Array<number>(missingTexts.length);
      for (let i = 0; i < missingTexts.length; i++) {
        counts[i] = (await encode(missingTexts[i])).length;
      }
    }
    for (let i = 0; i < missingIndexes.length; i++) {
      const index = missingIndexes[i];
      results[index] = counts[i];
      if (db.useTokenizerCaching) {
        const key = getHash(
          texts[index],
          presetStore.state.aiModel,
          db.customTokenizer,
          presetStore.state.currentPluginProvider,
          db.googleClaudeTokenizing,
          modelInfo,
          pluginTokenizer,
        );
        tokenCountCache.set(key, counts[i]);
      }
    }
  }
  return results;
}

/**
 * Tokenizes text with the effective model and existing tokenizer/cache configuration.
 *
 * 한국어: 적용 모델과 기존 토큰 계산기·캐시 설정으로 텍스트를 토큰화하는 함수.
 *
 * @param data - Text to tokenize. / 토큰화할 텍스트.
 * @param modelOverride - Optional model used for tokenizer selection and cache identity. / 계산기 선택·캐시 식별에 사용할 선택적 모델.
 * @returns Encoded token IDs in the tokenizer's native array format. / 토큰 계산기의 배열 형식으로 반환한 토큰 ID.
 * @remarks
 * The override lets illustration prompts use the submodel budget without changing the selected preset.
 * 한국어: 모델 변경값으로 선택된 프리셋을 바꾸지 않고 삽화 프롬프트의 보조 모델 한도를 계산.
 */
export async function encode(
  data: string,
  modelOverride?: string,
): Promise<number[] | Uint32Array | Int32Array> {
  const db = settingsStore.state;
  const modelInfo = getModelInfo(modelOverride ?? presetStore.state.aiModel);
  const pluginTokenizer =
    pluginV2.providerOptions.get(presetStore.state.currentPluginProvider)
      ?.tokenizer ?? "none";

  let cacheKey = "";
  if (db.useTokenizerCaching) {
    cacheKey = getHash(
      data,
      modelOverride ?? presetStore.state.aiModel,
      db.customTokenizer,
      presetStore.state.currentPluginProvider,
      db.googleClaudeTokenizing,
      modelInfo,
      pluginTokenizer,
    );
    const cachedResult = encodeCache.get(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }
  }

  let result: number[] | Uint32Array | Int32Array;

  if (
    presetStore.state.aiModel === "openrouter" ||
    presetStore.state.aiModel === "reverse_proxy"
  ) {
    result = await tokenizeWithRoute(
      data,
      resolveNamedTokenizerRoute(db.customTokenizer, DEFAULT_TIKTOKEN_ROUTE),
    );
  } else if (presetStore.state.aiModel === "custom" && pluginTokenizer) {
    result = await tokenizeWithRoute(
      data,
      pluginTokenizer === "custom"
        ? PLUGIN_TOKENIZER_ROUTE
        : resolveNamedTokenizerRoute(pluginTokenizer, DEFAULT_TIKTOKEN_ROUTE),
    );
  }

  // Fallback to whatever the selected model declares.
  if (result === undefined) {
    result = await tokenizeWithRoute(
      data,
      resolveModelTokenizerRoute(
        modelInfo.tokenizer,
        db.googleClaudeTokenizing,
      ),
    );
  }
  if (db.useTokenizerCaching) {
    encodeCache.set(cacheKey, result);
  }

  return result;
}

let tikParser: Tiktoken = null;
let tokenizersTokenizer: Tokenizer = null;
let tokenizersTarget: WebTokenizerTarget = null;
let lastTikModel = "cl100k_base";
const queueTiktoken = createTokenizerQueue();
const queueWebTokenizer = createTokenizerQueue();

const googleCloudTokenizedCache = new LRUMap<string, number>(128);

async function tokenizeGoogleCloud(text: string) {
  const db = settingsStore.state;
  const model = getModelInfo(presetStore.state.aiModel);
  const cacheKey = text + model.internalID;

  const cachedCount = googleCloudTokenizedCache.get(cacheKey);
  if (cachedCount !== undefined) {
    return new Uint32Array(cachedCount);
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.internalID}:countTokens?key=${db.google?.accessToken}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: text,
              },
            ],
          },
        ],
      }),
    },
  );

  if (res.status !== 200) {
    return await tokenizeWebTokenizers(text, "gemma");
  }

  const json = await res.json();
  googleCloudTokenizedCache.set(cacheKey, json.totalTokens as number);
  const count = json.totalTokens as number;

  return new Uint32Array(count);
}

async function tokenizeWithRoute(
  data: string,
  route: TokenizeRoute,
): Promise<number[] | Uint32Array | Int32Array> {
  switch (route.kind) {
    case "web":
      return await tokenizeWebTokenizers(data, route.target);
    case "tiktoken":
      return await tikJS(data, route.encoding);
    case "gguf":
      return await tokenizeGGUFModel(data);
    case "googleCloud":
      return await tokenizeGoogleCloud(data);
    case "plugin":
      return (
        (await pluginV2.providerOptions
          .get(presetStore.state.currentPluginProvider)
          ?.tokenizerFunc?.(data)) ?? [0]
      );
  }
}

async function tikJS(text: string, model = "cl100k_base") {
  return queueTiktoken(async () => {
    if (!tikParser || lastTikModel !== model) {
      tikParser?.free();
      tikParser = null;
      if (model === "cl100k_base") {
        const { Tiktoken } = await import("@dqbd/tiktoken");
        const cl100k_base =
          await import("@dqbd/tiktoken/encoders/cl100k_base.json");
        lastTikModel = model;

        tikParser = new Tiktoken(
          cl100k_base.bpe_ranks,
          cl100k_base.special_tokens,
          cl100k_base.pat_str,
        );
      }
      if (model === "o200k_base") {
        const { Tiktoken } = await import("@dqbd/tiktoken");
        const o200k_base = await import("src/etc/o200k_base.json");
        lastTikModel = model;
        tikParser = new Tiktoken(
          o200k_base.bpe_ranks,
          o200k_base.special_tokens,
          o200k_base.pat_str,
        );
      }
    }
    return tikParser.encode(text);
  });
}

async function geminiTokenizer(text: string) {
  const db = settingsStore.state;
  const fetchResult = await globalFetch(
    `https://generativelanguage.googleapis.com/v1beta/${presetStore.state.aiModel}:countTextTokens`,
    {
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${db.google.accessToken}`,
      },
      body: JSON.stringify({
        prompt: {
          text: text,
        },
      }),
      method: "POST",
    },
  );

  if (!fetchResult.ok) {
    //fallback to tiktoken
    return await tikJS(text);
  }

  const result = fetchResult.data;

  return result.tokenCount ?? 0;
}

async function tokenizeWebTokenizers(text: string, target: WebTokenizerTarget) {
  return queueWebTokenizer(async () => {
    if (target !== tokenizersTarget || !tokenizersTokenizer) {
      tokenizersTokenizer?.dispose();
      tokenizersTokenizer = null;
      const webTokenizer = await import("@mlc-ai/web-tokenizers");
      const source = webTokenizerSources[target];
      const buffer = await (await fetch(source.path)).arrayBuffer();
      tokenizersTokenizer =
        source.loader === "json"
          ? await webTokenizer.Tokenizer.fromJSON(buffer)
          : await webTokenizer.Tokenizer.fromSentencePiece(buffer);
      tokenizersTarget = target;
    }
    return tokenizersTokenizer.encode(text);
  });
}

export async function tokenizerChar(char: character) {
  const encoded = await encode(
    char.name + "\n" + char.firstMessage + "\n" + char.desc,
  );
  return encoded.length;
}

export async function tokenize(data: string) {
  const encoded = await encode(data);
  return encoded.length;
}

export async function tokenizeAccurate(data: string, consistantChar?: boolean) {
  data = risuChatParser(data.replace("{{slot}}", ""), {
    tokenizeAccurate: true,
    consistantChar: consistantChar,
  });
  const encoded = await encode(data);
  return encoded.length;
}

export class ChatTokenizer {
  private chatAdditionalTokens: number;
  private useName: "name" | "noName";

  constructor(chatAdditionalTokens: number, useName: "name" | "noName") {
    this.chatAdditionalTokens = chatAdditionalTokens;
    this.useName = useName;
  }

  getTokenAccountingOptions(countThoughts = false): ChatTokenAccountingOptions {
    const db = settingsStore.state;
    return {
      chatAdditionalTokens: this.chatAdditionalTokens,
      useName: this.useName === "name",
      countThoughts,
      supportsInlayImage: supportsInlayImage(),
      visionQuality: db.gptVisionQuality,
    };
  }
  async tokenizeChat(data: OpenAIChat, args: { countThoughts?: boolean } = {}) {
    return (await this.tokenizeChatsDetailed([data], args))[0];
  }

  async tokenizeChatsDetailed(
    data: OpenAIChat[],
    args: { countThoughts?: boolean } = {},
  ): Promise<number[]> {
    return countChatTokensDetailed(
      data,
      countTokenTexts,
      this.getTokenAccountingOptions(args.countThoughts),
    );
  }

  async tokenizeChats(
    data: OpenAIChat[],
    args: { countThoughts?: boolean } = {},
  ) {
    const counts = await this.tokenizeChatsDetailed(data, args);
    let total = 0;
    for (let i = 0; i < counts.length; i++) {
      total += counts[i];
    }
    return total;
  }

  tokenizeMultiModal(data: MultiModal) {
    return calculateMultimodalTokenCost(
      data,
      this.getTokenAccountingOptions(false),
    );
  }
}

export async function tokenizeNum(data: string) {
  const encoded = await encode(data);
  return encoded;
}

export async function strongBan(data: string, bias: { [key: number]: number }) {
  if (localStorage.getItem("strongBan_" + data)) {
    return JSON.parse(localStorage.getItem("strongBan_" + data)!);
  }
  const banChars = " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’«»「」…–―※";
  const unbanChars = new Set<number>();

  for (let i = 0; i < banChars.length; i++) {
    const encoded = await tokenizeNum(banChars[i]);
    if (encoded.length > 0) {
      unbanChars.add(encoded[0]);
    }
  }

  const charAlt = [
    data,
    data.trim(),
    data.toLocaleUpperCase(),
    data.toLocaleLowerCase(),
    data[0].toLocaleUpperCase() + data.slice(1),
    data[0].toLocaleLowerCase() + data.slice(1),
  ];

  for (let i = 0; i < banChars.length; i++) {
    const char = banChars[i];
    const encoded = await tokenizeNum(char);
    if (encoded.length > 0 && !unbanChars.has(encoded[0])) {
      bias[encoded[0]] = -100;
    }
    for (let j = 0; j < charAlt.length; j++) {
      const alt = charAlt[j];
      const encoded1 = await tokenizeNum(alt + char);
      if (encoded1.length > 0 && !unbanChars.has(encoded1[0])) {
        bias[encoded1[0]] = -100;
      }
      const encoded2 = await tokenizeNum(char + alt);
      if (encoded2.length > 0 && !unbanChars.has(encoded2[0])) {
        bias[encoded2[0]] = -100;
      }
    }
  }
  localStorage.setItem("strongBan_" + data, JSON.stringify(bias));
  return bias;
}

export async function getCharToken(char?: character | groupChat | null) {
  if (!char) {
    char = characterStore.currentCharacter;
  }
  if (char.type === "group") {
    return { persistant: 0, dynamic: 0 };
  }

  const charName = char.name;
  const normalize = (data: string) =>
    data.replace(/{{char}}/g, charName).replace(/<char>/g, charName);

  const persistentTexts: string[] = [
    normalize(char.desc),
    normalize(char.personality ?? ""),
    normalize(char.scenario ?? ""),
  ];

  const dynamicTexts: string[] = [];
  if (char.globalLore?.length) {
    for (let i = 0; i < char.globalLore.length; i++) {
      const content = char.globalLore[i].content;
      if (!content) continue;
      let stripped = "";
      const lines = content.split("\n");
      for (let j = 0; j < lines.length; j++) {
        const line = lines[j];
        if (line.length > 0 && !line.startsWith("@@")) {
          stripped += (stripped.length > 0 ? "\n" : "") + line;
        }
      }
      dynamicTexts.push(normalize(stripped));
    }
  }

  const allTexts = new Array<string>(
    persistentTexts.length + dynamicTexts.length,
  );
  for (let i = 0; i < persistentTexts.length; i++) {
    allTexts[i] = persistentTexts[i];
  }
  for (let i = 0; i < dynamicTexts.length; i++) {
    allTexts[persistentTexts.length + i] = dynamicTexts[i];
  }

  const counts = await countTokenTexts(allTexts);
  let persistant = 0;
  for (let i = 0; i < persistentTexts.length; i++) {
    persistant += counts[i] ?? 0;
  }
  let dynamic = 0;
  for (let i = persistentTexts.length; i < counts.length; i++) {
    dynamic += counts[i] ?? 0;
  }
  return { persistant, dynamic };
}

export async function getChatToken(chat: Chat) {
  const chatTokenizer = new ChatTokenizer(0, "name");
  const chatf = chat.message.map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.data,
  })) as OpenAIChat[];
  return await chatTokenizer.tokenizeChats(chatf);
}
