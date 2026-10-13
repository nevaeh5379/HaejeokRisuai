"use strict";

import * as crypto from "crypto";
import {
  checkVectorIndexRevision,
  syncVectorIndex,
  upsertVectorIndex,
  searchVectorIndex,
} from "../util/vectorIndex.ts";

const SESSION_TTL_MS: any = 5 * 60 * 1000;
const MAX_SESSIONS: any = 32;
const sessions: any = new Map();
const HYPA_MODELS: any = new Set([
  "custom",
  "ada",
  "openai3small",
  "openai3large",
  "voyageContext3",
]);
const DEFAULT_HYPA_MODEL: any = "openai3small";
const INLAY_RE: any = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;
const QUERY_CACHE_MAX_ENTRIES: any = Math.min(
  Math.max(
    Number.parseInt(process.env.RISU_HYPA_QUERY_CACHE_ENTRIES || "1024", 10) ||
      1024,
    32,
  ),
  8192,
);
const QUERY_CACHE_MAX_BYTES: any =
  Math.min(
    Math.max(
      Number.parseInt(process.env.RISU_HYPA_QUERY_CACHE_MB || "16", 10) || 16,
      1,
    ),
    256,
  ) *
  1024 *
  1024;
const queryEmbeddingCache: any = new Map();
const queryEmbeddingInflight: any = new Map();
const queryCacheMetrics: any = new Map();
const queryCacheEpochs: any = new Map();
let queryCacheBytes: any = 0;

function hash(value?: any): any {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("base64url")
    .slice(0, 32);
}

const SECRET_FINGERPRINT_CACHE_MAX_ENTRIES: any = 64;
const secretFingerprintSalt: any = crypto.randomBytes(16);
const secretFingerprintCache: any = new Map();

function secretFingerprint(value?: any): any {
  const secret: any = String(value);
  const cached: any = secretFingerprintCache.get(secret);
  if (cached) {
    secretFingerprintCache.delete(secret);
    secretFingerprintCache.set(secret, cached);
    return cached;
  }

  const fingerprint: any = crypto
    .scryptSync(secret, secretFingerprintSalt, 16)
    .toString("base64url");
  secretFingerprintCache.set(secret, fingerprint);
  while (secretFingerprintCache.size > SECRET_FINGERPRINT_CACHE_MAX_ENTRIES) {
    const oldest: any = secretFingerprintCache.keys().next().value;
    if (oldest === undefined) break;
    secretFingerprintCache.delete(oldest);
  }
  return fingerprint;
}

function queryMetric(scope?: any): any {
  let metric: any = queryCacheMetrics.get(scope);
  if (!metric) {
    metric = { hits: 0, misses: 0, coalesced: 0 };
    queryCacheMetrics.set(scope, metric);
  }
  return metric;
}

function queryCacheEpoch(scope?: any): any {
  return queryCacheEpochs.get(scope) || 0;
}

function queryProviderFingerprint(config?: any): any {
  const model: any = normalizeHypaModel(config.hypaModel);
  if (model === "custom") {
    return `custom:${appendEmbeddingsPath(config.customEmbedding?.url || "")}:${config.customEmbedding?.model || ""}:${secretFingerprint(config.customEmbedding?.key || "")}`;
  }
  if (model === "voyageContext3")
    return `voyageContext3:${secretFingerprint(config.voyageApiKey || "")}`;
  return `${model}:${secretFingerprint(config.supaMemoryKey || "")}`;
}

function touchQueryCache(key?: any, entry?: any): any {
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, entry);
}

function putQueryCache(key?: any, scope?: any, embedding?: any): any {
  const vector: any = Float32Array.from(embedding, (value?: any) =>
    Number(value),
  );
  if (vector.length === 0) return;
  for (const value of vector) if (!Number.isFinite(value)) return;
  const bytes: any = vector.byteLength;
  if (bytes > QUERY_CACHE_MAX_BYTES) return;
  const existing: any = queryEmbeddingCache.get(key);
  if (existing) {
    queryCacheBytes -= existing.embedding.byteLength;
    queryEmbeddingCache.delete(key);
  }
  queryEmbeddingCache.set(key, { scope, embedding: vector });
  queryCacheBytes += bytes;
  while (
    queryEmbeddingCache.size > QUERY_CACHE_MAX_ENTRIES ||
    queryCacheBytes > QUERY_CACHE_MAX_BYTES
  ) {
    const oldest: any = queryEmbeddingCache.entries().next().value;
    if (!oldest) break;
    queryEmbeddingCache.delete(oldest[0]);
    queryCacheBytes -= oldest[1].embedding.byteLength;
  }
}

function getQueryEmbeddingCacheStats(scope?: any): any {
  let entries: any = 0;
  let bytes: any = 0;
  for (const entry of queryEmbeddingCache.values()) {
    if (entry.scope !== scope) continue;
    entries += 1;
    bytes += entry.embedding.byteLength;
  }
  const metric: any = queryCacheMetrics.get(scope) || {
    hits: 0,
    misses: 0,
    coalesced: 0,
  };
  return {
    entries,
    bytes,
    hits: metric.hits,
    misses: metric.misses,
    coalesced: metric.coalesced,
    limits: { entries: QUERY_CACHE_MAX_ENTRIES, bytes: QUERY_CACHE_MAX_BYTES },
  };
}

function clearQueryEmbeddingCache(scope?: any): any {
  let entries: any = 0;
  let bytes: any = 0;
  for (const [key, entry] of Array.from(queryEmbeddingCache.entries()) as [
    string,
    any,
  ][]) {
    if (entry.scope !== scope) continue;
    queryEmbeddingCache.delete(key);
    queryCacheBytes -= entry.embedding.byteLength;
    entries += 1;
    bytes += entry.embedding.byteLength;
  }
  queryCacheMetrics.delete(scope);
  queryCacheEpochs.set(scope, queryCacheEpoch(scope) + 1);
  return { entries, bytes };
}

function cleanSessions(): any {
  const now: any = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest: any = [...sessions.entries()].sort(
      (a?: any, b?: any) => a[1].lastAccess - b[1].lastAccess,
    )[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

function normalizeMessage(message?: any, index?: any): any {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new TypeError(`chats[${index}] must be an object`);
  }
  if (
    !["system", "user", "assistant", "function"].includes(message.role) ||
    typeof message.content !== "string"
  ) {
    throw new TypeError(`chats[${index}] has an invalid role or content`);
  }
  return {
    ...message,
    memo: typeof message.memo === "string" ? message.memo : "",
  };
}

function normalizeStartRequest(input?: any): any {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Request body must be an object");
  if (!["legacy", "v2", "v3"].includes(input.mode))
    throw new TypeError("mode must be legacy, v2, or v3");
  if (!Array.isArray(input.chats) || input.chats.length > 4096)
    throw new TypeError("chats must be an array of at most 4096 messages");
  const chats: any = input.chats.map(normalizeMessage);
  for (const key of ["currentTokens", "maxContextTokens"]) {
    if (
      !Number.isFinite(input[key]) ||
      input[key] < 0 ||
      input[key] > 10_000_000
    )
      throw new TypeError(`${key} is invalid`);
  }
  if (
    !input.config ||
    typeof input.config !== "object" ||
    Array.isArray(input.config)
  )
    throw new TypeError("config must be an object");
  const room: any =
    input.room && typeof input.room === "object" ? input.room : {};
  const character: any =
    input.character && typeof input.character === "object"
      ? input.character
      : {};
  return { ...input, chats, room, character };
}

function normalizeHypaModel(model?: any): any {
  return HYPA_MODELS.has(model) ? model : DEFAULT_HYPA_MODEL;
}

function appendEmbeddingsPath(url?: any): any {
  return String(url).endsWith("/embeddings")
    ? String(url)
    : `${String(url).replace(/\/+$/, "")}/embeddings`;
}

async function fetchJson(url?: any, options?: any): Promise<any> {
  const response: any = await fetch(url, { ...options, redirect: "error" });
  const text: any = await response.text();
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok)
    throw new Error(
      `Embedding HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`,
    );
  return data;
}

async function embedRegular(texts?: any, config?: any): Promise<any> {
  if (texts.length === 0) return [];
  const model: any = normalizeHypaModel(config.hypaModel);
  if (model === "voyageContext3") {
    const groups: any = await embedVoyageGroups(
      texts.map((text?: any) => [text]),
      config,
      "document",
    );
    return groups.map((group?: any) => group[0]);
  }
  let url: any = "https://api.openai.com/v1/embeddings";
  let apiModel: any;
  let key: any = config.supaMemoryKey || "";
  if (model === "custom") {
    if (!config.customEmbedding?.url)
      throw new Error("Custom model requires a Custom Server URL");
    url = appendEmbeddingsPath(config.customEmbedding.url);
    apiModel = config.customEmbedding.model || undefined;
    key = config.customEmbedding.key || "";
  } else {
    apiModel = {
      ada: "text-embedding-ada-002",
      openai3small: "text-embedding-3-small",
      openai3large: "text-embedding-3-large",
    }[model];
  }
  const headers: any = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const output: any = [];
  for (let offset: any = 0; offset < texts.length; offset += 50) {
    const data: any = await fetchJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: texts.slice(offset, offset + 50),
        ...(apiModel ? { model: apiModel } : {}),
      }),
    });
    if (!Array.isArray(data?.data))
      throw new Error("Embedding response has no data array");
    output.push(...data.data.map((item?: any) => item.embedding));
  }
  return output;
}

async function embedQueries(
  scope?: any,
  texts?: any,
  config?: any,
): Promise<any> {
  if (texts.length === 0) return [];
  const metric: any = queryMetric(scope);
  const fingerprint: any = queryProviderFingerprint(config);
  const output: any = new Array(texts.length);
  const misses: any = new Map();
  const waiters: any = [];

  texts.forEach((text?: any, index?: any) => {
    const key: any = hash(`${scope}\0${fingerprint}\0query\0${text}`);
    const cached: any = queryEmbeddingCache.get(key);
    if (cached) {
      metric.hits += 1;
      touchQueryCache(key, cached);
      output[index] = Array.from(cached.embedding);
      return;
    }
    const inflight: any = queryEmbeddingInflight.get(key);
    if (
      inflight &&
      inflight.scope === scope &&
      inflight.epoch === queryCacheEpoch(scope)
    ) {
      metric.coalesced += 1;
      waiters.push({ index, key, promise: inflight.promise });
      return;
    }
    let pending: any = misses.get(key);
    if (!pending) {
      pending = { key, text, indexes: [] };
      misses.set(key, pending);
      metric.misses += 1;
    } else {
      metric.coalesced += 1;
    }
    pending.indexes.push(index);
  });

  if (misses.size > 0) {
    const pending: any = Array.from(misses.values());
    const epoch: any = queryCacheEpoch(scope);
    const batchPromise: any = (async () => {
      let vectors: any;
      if (normalizeHypaModel(config.hypaModel) === "voyageContext3") {
        const groups: any = await embedVoyageGroups(
          pending.map((item?: any) => [item.text]),
          config,
          "query",
        );
        vectors = groups.map((group?: any) => group[0]);
      } else {
        vectors = await embedRegular(
          pending.map((item?: any) => item.text),
          config,
        );
      }
      if (vectors.length !== pending.length)
        throw new Error(
          "Query embedding response length does not match request",
        );
      const byKey: any = new Map();
      pending.forEach((item?: any, position?: any) => {
        const vector: any = vectors[position];
        if (queryCacheEpoch(scope) === epoch)
          putQueryCache(item.key, scope, vector);
        byKey.set(item.key, vector);
      });
      return byKey;
    })();

    const inflightEntry: any = { scope, epoch, promise: batchPromise };
    for (const item of pending)
      queryEmbeddingInflight.set(item.key, inflightEntry);
    try {
      const vectorsByKey: any = await batchPromise;
      for (const item of pending) {
        const vector: any = vectorsByKey.get(item.key);
        for (const index of item.indexes) output[index] = Array.from(vector);
      }
    } finally {
      for (const item of pending) {
        if (queryEmbeddingInflight.get(item.key) === inflightEntry)
          queryEmbeddingInflight.delete(item.key);
      }
    }
  }

  if (waiters.length > 0) {
    const settled: any = await Promise.all(
      waiters.map(async (waiter?: any) => ({
        waiter,
        vectorsByKey: await waiter.promise,
      })),
    );
    for (const { waiter, vectorsByKey } of settled) {
      output[waiter.index] = Array.from(vectorsByKey.get(waiter.key));
    }
  }

  return output;
}

async function embedVoyageGroups(
  groups?: any,
  config?: any,
  inputType: any = "document",
): Promise<any> {
  const key: any = String(config.voyageApiKey || "").trim();
  if (!key) throw new Error("Voyage Context 3 requires a Voyage API Key");
  const batches: any = [];
  let batch: any = [];
  let chunkCount: any = 0;
  for (const group of groups) {
    if (
      batch.length > 0 &&
      (batch.length >= 1000 || chunkCount + group.length > 16000)
    ) {
      batches.push(batch);
      batch = [];
      chunkCount = 0;
    }
    batch.push(group);
    chunkCount += group.length;
  }
  if (batch.length) batches.push(batch);

  const output: any = [];
  for (const inputs of batches) {
    const data: any = await fetchJson(
      "https://api.voyageai.com/v1/contextualizedembeddings",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "voyage-context-3",
          inputs,
          input_type: inputType,
        }),
      },
    );
    if (!Array.isArray(data?.data))
      throw new Error("Voyage embedding response has no data array");
    for (const group of data.data)
      output.push(group.data.map((item?: any) => item.embedding));
  }
  return output;
}

function descriptorRevision(descriptors?: any): any {
  return hash(
    descriptors.map((item?: any) => `${item.id}:${item.signature}`).join("\n"),
  );
}

async function prepareIndex(
  scope?: any,
  indexId?: any,
  documents?: any,
  config?: any,
  contextualGroups: any = null,
): Promise<any> {
  const scopedId: any = `${scope}:hypa:${indexId}:${normalizeHypaModel(config.hypaModel)}`;
  const contextByIndex: any = new Map();
  if (contextualGroups) {
    for (const indexes of contextualGroups) {
      const context: any = indexes.map((i?: any) => documents[i]).join("\0");
      for (const index of indexes) contextByIndex.set(index, context);
    }
  }
  const descriptors: any = documents.map((text?: any, index?: any) => ({
    id: String(index),
    signature: hash(`${text}\0${contextByIndex.get(index) || ""}`),
  }));
  const revision: any = descriptorRevision(descriptors);
  const cached: any = checkVectorIndexRevision(scopedId, revision);
  let status: any = cached.ready
    ? cached
    : syncVectorIndex(scopedId, descriptors, revision);
  if (status.missingIds.length > 0) {
    const missing: any = new Set(status.missingIds.map(Number));
    const entries: any = [];
    if (
      normalizeHypaModel(config.hypaModel) === "voyageContext3" &&
      contextualGroups
    ) {
      for (const indexes of contextualGroups) {
        if (!indexes.some((index?: any) => missing.has(index))) continue;
        const vectors: any = (
          await embedVoyageGroups(
            [indexes.map((index?: any) => documents[index])],
            config,
            "document",
          )
        )[0];
        indexes.forEach((index?: any, pos?: any) => {
          if (missing.has(index))
            entries.push({
              id: String(index),
              signature: descriptors[index].signature,
              embedding: vectors[pos],
            });
        });
      }
    } else {
      const indexes: any = [...missing].sort((a?: any, b?: any) => a - b);
      const vectors: any = await embedRegular(
        indexes.map((index?: any) => documents[index]),
        config,
      );
      indexes.forEach((index?: any, pos?: any) =>
        entries.push({
          id: String(index),
          signature: descriptors[index].signature,
          embedding: vectors[pos],
        }),
      );
    }
    for (let offset: any = 0; offset < entries.length; offset += 64)
      upsertVectorIndex(scopedId, entries.slice(offset, offset + 64));
  }
  return scopedId;
}

async function rankDocuments(
  scope?: any,
  indexId?: any,
  documents?: any,
  queries?: any,
  config?: any,
  { metric = "dot", topK = null, contextualGroups = null }: any = {},
): Promise<any> {
  if (documents.length === 0 || queries.length === 0)
    return queries.map(() => []);
  const scopedId: any = await prepareIndex(
    scope,
    indexId,
    documents,
    config,
    contextualGroups,
  );
  const queryVectors: any = await embedQueries(scope, queries, config);
  const results: any = searchVectorIndex(scopedId, queryVectors, metric, topK);
  if (!results) return queries.map(() => []);
  return results.map((rows?: any) =>
    rows.map(([id, score]: any) => [Number(id), score]),
  );
}

function parseChatMLRaw(data?: any): any {
  const starter: any = "<|im_start|>";
  const separator: any = "<|im_sep|>";
  const ender: any = "<|im_end|>";
  const trimmed: any = String(data).trim();
  if (!trimmed.startsWith(starter)) return null;
  const messages: any = trimmed
    .split(starter)
    .filter(Boolean)
    .map((raw?: any) => {
      let value: any = raw;
      let role: any = "user";
      for (const candidate of ["user", "system", "assistant"]) {
        if (value.startsWith(candidate + separator)) {
          role = candidate;
          value = value.substring(candidate.length + separator.length);
          break;
        }
        if (
          value.startsWith(candidate + " ") ||
          value.startsWith(candidate + "\n")
        ) {
          role = candidate;
          value = value.substring(candidate.length + 1);
          break;
        }
      }
      value = value.trim();
      if (value.endsWith(ender))
        value = value.substring(0, value.length - ender.length);
      const thoughts: any = [];
      value = value.replace(
        /<Thoughts>(.+)<\/Thoughts>/gms,
        (_?: any, thought?: any) => {
          thoughts.push(thought);
          return "";
        },
      );
      return { role, content: value, thoughts };
    });
  return { messages, parseContents: true };
}

function buildSummaryMessages(prompt?: any, text?: any): any {
  const parsed: any = parseChatMLRaw(
    String(prompt).replaceAll("{{slot}}", text),
  );
  if (parsed) return parsed;
  return {
    messages: [
      { role: "user", content: text },
      { role: "system", content: prompt },
    ],
    parseContents: false,
  };
}

function sanitizeSummaryText(text?: any): any {
  return String(text).replace(INLAY_RE, "[Image]");
}

function validateCounts(value?: any, expected?: any): any {
  if (
    !Array.isArray(value) ||
    value.length !== expected ||
    value.some((count?: any) => !Number.isFinite(count) || count < 0)
  ) {
    throw new TypeError("Tokenizer action returned invalid counts");
  }
  return value;
}

async function* tokenize(messages?: any): AsyncGenerator<any> {
  const result: any = yield { type: "tokenize", messages };
  return validateCounts(result, messages.length);
}

async function* tokenizeTexts(texts?: any): AsyncGenerator<any> {
  const result: any = yield { type: "tokenize-texts", texts };
  return validateCounts(result, texts.length);
}

async function* summarizeTextWithClient(
  text?: any,
  prompt?: any,
): AsyncGenerator<any> {
  const built: any = buildSummaryMessages(prompt, text);
  const result: any = yield {
    type: "summarize",
    messages: built.messages,
    parseContents: built.parseContents,
  };
  if (
    !result ||
    result.ok !== true ||
    typeof result.text !== "string" ||
    !result.text.trim()
  ) {
    throw new Error(result?.error || "Empty summary returned");
  }
  let output: any = result.text.trim();
  output = output
    .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim();
  if (!output) throw new Error("Empty summary after removing thoughts content");
  return output;
}

async function directV2Summary(text?: any, config?: any): Promise<any> {
  const prompt: any =
    config.supaMemoryPrompt ||
    "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]\n";
  const promptbody: any = `${text}\n\n${prompt}\n\nOutput:`;
  const model: any =
    config.supaModelType === "curie"
      ? "text-curie-001"
      : config.supaModelType === "instruct35"
        ? "gpt-3.5-turbo-instruct"
        : "text-davinci-003";
  const data: any = await fetchJson("https://api.openai.com/v1/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.supaMemoryKey || ""}`,
    },
    body: JSON.stringify({
      model,
      prompt: promptbody,
      max_tokens: 600,
      temperature: 0,
    }),
  });
  const result: any = data?.choices?.[0]?.text?.trim();
  if (!result) throw new Error("SupaMemory: HTTP: empty completion");
  return result;
}

async function* summarizeV2(text?: any, config?: any): AsyncGenerator<any> {
  if (config.supaModelType === "distilbart") {
    const result: any = yield { type: "distilbart", text };
    if (!result || result.ok !== true || typeof result.text !== "string")
      throw new Error(result?.error || "DistilBART summarization failed");
    return result.text;
  }
  if (config.supaModelType === "subModel") {
    const prompt: any =
      config.supaMemoryPrompt ||
      "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]\n";
    return yield* summarizeTextWithClient(text, prompt);
  }
  return directV2Summary(text, config);
}

async function* summarizeLegacy(text?: any, config?: any): AsyncGenerator<any> {
  if (config.supaModelType === "distilbart") {
    const result: any = yield { type: "distilbart", text };
    if (!result || result.ok !== true || typeof result.text !== "string")
      throw new Error(result?.error || "DistilBART summarization failed");
    return result.text;
  }
  const prompt: any =
    config.supaMemoryPrompt ||
    "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output to reduce tokens for gpt3 and other sublanguage models]\n";
  if (config.supaModelType === "subModel")
    return yield* summarizeTextWithClient(text, prompt);
  return directV2Summary(text, { ...config, supaMemoryPrompt: prompt });
}

function legacyStringlizeChat(chats?: any, characterName?: any): any {
  const parts: any = [];
  for (const chat of chats) {
    if (chat.memo?.startsWith("inlayImage")) continue;
    if (chat.role === "system") parts.push(`system: ${chat.content}`);
    else if (chat.name) parts.push(`${chat.name}: ${chat.content}`);
    else parts.push(chat.content);
  }
  return `${parts.join("\n\n")}\n\n${characterName}:`;
}

function stripHypaPunctuation(text?: any): any {
  return String(text).replace(/[\.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
}

function isSubset(list?: any, available?: any): any {
  for (const item of list) if (!available.has(item)) return false;
  return true;
}

async function* runLegacy(request?: any, context?: any): AsyncGenerator<any> {
  const chats: any = request.chats.map((chat?: any) => ({ ...chat }));
  const config: any = request.config;
  const maxContextTokens: any = request.maxContextTokens;
  let currentTokens: any = request.currentTokens + 10;

  if (currentTokens <= maxContextTokens) return { currentTokens, chats };

  let chatTokenCounts: any = yield* tokenize(chats);
  const prefixTokens: any = (count?: any) =>
    chatTokenCounts
      .slice(0, Math.max(0, count))
      .reduce((sum?: any, value?: any) => sum + value, 0);
  const discardPrefix: any = (count?: any) => {
    if (count <= 0) return;
    currentTokens -= prefixTokens(count);
    chats.splice(0, count);
    chatTokenCounts.splice(0, count);
  };

  const newChatIndex: any = chats.findIndex(
    (chat?: any) => chat.memo === "NewChat",
  );
  if (newChatIndex !== -1) discardPrefix(newChatIndex);

  let supaMemory: any = "";
  let hypaChunks: any = [];
  let lastId: any = "";
  let hypaData: any = [];

  if (
    typeof request.room.supaMemoryData === "string" &&
    request.room.supaMemoryData.length > 4
  ) {
    const parts: any = request.room.supaMemoryData.split("\n");
    const id: any = parts.shift() || "";
    const storedData: any = parts.join("\n");
    if (id.startsWith("hypa:")) {
      try {
        hypaData = JSON.parse(storedData.trim());
      } catch {
        return {
          currentTokens,
          chats,
          error: "hypaMemory: hypaMemory is not valid JSON",
        };
      }
      if (!Array.isArray(hypaData))
        return {
          currentTokens,
          chats,
          error: "hypaMemory: hypaMemory isn't Array",
        };
      let selected: any = -1;
      for (let index: any = 0; index < hypaData.length; index++) {
        const chatIndex: any = chats.findIndex(
          (chat?: any) => chat.memo === hypaData[index]?.id,
        );
        if (chatIndex === -1) continue;
        lastId = hypaData[index].id;
        discardPrefix(chatIndex);
        selected = index;
        break;
      }
      if (selected === -1)
        return { currentTokens, chats, error: "hypaMemory: chat ID not found" };
      supaMemory = String(hypaData[selected]?.supa || "");
      hypaChunks = Array.isArray(hypaData[selected]?.hypa)
        ? hypaData[selected].hypa.slice()
        : [];
    }
    // When legacy SupaMemory data is opened with Hypa enabled, the browser
    // implementation deliberately starts a fresh Hypa memory instead of
    // treating the old Supa blob as a Hypa record.
  }

  let hypaResult: any = "";
  hypaChunks = hypaChunks.filter(
    (value?: any) => typeof value === "string" && value.length > 1,
  );
  if (hypaChunks.length > 0) {
    const seen: any = new Set();
    const retrievalTexts: any = [];
    for (const value of hypaChunks) {
      if (seen.has(value)) continue;
      seen.add(value);
      const normalized: any = config.removePunctuationHypa
        ? stripHypaPunctuation(value)
        : value;
      if (
        stripHypaPunctuation(supaMemory).includes(
          stripHypaPunctuation(normalized),
        )
      )
        continue;
      retrievalTexts.push(normalized);
    }
    if (retrievalTexts.length > 0) {
      const filteredChat: any = chats.filter(
        (chat?: any) => chat.role !== "system" && chat.role !== "function",
      );
      const query: any = legacyStringlizeChat(
        filteredChat.slice(0, 4),
        request.character.name || "",
      );
      const ranked: any = await rankDocuments(
        context.scope,
        `legacy:${request.character.id || ""}:${request.room.id || ""}`,
        retrievalTexts,
        [query],
        config,
        { metric: "dot", topK: 3 },
      );
      const selectedTexts: any = (ranked[0] || [])
        .map(([index]: any) => retrievalTexts[index])
        .slice(0, 3);
      if (selectedTexts.length > 0) {
        hypaResult = `past events: ${selectedTexts}`;
        currentTokens += (yield* tokenize([
          { role: "assistant", content: hypaResult, memo: "hypaMemory" },
        ]))[0];
        currentTokens += 10;
      }
    }
  }

  if (currentTokens < maxContextTokens) {
    chats.unshift({
      role: "system",
      content: `${supaMemory}\n\n${hypaResult}`,
      memo: "supaMemory",
    });
    return { currentTokens, chats };
  }

  const plainCount: any = async function* (text?: any): AsyncGenerator<any> {
    return (yield* tokenizeTexts([text]))[0];
  };

  while (currentTokens > maxContextTokens) {
    const beforeToken: any = currentTokens;
    let maxChunkSize: any = Math.floor(maxContextTokens / 3);
    if (Number(config.maxSupaChunkSize || 0) < maxChunkSize)
      maxChunkSize = Number(config.maxSupaChunkSize || 0);
    let summarized: any = false;
    let chunkSize: any = 0;
    let stringlizedChat: any = "";
    let spiceLen: any = 0;

    while (true) {
      const cont: any = chats[spiceLen];
      if (!cont) {
        currentTokens = beforeToken;
        stringlizedChat = "";
        chunkSize = 0;
        spiceLen = 0;
        if (summarized) {
          if (maxChunkSize < 500)
            return {
              currentTokens,
              chats,
              error: "Not Enough Tokens to summarize in SupaMemory",
            };
          maxChunkSize *= 0.7;
        } else {
          let result: any;
          try {
            result = yield* summarizeLegacy(supaMemory, config);
          } catch (error: any) {
            return {
              currentTokens,
              chats,
              error: `SupaMemory: HTTP: ${error}`,
            };
          }
          currentTokens -= yield* plainCount(supaMemory);
          currentTokens += yield* plainCount(`${result}\n\n`);
          supaMemory = `${result}\n\n`;
          summarized = true;
          if (currentTokens <= maxContextTokens) break;
        }
        continue;
      }

      const tokens: any = chatTokenCounts[spiceLen];
      if (chunkSize + tokens > maxChunkSize) {
        if (
          stringlizedChat === "" &&
          cont.role !== "function" &&
          cont.role !== "system"
        ) {
          const speaker: any =
            cont.role === "assistant"
              ? request.character.type === "character"
                ? request.character.name || ""
                : ""
              : config.userName || "";
          stringlizedChat += `${speaker}: ${cont.content}\n\n`;
          spiceLen += 1;
          currentTokens -= tokens;
          chunkSize += tokens;
        }
        lastId = cont.memo;
        break;
      }

      const speaker: any =
        cont.role === "assistant"
          ? request.character.type === "character"
            ? request.character.name || ""
            : ""
          : config.userName || "";
      stringlizedChat += `${speaker}: ${cont.content}\n\n`;
      spiceLen += 1;
      currentTokens -= tokens;
      chunkSize += tokens;
    }

    chats.splice(0, spiceLen);
    chatTokenCounts.splice(0, spiceLen);

    if (stringlizedChat !== "") {
      let result: any;
      try {
        result = yield* summarizeLegacy(stringlizedChat, config);
      } catch (error: any) {
        return { currentTokens, chats, error: `SupaMemory: HTTP: ${error}` };
      }

      const resultTokens: any = yield* plainCount(`${result}\n\n`);
      hypaChunks.push(result.replace(/\n+/g, "\n"));
      let supaList: any = supaMemory
        .split("\n\n")
        .filter((value?: any) => value.length > 1);
      if (supaList.length >= 3) {
        const oldSupa: any = supaMemory;
        try {
          supaMemory = yield* summarizeLegacy(supaMemory, config);
        } catch (error: any) {
          return { currentTokens, chats, error: `SupaMemory: HTTP: ${error}` };
        }
        currentTokens -= yield* plainCount(oldSupa);
        currentTokens += yield* plainCount(supaMemory);
      }
      supaList = supaMemory
        .split("\n\n")
        .filter((value?: any) => value.length > 1);
      supaList.push(result.replace(/\n+/g, "\n"));
      currentTokens += resultTokens;
      supaMemory = supaList.join("\n\n");
    }
  }

  chats.unshift({ role: "system", content: supaMemory, memo: "supaMemory" });
  if (hypaResult !== "")
    chats.unshift({ role: "system", content: hypaResult, memo: "hypaMemory" });

  if (hypaData[0] && hypaData[0].id === lastId) {
    hypaData[0].hypa = hypaChunks;
    hypaData[0].supa = supaMemory;
  } else {
    hypaData.unshift({ id: lastId, hypa: hypaChunks, supa: supaMemory });
  }

  return {
    currentTokens,
    chats,
    memory: `hypa:\n${JSON.stringify(hypaData, null, 2)}`,
    lastId,
  };
}

function normalizeV2Data(raw?: any, chats?: any): any {
  if (!raw) return { lastMainChunkID: 0, chunks: [], mainChunks: [] };
  if (
    Array.isArray(raw.mainChunks) &&
    raw.mainChunks.every((chunk?: any) => typeof chunk?.targetId === "string")
  ) {
    const oldMainChunks: any = raw.mainChunks.slice().reverse();
    const oldChunks: any = Array.isArray(raw.chunks) ? raw.chunks : [];
    const data: any = { lastMainChunkID: 0, mainChunks: [], chunks: [] };
    let previousTarget: any = null;
    for (const old of oldMainChunks) {
      const end: any = chats.findIndex(
        (chat?: any) => chat.memo === old.targetId,
      );
      const start: any = previousTarget
        ? chats.findIndex((chat?: any) => chat.memo === previousTarget)
        : 0;
      if (end < 0 || start < 0) continue;
      const lo: any = previousTarget ? Math.min(start, end) : 0;
      const hi: any = Math.max(start, end);
      const id: any = data.lastMainChunkID++;
      data.mainChunks.push({
        id,
        text: old.text,
        chatMemos: chats.slice(lo, hi + 1).map((chat?: any) => chat.memo),
        lastChatMemo: old.targetId,
      });
      for (const chunk of oldChunks.filter(
        (chunk?: any) => chunk.targetId === old.targetId,
      ))
        data.chunks.push({ mainChunkID: id, text: chunk.text });
      previousTarget = old.targetId;
    }
    return data;
  }
  return {
    lastMainChunkID: Number(raw.lastMainChunkID) || 0,
    chunks: Array.isArray(raw.chunks)
      ? raw.chunks.map((chunk?: any) => ({ ...chunk }))
      : [],
    mainChunks: Array.isArray(raw.mainChunks)
      ? raw.mainChunks.map((chunk?: any) => ({
          ...chunk,
          chatMemos: Array.isArray(chunk.chatMemos)
            ? chunk.chatMemos.slice()
            : [],
        }))
      : [],
  };
}

async function* runV2(request?: any, context?: any): AsyncGenerator<any> {
  const chats: any = request.chats.map((chat?: any) => ({ ...chat }));
  const config: any = request.config;
  let currentTokens: any =
    request.currentTokens - Number(config.maxResponse || 0);
  const maxContextTokens: any = request.maxContextTokens;
  const data: any = normalizeV2Data(request.room.hypaV2Data, chats);
  const memoSet: any = new Set(chats.map((chat?: any) => chat.memo));
  data.mainChunks = data.mainChunks.filter((chunk?: any) =>
    isSubset(chunk.chatMemos, memoSet),
  );
  const validIds: any = new Set(data.mainChunks.map((chunk?: any) => chunk.id));
  data.chunks = data.chunks.filter((chunk?: any) =>
    validIds.has(chunk.mainChunkID),
  );
  data.lastMainChunkID = data.mainChunks.at(-1)?.id ?? 0;
  const chatTokenCounts: any = yield* tokenize(chats);
  const allocatedTokens: any = Number(config.hypaAllocatedTokens || 0);
  const chunkSize: any = Number(config.hypaChunkSize || 0);
  currentTokens += allocatedTokens;
  const lastTwoChats: any = chats.slice(-2);
  let idx: any = 0;
  if (data.mainChunks.length > 0) {
    const lastIndex: any = chats.findIndex(
      (chat?: any) => chat.memo === data.mainChunks.at(-1).lastChatMemo,
    );
    if (lastIndex >= 0) {
      idx = lastIndex + 1;
      currentTokens -= chatTokenCounts
        .slice(0, lastIndex + 1)
        .reduce((a?: any, b?: any) => a + b, 0);
    }
  }
  let failures: any = 0;
  while (currentTokens > maxContextTokens) {
    const batch: any = [];
    let batchTokens: any = 0;
    while (batchTokens < chunkSize && idx < chats.length - 4) {
      const chat: any = chats[idx];
      const tokens: any = chatTokenCounts[idx];
      if (idx === 0 || !chat.content.trim()) {
        idx++;
        continue;
      }
      if (batchTokens + tokens > chunkSize) break;
      batch.push(chat);
      batchTokens += tokens;
      idx++;
    }
    if (batch.length === 0) {
      const message: any =
        idx >= chats.length - 4
          ? `[HypaV2] Input tokens (${currentTokens}) exceeds max context size (${maxContextTokens}), but can't summarize last 4 messages. Please increase max context size to at least ${currentTokens}.`
          : `[HypaV2] Message tokens (${chatTokenCounts[idx]}) exceeds chunk size (${chunkSize}). Please increase chunk size to at least ${chatTokenCounts[idx]}.`;
      return { currentTokens, chats, error: message };
    }
    try {
      const summary: any = yield* summarizeV2(
        batch.map((chat?: any) => `${chat.role}: ${chat.content}`).join("\n"),
        config,
      );
      failures = 0;
      const summaryTokens: any = (yield* tokenize([
        { role: "system", content: summary },
      ]))[0];
      void summaryTokens;
      data.lastMainChunkID++;
      const id: any = data.lastMainChunkID;
      data.mainChunks.push({
        id,
        text: summary,
        chatMemos: batch.map((chat?: any) => chat.memo),
        lastChatMemo: batch.at(-1).memo,
      });
      for (const text of summary
        .split("\n\n")
        .map((value?: any) => value.trim())
        .filter(Boolean))
        data.chunks.push({ mainChunkID: id, text });
      currentTokens -= batchTokens;
    } catch (error: any) {
      if (++failures >= 3)
        return {
          currentTokens,
          chats,
          error:
            "[HypaV2] Summarization failed multiple times. Aborting to prevent infinite loop.",
        };
    }
  }
  const mainCandidates: any = data.mainChunks.map((chunk?: any) => ({
    role: "system",
    content: chunk.text,
  }));
  const mainCounts: any = yield* tokenize(mainCandidates);
  let mainPrompt: any = "";
  let mainPromptTokens: any = 0;
  for (let i: any = 0; i < data.mainChunks.length; i++) {
    if (mainPromptTokens + mainCounts[i] > allocatedTokens / 2) break;
    mainPrompt += `\n\n${data.mainChunks[i].text}`;
    mainPromptTokens += mainCounts[i];
  }
  const prefix: any = "search_document: ";
  const documents: any = data.chunks
    .filter((chunk?: any) => chunk.text.trim())
    .map((chunk?: any) => prefix + chunk.text.trim());
  const recentQueries: any = [];
  for (let i: any = 0; i < 3; i++) {
    const chat: any = chats[chats.length - i - 1];
    if (chat) recentQueries.push(`search_query: ${chat.content}`);
  }
  const rankedLists: any = await rankDocuments(
    context.scope,
    `hypav2:${request.character.id || ""}:${request.room.id || ""}`,
    documents,
    recentQueries,
    config,
    { metric: "dot" },
  );
  const scoreMap: any = new Map();
  rankedLists.forEach((rows?: any, listIndex?: any) =>
    rows.forEach(([docIndex, score]: any) =>
      scoreMap.set(
        docIndex,
        (scoreMap.get(docIndex) || 0) + score / (listIndex + 1),
      ),
    ),
  );
  const rankedIndexes: any = [...scoreMap.entries()]
    .sort((a?: any, b?: any) => b[1] - a[1])
    .map(([index]: any) => index);
  const candidateTexts: any = rankedIndexes.map((index?: any) =>
    documents[index].substring(prefix.length),
  );
  const candidateCounts: any = yield* tokenize(
    candidateTexts.map((content?: any) => ({ role: "system", content })),
  );
  let details: any = "";
  let detailTokens: any = 0;
  for (let i: any = 0; i < candidateTexts.length; i++) {
    if (candidateCounts[i] > allocatedTokens - mainPromptTokens - detailTokens)
      break;
    details += candidateTexts[i] + "\n\n";
    detailTokens += candidateCounts[i];
  }
  const fullResult: any = `<Past Events Summary>${mainPrompt}</Past Events Summary>\n<Past Events Details>${details}</Past Events Details>`;
  currentTokens += (yield* tokenize([
    { role: "system", content: fullResult },
  ]))[0];
  const resultChats: any = [
    { role: "system", content: fullResult, memo: "supaMemory" },
    ...chats.slice(idx),
  ];
  for (const chat of lastTwoChats)
    if (!resultChats.some((item?: any) => item.memo === chat.memo))
      resultChats.push(chat);
  currentTokens -= allocatedTokens;
  return { currentTokens, chats: resultChats, memory: data };
}

function normalizeV3Data(raw?: any): any {
  return {
    ...(raw && typeof raw === "object" ? raw : {}),
    summaries: Array.isArray(raw?.summaries)
      ? raw.summaries.map((summary?: any) => ({
          ...summary,
          chatMemos: Array.isArray(summary.chatMemos)
            ? summary.chatMemos.slice()
            : [],
        }))
      : [],
  };
}

function splitBySeparator(text?: any, separator?: any): any {
  try {
    const match: any = String(separator).match(/^\/(.+)\/([gimuy]*)$/);
    return String(text).split(
      match ? new RegExp(match[1], match[2]) : new RegExp(separator),
    );
  } catch {
    return String(text).split("\n\n");
  }
}

function weightedRank(lists?: any, weightFn?: any): any {
  const scores: any = new Map();
  lists.forEach((list?: any, listIndex?: any) =>
    list.forEach(([item, score]: any) =>
      scores.set(
        item,
        (scores.get(item) || 0) + score * weightFn(listIndex, lists.length),
      ),
    ),
  );
  return [...scores.entries()]
    .sort((a?: any, b?: any) => b[1] - a[1])
    .map(([item]: any) => item);
}

function childToParentRRF(children?: any, parentFor?: any, k: any = 60): any {
  const scores: any = new Map();
  children.forEach((child?: any, index?: any) => {
    const parent: any = parentFor(child);
    scores.set(parent, (scores.get(parent) || 0) + 1 / (k + index + 1));
  });
  return [...scores.entries()]
    .sort((a?: any, b?: any) => b[1] - a[1])
    .map(([parent]: any) => parent);
}

async function* summarizeV3(
  chats?: any,
  settings?: any,
  isResummarize: any = false,
): AsyncGenerator<any> {
  const prompt: any = isResummarize
    ? String(settings.reSummarizationPrompt || "").trim() ||
      "Re-summarize this summaries."
    : String(settings.summarizationPrompt || "").trim() ||
      "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]";
  const text: any = chats
    .map((chat?: any) => `${chat.role}: ${sanitizeSummaryText(chat.content)}`)
    .join("\n");
  return yield* summarizeTextWithClient(text, prompt);
}

function addWithinBudget(
  candidates?: any,
  tokenMap?: any,
  budget?: any,
  output?: any,
): any {
  let used: any = 0;
  for (const item of candidates) {
    const tokens: any = tokenMap.get(item) || 0;
    if (tokens + used > budget) break;
    output.push(item);
    used += tokens;
  }
  return used;
}

async function rankV3Summaries(
  request?: any,
  context?: any,
  data?: any,
  selected?: any,
  settings?: any,
  chats?: any,
  experimental?: any,
): Promise<any> {
  const unused: any = data.summaries
    .map((summary?: any, index?: any) => ({ summary, index }))
    .filter(({ summary }: any) => !selected.includes(summary));
  const docs: any = [];
  const contextualGroups: any = [];
  for (const { summary, index } of unused) {
    const group: any = [];
    for (const chunk of splitBySeparator(
      summary.text,
      settings.summaryChunkSeparator,
    )
      .map((value?: any) => value.trim())
      .filter(Boolean)) {
      group.push(docs.length);
      docs.push({ text: chunk, summaryIndex: index });
    }
    if (group.length) contextualGroups.push(group);
  }
  if (!docs.length) return [];
  const groups: any =
    normalizeHypaModel(request.config.hypaModel) === "voyageContext3"
      ? contextualGroups
      : null;
  if (experimental) {
    const recent: any = chats
      .slice(-settings.queryChatCount)
      .filter((chat?: any) => chat.content.trim());
    const queries: any = recent.flatMap((chat?: any, index?: any) => {
      const parts: any = chat.content
        .split("\n\n")
        .filter((value?: any) => value.trim());
      const base: any =
        (index + 1) / ((recent.length * (recent.length + 1)) / 2);
      return parts.map((content?: any) => ({
        content,
        weight: base / parts.length,
      }));
    });
    if (!queries.length) return [];
    const lists: any = await rankDocuments(
      context.scope,
      `hypav3-exp:${request.character.id || ""}:${request.room.id || ""}`,
      docs.map((doc?: any) => doc.text),
      queries.map((query?: any) => query.content),
      request.config,
      { metric: "cosine", contextualGroups: groups },
    );
    const rankedChildren: any = weightedRank(
      lists,
      (index?: any) => queries[index].weight,
    );
    return childToParentRRF(
      rankedChildren,
      (docIndex?: any) => docs[docIndex].summaryIndex,
    ).map((index?: any) => data.summaries[index]);
  }
  const recent: any = chats
    .slice(-settings.queryChatCount)
    .filter((chat?: any) => chat.content.trim());
  if (!recent.length) return [];
  const queryTexts: any = recent.map((chat?: any) => chat.content);
  return { docs, groups, queryTexts, recent };
}

async function* runV3(request?: any, context?: any): AsyncGenerator<any> {
  const chats: any = request.chats.map((chat?: any) => ({ ...chat }));
  const config: any = request.config;
  const settings: any = config.v3Settings || {};
  const experimental: any = settings.useExperimentalImpl === true;
  let currentTokens: any =
    request.currentTokens - Number(config.maxResponse || 0);
  const maxContextTokens: any = request.maxContextTokens;
  if (
    Number(settings.recentMemoryRatio || 0) +
      Number(settings.similarMemoryRatio || 0) >
    1
  ) {
    return {
      currentTokens,
      chats,
      error:
        "[HypaV3] The sum of Recent Memory Ratio and Similar Memory Ratio is greater than 1.",
    };
  }
  const data: any = normalizeV3Data(request.room.hypaV3Data);
  if (!settings.preserveOrphanedMemory) {
    const memos: any = new Set(chats.map((chat?: any) => chat.memo));
    data.summaries = data.summaries.filter((summary?: any) =>
      isSubset(summary.chatMemos, memos),
    );
  }
  const chatTokenCounts: any = yield* tokenize(chats);
  let startIdx: any = 0;
  if (data.summaries.length) {
    const lastMemo: any = data.summaries.at(-1).chatMemos.at(-1);
    const lastIndex: any = chats.findIndex(
      (chat?: any) => chat.memo === lastMemo,
    );
    if (lastIndex >= 0) {
      startIdx = lastIndex + 1;
      currentTokens -= chatTokenCounts
        .slice(0, lastIndex + 1)
        .reduce((a?: any, b?: any) => a + b, 0);
    }
  }
  const emptyMemory: any = "<Past Events Summary>\n\n</Past Events Summary>";
  const emptyTokens: any = (yield* tokenize([
    { role: "system", content: emptyMemory },
  ]))[0];
  const memoryTokens: any = Math.floor(
    maxContextTokens * Number(settings.memoryTokensRatio || 0),
  );
  let availableMemoryTokens: any;
  let reserveKind: any;
  if (experimental) {
    const reserve: any =
      data.summaries.length > 0 || currentTokens > maxContextTokens;
    availableMemoryTokens = reserve ? memoryTokens - emptyTokens : 0;
    if (reserve) {
      currentTokens += memoryTokens;
      reserveKind = "full";
    } else reserveKind = "none";
  } else {
    const reserveEmpty: any =
      data.summaries.length === 0 &&
      currentTokens + emptyTokens <= maxContextTokens;
    availableMemoryTokens = reserveEmpty ? 0 : memoryTokens - emptyTokens;
    if (reserveEmpty) {
      currentTokens += emptyTokens;
      reserveKind = "empty";
    } else {
      currentTokens += memoryTokens;
      reserveKind = "full";
    }
  }
  const targetTokens: any =
    maxContextTokens * (1 - Number(settings.extraSummarizationRatio || 0));
  const summarizationMode: any = currentTokens > maxContextTokens;
  if (experimental) {
    const batches: any = [];
    while (summarizationMode) {
      if (currentTokens <= targetTokens) break;
      if (chats.length - startIdx <= Number(settings.queryChatCount || 0)) {
        if (currentTokens <= maxContextTokens) break;
        return {
          currentTokens,
          chats,
          error: `[HypaV3] Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
          memory: data,
        };
      }
      const batch: any = [];
      let tokens: any = 0;
      let index: any = startIdx;
      while (
        batch.length < Number(settings.maxChatsPerSummary || 1) &&
        index < chats.length - Number(settings.queryChatCount || 0)
      ) {
        const chat: any = chats[index];
        tokens += chatTokenCounts[index];
        if (
          chat.name !== "example_user" &&
          chat.name !== "example_assistant" &&
          chat.memo !== "NewChatExample" &&
          chat.memo !== "NewChat" &&
          chat.content.trim() &&
          !(settings.doNotSummarizeUserMessage && chat.role === "user")
        )
          batch.push(chat);
        index++;
      }
      if (
        currentTokens <= maxContextTokens &&
        currentTokens - tokens < targetTokens
      )
        break;
      if (batch.length) batches.push(batch);
      currentTokens -= tokens;
      startIdx = index;
    }
    for (const batch of batches) {
      try {
        const text: any = yield* summarizeV3(batch, settings);
        data.summaries.push({
          text,
          chatMemos: batch.map((chat?: any) => chat.memo),
          isImportant: false,
          tags: [],
        });
      } catch (error: any) {
        return {
          currentTokens,
          chats,
          error: `[HypaV3] Summarization failed: ${error}`,
          memory: data,
        };
      }
    }
  } else {
    while (summarizationMode) {
      if (currentTokens <= targetTokens) break;
      if (chats.length - startIdx <= Number(settings.queryChatCount || 0)) {
        if (currentTokens <= maxContextTokens) break;
        return {
          currentTokens,
          chats,
          error: `[HypaV3] Cannot summarize further: input token count (${currentTokens}) exceeds max context size (${maxContextTokens}), but minimum ${settings.queryChatCount} messages required.`,
          memory: data,
        };
      }
      const end: any = Math.min(
        startIdx + Number(settings.maxChatsPerSummary || 1),
        chats.length - Number(settings.queryChatCount || 0),
      );
      const batch: any = [];
      let tokens: any = 0;
      for (let i: any = startIdx; i < end; i++) {
        const chat: any = chats[i];
        tokens += chatTokenCounts[i];
        if (
          chat.name !== "example_user" &&
          chat.name !== "example_assistant" &&
          chat.memo !== "NewChatExample" &&
          chat.memo !== "NewChat" &&
          chat.content.trim() &&
          !(settings.doNotSummarizeUserMessage && chat.role === "user")
        )
          batch.push(chat);
      }
      if (
        currentTokens <= maxContextTokens &&
        currentTokens - tokens < targetTokens
      )
        break;
      if (batch.length) {
        try {
          const text: any = yield* summarizeV3(batch, settings);
          data.summaries.push({
            text,
            chatMemos: batch.map((chat?: any) => chat.memo),
            isImportant: false,
            tags: [],
          });
        } catch (error: any) {
          return {
            currentTokens,
            chats,
            error: `[HypaV3] Summarization failed: ${error}`,
            memory: data,
          };
        }
      }
      currentTokens -= tokens;
      startIdx = end;
    }
  }
  if (!data.summaries.length) {
    const resultChats: any = experimental
      ? chats.slice(startIdx)
      : [
          { role: "system", content: emptyMemory, memo: "supaMemory" },
          ...chats.slice(startIdx),
        ];
    return { currentTokens, chats: resultChats, memory: data };
  }
  const summaryMessages: any = data.summaries.map((summary?: any) => ({
    role: "system",
    content: `${summary.text}\n\n`,
  }));
  const summaryCounts: any = yield* tokenize(summaryMessages);
  const tokenMap: any = new Map(
    data.summaries.map((summary?: any, index?: any) => [
      summary,
      summaryCounts[index] || 0,
    ]),
  );
  const selected: any = [];
  const important: any = data.summaries.filter(
    (summary?: any) => summary.isImportant,
  );
  let importantUsed: any = addWithinBudget(
    important,
    tokenMap,
    availableMemoryTokens,
    selected,
  );
  availableMemoryTokens -= importantUsed;
  const recentRatio: any = Number(settings.recentMemoryRatio || 0);
  const similarRatio: any = Number(settings.similarMemoryRatio || 0);
  const randomRatio: any = 1 - recentRatio - similarRatio;
  let reservedRecent: any = Math.floor(availableMemoryTokens * recentRatio);
  let usedRecent: any = 0;
  const recentSelected: any = [];
  if (recentRatio > 0) {
    const unused: any = data.summaries
      .filter((summary?: any) => !selected.includes(summary))
      .reverse();
    usedRecent = addWithinBudget(
      unused,
      tokenMap,
      reservedRecent,
      recentSelected,
    );
    selected.push(...recentSelected);
  }
  let reservedSimilar: any = Math.floor(availableMemoryTokens * similarRatio);
  if (randomRatio <= 0) reservedSimilar += reservedRecent - usedRecent;
  const similarSelected: any = [];
  let usedSimilar: any = 0;
  if (similarRatio > 0) {
    let ranked: any;
    if (experimental) {
      ranked = await rankV3Summaries(
        request,
        context,
        data,
        selected,
        settings,
        chats,
        true,
      );
    } else {
      const prep: any = await rankV3Summaries(
        request,
        context,
        data,
        selected,
        settings,
        chats,
        false,
      );
      if (Array.isArray(prep)) ranked = prep;
      else {
        const queryTexts: any = prep.queryTexts.slice();
        if (settings.enableSimilarityCorrection && prep.recent.length > 1) {
          try {
            queryTexts.push(yield* summarizeV3(prep.recent, settings));
          } catch (error: any) {
            return {
              currentTokens,
              chats,
              error: `[HypaV3] Summarization failed: ${error}`,
              memory: data,
            };
          }
        }
        const lists: any = await rankDocuments(
          context.scope,
          `hypav3:${request.character.id || ""}:${request.room.id || ""}`,
          prep.docs.map((doc?: any) => doc.text),
          queryTexts,
          config,
          { metric: "dot", contextualGroups: prep.groups },
        );
        const rankedChildren: any = weightedRank(
          lists,
          (index?: any, total?: any) =>
            (index + 1) / ((total * (total + 1)) / 2),
        );
        ranked = childToParentRRF(
          rankedChildren,
          (docIndex?: any) => prep.docs[docIndex].summaryIndex,
        ).map((index?: any) => data.summaries[index]);
      }
    }
    for (const summary of ranked || []) {
      const tokens: any = tokenMap.get(summary) || 0;
      if (tokens + usedSimilar > reservedSimilar) break;
      similarSelected.push(summary);
      usedSimilar += tokens;
    }
    selected.push(...similarSelected);
  }
  let reservedRandom: any = Math.floor(availableMemoryTokens * randomRatio);
  const randomSelected: any = [];
  if (randomRatio > 0) {
    reservedRandom +=
      reservedRecent - usedRecent + (reservedSimilar - usedSimilar);
    const candidates: any = data.summaries
      .filter((summary?: any) => !selected.includes(summary))
      .sort(() => Math.random() - 0.5);
    let used: any = 0;
    for (const summary of candidates) {
      const tokens: any = tokenMap.get(summary) || 0;
      if (tokens + used > reservedRandom) continue;
      selected.push(summary);
      randomSelected.push(summary);
      used += tokens;
    }
  }
  selected.sort(
    (a?: any, b?: any) => data.summaries.indexOf(a) - data.summaries.indexOf(b),
  );
  const memoryText: any = `<Past Events Summary>\n${selected.map((summary?: any) => summary.text).join("\n\n")}\n</Past Events Summary>`;
  const realMemoryTokens: any = (yield* tokenize([
    { role: "system", content: memoryText },
  ]))[0];
  if (reserveKind === "full") currentTokens -= memoryTokens;
  else if (reserveKind === "empty") currentTokens -= emptyTokens;
  currentTokens += realMemoryTokens;
  if (currentTokens > maxContextTokens)
    throw new Error(
      `Unexpected error: input token count (${currentTokens}) exceeds max context size (${maxContextTokens})`,
    );
  data.metrics = {
    lastImportantSummaries: important
      .filter((summary?: any) => selected.includes(summary))
      .map((summary?: any) => data.summaries.indexOf(summary)),
    lastRecentSummaries: recentSelected.map((summary?: any) =>
      data.summaries.indexOf(summary),
    ),
    lastSimilarSummaries: similarSelected.map((summary?: any) =>
      data.summaries.indexOf(summary),
    ),
    lastRandomSummaries: randomSelected.map((summary?: any) =>
      data.summaries.indexOf(summary),
    ),
  };
  return {
    currentTokens,
    chats: [
      { role: "system", content: memoryText, memo: "supaMemory" },
      ...chats.slice(startIdx),
    ],
    memory: data,
  };
}

function createExecution(request?: any, context?: any): any {
  if (request.mode === "legacy") return runLegacy(request, context);
  return request.mode === "v2"
    ? runV2(request, context)
    : runV3(request, context);
}

async function advanceSession(
  id?: any,
  session?: any,
  value?: any,
  first: any = false,
): Promise<any> {
  session.lastAccess = Date.now();
  const step: any = first
    ? await session.generator.next()
    : await session.generator.next(value);
  if (step.done) {
    sessions.delete(id);
    return { status: "done", result: step.value };
  }
  session.actionId = crypto.randomUUID();
  return {
    status: "action",
    sessionId: id,
    action: { id: session.actionId, ...step.value },
  };
}

function createHypaMemoryExecutor(): any {
  async function start(rawRequest?: any, context?: any): Promise<any> {
    cleanSessions();
    const request: any = normalizeStartRequest(rawRequest);
    const id: any = crypto.randomUUID();
    const session: any = {
      scope: context.scope,
      generator: createExecution(request, context),
      lastAccess: Date.now(),
      actionId: null,
    };
    sessions.set(id, session);
    try {
      return await advanceSession(id, session, undefined, true);
    } catch (error: any) {
      sessions.delete(id);
      throw error;
    }
  }

  async function resume(
    sessionId?: any,
    actionId?: any,
    value?: any,
    context?: any,
  ): Promise<any> {
    const session: any = sessions.get(sessionId);
    if (!session || session.scope !== context.scope) {
      const error: any = new Error("Hypa memory session not found");
      error.code = "hypa_session_missing";
      throw error;
    }
    if (!actionId || actionId !== session.actionId)
      throw new TypeError("Hypa memory action id does not match");
    session.actionId = null;
    try {
      return await advanceSession(sessionId, session, value, false);
    } catch (error: any) {
      sessions.delete(sessionId);
      throw error;
    }
  }

  function cancel(sessionId?: any, context?: any): any {
    const session: any = sessions.get(sessionId);
    if (session && session.scope === context.scope) sessions.delete(sessionId);
  }

  function registerRoutes(app: any, { auth, limiter, getScope }: any): any {
    const guards: any = limiter ? [limiter] : [];
    app.post(
      "/api/hypa-memory/start",
      ...guards,
      async (req?: any, res?: any, next?: any) => {
        if (auth && !(await auth(req, res))) return;
        try {
          res.send(await start(req.body, { scope: await getScope(req) }));
        } catch (error: any) {
          if (error instanceof TypeError || error instanceof RangeError)
            return res.status(400).send({ error: error.message });
          next(error);
        }
      },
    );
    app.post(
      "/api/hypa-memory/:sessionId/continue",
      ...guards,
      async (req?: any, res?: any, next?: any) => {
        if (auth && !(await auth(req, res))) return;
        try {
          res.send(
            await resume(
              req.params.sessionId,
              req.body?.actionId,
              req.body?.value,
              { scope: await getScope(req) },
            ),
          );
        } catch (error: any) {
          if (error?.code === "hypa_session_missing")
            return res
              .status(404)
              .send({ error: error.message, code: error.code });
          if (error instanceof TypeError || error instanceof RangeError)
            return res.status(400).send({ error: error.message });
          next(error);
        }
      },
    );
    app.delete(
      "/api/hypa-memory/:sessionId",
      ...guards,
      async (req?: any, res?: any, next?: any) => {
        if (auth && !(await auth(req, res))) return;
        try {
          cancel(req.params.sessionId, { scope: await getScope(req) });
          res.status(204).end();
        } catch (error: any) {
          next(error);
        }
      },
    );
  }

  return {
    start,
    resume,
    cancel,
    registerRoutes,
    getQueryCacheStats: getQueryEmbeddingCacheStats,
    clearQueryCache: clearQueryEmbeddingCache,
  };
}

export { createHypaMemoryExecutor };
