"use strict";

const crypto = require("crypto");
const {
  checkVectorIndexRevision,
  syncVectorIndex,
  upsertVectorIndex,
  searchVectorIndex,
} = require("./vectorIndex.cjs");

const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_SESSIONS = 32;
const sessions = new Map();
const HYPA_MODELS = new Set([
  "custom",
  "ada",
  "openai3small",
  "openai3large",
  "voyageContext3",
]);
const DEFAULT_HYPA_MODEL = "openai3small";
const INLAY_RE = /{{(inlay|inlayed|inlayeddata)::(.+?)}}/g;
const QUERY_CACHE_MAX_ENTRIES = Math.min(
  Math.max(
    Number.parseInt(process.env.RISU_HYPA_QUERY_CACHE_ENTRIES || "1024", 10) ||
      1024,
    32,
  ),
  8192,
);
const QUERY_CACHE_MAX_BYTES =
  Math.min(
    Math.max(
      Number.parseInt(process.env.RISU_HYPA_QUERY_CACHE_MB || "16", 10) || 16,
      1,
    ),
    256,
  ) *
  1024 *
  1024;
const queryEmbeddingCache = new Map();
const queryEmbeddingInflight = new Map();
const queryCacheMetrics = new Map();
const queryCacheEpochs = new Map();
let queryCacheBytes = 0;

function hash(value) {
  return crypto
    .createHash("sha256")
    .update(String(value))
    .digest("base64url")
    .slice(0, 32);
}

const secretFingerprintKey = crypto.randomBytes(32);
function secretFingerprint(value) {
  return crypto
    .createHmac("sha256", secretFingerprintKey)
    .update(String(value))
    .digest("base64url");
}

function queryMetric(scope) {
  let metric = queryCacheMetrics.get(scope);
  if (!metric) {
    metric = { hits: 0, misses: 0, coalesced: 0 };
    queryCacheMetrics.set(scope, metric);
  }
  return metric;
}

function queryCacheEpoch(scope) {
  return queryCacheEpochs.get(scope) || 0;
}

function queryProviderFingerprint(config) {
  const model = normalizeHypaModel(config.hypaModel);
  if (model === "custom") {
    return `custom:${appendEmbeddingsPath(config.customEmbedding?.url || "")}:${config.customEmbedding?.model || ""}:${secretFingerprint(config.customEmbedding?.key || "")}`;
  }
  if (model === "voyageContext3")
    return `voyageContext3:${secretFingerprint(config.voyageApiKey || "")}`;
  return `${model}:${secretFingerprint(config.supaMemoryKey || "")}`;
}

function touchQueryCache(key, entry) {
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, entry);
}

function putQueryCache(key, scope, embedding) {
  const vector = Float32Array.from(embedding, (value) => Number(value));
  if (vector.length === 0) return;
  for (const value of vector) if (!Number.isFinite(value)) return;
  const bytes = vector.byteLength;
  if (bytes > QUERY_CACHE_MAX_BYTES) return;
  const existing = queryEmbeddingCache.get(key);
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
    const oldest = queryEmbeddingCache.entries().next().value;
    if (!oldest) break;
    queryEmbeddingCache.delete(oldest[0]);
    queryCacheBytes -= oldest[1].embedding.byteLength;
  }
}

function getQueryEmbeddingCacheStats(scope) {
  let entries = 0;
  let bytes = 0;
  for (const entry of queryEmbeddingCache.values()) {
    if (entry.scope !== scope) continue;
    entries += 1;
    bytes += entry.embedding.byteLength;
  }
  const metric = queryCacheMetrics.get(scope) || {
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

function clearQueryEmbeddingCache(scope) {
  let entries = 0;
  let bytes = 0;
  for (const [key, entry] of Array.from(queryEmbeddingCache.entries())) {
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

function cleanSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) sessions.delete(id);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort(
      (a, b) => a[1].lastAccess - b[1].lastAccess,
    )[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

function normalizeMessage(message, index) {
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

function normalizeStartRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Request body must be an object");
  if (!["legacy", "v2", "v3"].includes(input.mode))
    throw new TypeError("mode must be legacy, v2, or v3");
  if (!Array.isArray(input.chats) || input.chats.length > 4096)
    throw new TypeError("chats must be an array of at most 4096 messages");
  const chats = input.chats.map(normalizeMessage);
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
  const room = input.room && typeof input.room === "object" ? input.room : {};
  const character =
    input.character && typeof input.character === "object"
      ? input.character
      : {};
  return { ...input, chats, room, character };
}

function normalizeHypaModel(model) {
  return HYPA_MODELS.has(model) ? model : DEFAULT_HYPA_MODEL;
}

function appendEmbeddingsPath(url) {
  return String(url).endsWith("/embeddings")
    ? String(url)
    : `${String(url).replace(/\/+$/, "")}/embeddings`;
}

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, redirect: "error" });
  const text = await response.text();
  let data;
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

async function embedRegular(texts, config) {
  if (texts.length === 0) return [];
  const model = normalizeHypaModel(config.hypaModel);
  if (model === "voyageContext3") {
    const groups = await embedVoyageGroups(
      texts.map((text) => [text]),
      config,
      "document",
    );
    return groups.map((group) => group[0]);
  }
  let url = "https://api.openai.com/v1/embeddings";
  let apiModel;
  let key = config.supaMemoryKey || "";
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
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const output = [];
  for (let offset = 0; offset < texts.length; offset += 50) {
    const data = await fetchJson(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: texts.slice(offset, offset + 50),
        ...(apiModel ? { model: apiModel } : {}),
      }),
    });
    if (!Array.isArray(data?.data))
      throw new Error("Embedding response has no data array");
    output.push(...data.data.map((item) => item.embedding));
  }
  return output;
}

async function embedQueries(scope, texts, config) {
  if (texts.length === 0) return [];
  const metric = queryMetric(scope);
  const fingerprint = queryProviderFingerprint(config);
  const output = new Array(texts.length);
  const misses = new Map();
  const waiters = [];

  texts.forEach((text, index) => {
    const key = hash(`${scope}\0${fingerprint}\0query\0${text}`);
    const cached = queryEmbeddingCache.get(key);
    if (cached) {
      metric.hits += 1;
      touchQueryCache(key, cached);
      output[index] = Array.from(cached.embedding);
      return;
    }
    const inflight = queryEmbeddingInflight.get(key);
    if (
      inflight &&
      inflight.scope === scope &&
      inflight.epoch === queryCacheEpoch(scope)
    ) {
      metric.coalesced += 1;
      waiters.push({ index, key, promise: inflight.promise });
      return;
    }
    let pending = misses.get(key);
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
    const pending = Array.from(misses.values());
    const epoch = queryCacheEpoch(scope);
    const batchPromise = (async () => {
      let vectors;
      if (normalizeHypaModel(config.hypaModel) === "voyageContext3") {
        const groups = await embedVoyageGroups(
          pending.map((item) => [item.text]),
          config,
          "query",
        );
        vectors = groups.map((group) => group[0]);
      } else {
        vectors = await embedRegular(
          pending.map((item) => item.text),
          config,
        );
      }
      if (vectors.length !== pending.length)
        throw new Error(
          "Query embedding response length does not match request",
        );
      const byKey = new Map();
      pending.forEach((item, position) => {
        const vector = vectors[position];
        if (queryCacheEpoch(scope) === epoch)
          putQueryCache(item.key, scope, vector);
        byKey.set(item.key, vector);
      });
      return byKey;
    })();

    const inflightEntry = { scope, epoch, promise: batchPromise };
    for (const item of pending)
      queryEmbeddingInflight.set(item.key, inflightEntry);
    try {
      const vectorsByKey = await batchPromise;
      for (const item of pending) {
        const vector = vectorsByKey.get(item.key);
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
    const settled = await Promise.all(
      waiters.map(async (waiter) => ({
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

async function embedVoyageGroups(groups, config, inputType = "document") {
  const key = String(config.voyageApiKey || "").trim();
  if (!key) throw new Error("Voyage Context 3 requires a Voyage API Key");
  const batches = [];
  let batch = [];
  let chunkCount = 0;
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

  const output = [];
  for (const inputs of batches) {
    const data = await fetchJson(
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
      output.push(group.data.map((item) => item.embedding));
  }
  return output;
}

function descriptorRevision(descriptors) {
  return hash(
    descriptors.map((item) => `${item.id}:${item.signature}`).join("\n"),
  );
}

async function prepareIndex(
  scope,
  indexId,
  documents,
  config,
  contextualGroups = null,
) {
  const scopedId = `${scope}:hypa:${indexId}:${normalizeHypaModel(config.hypaModel)}`;
  const contextByIndex = new Map();
  if (contextualGroups) {
    for (const indexes of contextualGroups) {
      const context = indexes.map((i) => documents[i]).join("\0");
      for (const index of indexes) contextByIndex.set(index, context);
    }
  }
  const descriptors = documents.map((text, index) => ({
    id: String(index),
    signature: hash(`${text}\0${contextByIndex.get(index) || ""}`),
  }));
  const revision = descriptorRevision(descriptors);
  const cached = checkVectorIndexRevision(scopedId, revision);
  let status = cached.ready
    ? cached
    : syncVectorIndex(scopedId, descriptors, revision);
  if (status.missingIds.length > 0) {
    const missing = new Set(status.missingIds.map(Number));
    const entries = [];
    if (
      normalizeHypaModel(config.hypaModel) === "voyageContext3" &&
      contextualGroups
    ) {
      for (const indexes of contextualGroups) {
        if (!indexes.some((index) => missing.has(index))) continue;
        const vectors = (
          await embedVoyageGroups(
            [indexes.map((index) => documents[index])],
            config,
            "document",
          )
        )[0];
        indexes.forEach((index, pos) => {
          if (missing.has(index))
            entries.push({
              id: String(index),
              signature: descriptors[index].signature,
              embedding: vectors[pos],
            });
        });
      }
    } else {
      const indexes = [...missing].sort((a, b) => a - b);
      const vectors = await embedRegular(
        indexes.map((index) => documents[index]),
        config,
      );
      indexes.forEach((index, pos) =>
        entries.push({
          id: String(index),
          signature: descriptors[index].signature,
          embedding: vectors[pos],
        }),
      );
    }
    for (let offset = 0; offset < entries.length; offset += 64)
      upsertVectorIndex(scopedId, entries.slice(offset, offset + 64));
  }
  return scopedId;
}

async function rankDocuments(
  scope,
  indexId,
  documents,
  queries,
  config,
  { metric = "dot", topK = null, contextualGroups = null } = {},
) {
  if (documents.length === 0 || queries.length === 0)
    return queries.map(() => []);
  const scopedId = await prepareIndex(
    scope,
    indexId,
    documents,
    config,
    contextualGroups,
  );
  const queryVectors = await embedQueries(scope, queries, config);
  const results = searchVectorIndex(scopedId, queryVectors, metric, topK);
  if (!results) return queries.map(() => []);
  return results.map((rows) => rows.map(([id, score]) => [Number(id), score]));
}

function parseChatMLRaw(data) {
  const starter = "<|im_start|>";
  const separator = "<|im_sep|>";
  const ender = "<|im_end|>";
  const trimmed = String(data).trim();
  if (!trimmed.startsWith(starter)) return null;
  const messages = trimmed
    .split(starter)
    .filter(Boolean)
    .map((raw) => {
      let value = raw;
      let role = "user";
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
      const thoughts = [];
      value = value.replace(/<Thoughts>(.+)<\/Thoughts>/gms, (_, thought) => {
        thoughts.push(thought);
        return "";
      });
      return { role, content: value, thoughts };
    });
  return { messages, parseContents: true };
}

function buildSummaryMessages(prompt, text) {
  const parsed = parseChatMLRaw(String(prompt).replaceAll("{{slot}}", text));
  if (parsed) return parsed;
  return {
    messages: [
      { role: "user", content: text },
      { role: "system", content: prompt },
    ],
    parseContents: false,
  };
}

function sanitizeSummaryText(text) {
  return String(text).replace(INLAY_RE, "[Image]");
}

function validateCounts(value, expected) {
  if (
    !Array.isArray(value) ||
    value.length !== expected ||
    value.some((count) => !Number.isFinite(count) || count < 0)
  ) {
    throw new TypeError("Tokenizer action returned invalid counts");
  }
  return value;
}

async function* tokenize(messages) {
  const result = yield { type: "tokenize", messages };
  return validateCounts(result, messages.length);
}

async function* tokenizeTexts(texts) {
  const result = yield { type: "tokenize-texts", texts };
  return validateCounts(result, texts.length);
}

async function* summarizeTextWithClient(text, prompt) {
  const built = buildSummaryMessages(prompt, text);
  const result = yield {
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
  let output = result.text.trim();
  output = output
    .replace(/<Thoughts>[\s\S]*?<\/Thoughts>/g, "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .trim();
  if (!output) throw new Error("Empty summary after removing thoughts content");
  return output;
}

async function directV2Summary(text, config) {
  const prompt =
    config.supaMemoryPrompt ||
    "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]\n";
  const promptbody = `${text}\n\n${prompt}\n\nOutput:`;
  const model =
    config.supaModelType === "curie"
      ? "text-curie-001"
      : config.supaModelType === "instruct35"
        ? "gpt-3.5-turbo-instruct"
        : "text-davinci-003";
  const data = await fetchJson("https://api.openai.com/v1/completions", {
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
  const result = data?.choices?.[0]?.text?.trim();
  if (!result) throw new Error("SupaMemory: HTTP: empty completion");
  return result;
}

async function* summarizeV2(text, config) {
  if (config.supaModelType === "distilbart") {
    const result = yield { type: "distilbart", text };
    if (!result || result.ok !== true || typeof result.text !== "string")
      throw new Error(result?.error || "DistilBART summarization failed");
    return result.text;
  }
  if (config.supaModelType === "subModel") {
    const prompt =
      config.supaMemoryPrompt ||
      "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]\n";
    return yield* summarizeTextWithClient(text, prompt);
  }
  return directV2Summary(text, config);
}

async function* summarizeLegacy(text, config) {
  if (config.supaModelType === "distilbart") {
    const result = yield { type: "distilbart", text };
    if (!result || result.ok !== true || typeof result.text !== "string")
      throw new Error(result?.error || "DistilBART summarization failed");
    return result.text;
  }
  const prompt =
    config.supaMemoryPrompt ||
    "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output to reduce tokens for gpt3 and other sublanguage models]\n";
  if (config.supaModelType === "subModel")
    return yield* summarizeTextWithClient(text, prompt);
  return directV2Summary(text, { ...config, supaMemoryPrompt: prompt });
}

function legacyStringlizeChat(chats, characterName) {
  const parts = [];
  for (const chat of chats) {
    if (chat.memo?.startsWith("inlayImage")) continue;
    if (chat.role === "system") parts.push(`system: ${chat.content}`);
    else if (chat.name) parts.push(`${chat.name}: ${chat.content}`);
    else parts.push(chat.content);
  }
  return `${parts.join("\n\n")}\n\n${characterName}:`;
}

function stripHypaPunctuation(text) {
  return String(text).replace(/[\.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
}

function isSubset(list, available) {
  for (const item of list) if (!available.has(item)) return false;
  return true;
}

async function* runLegacy(request, context) {
  const chats = request.chats.map((chat) => ({ ...chat }));
  const config = request.config;
  const maxContextTokens = request.maxContextTokens;
  let currentTokens = request.currentTokens + 10;

  if (currentTokens <= maxContextTokens) return { currentTokens, chats };

  let chatTokenCounts = yield* tokenize(chats);
  const prefixTokens = (count) =>
    chatTokenCounts
      .slice(0, Math.max(0, count))
      .reduce((sum, value) => sum + value, 0);
  const discardPrefix = (count) => {
    if (count <= 0) return;
    currentTokens -= prefixTokens(count);
    chats.splice(0, count);
    chatTokenCounts.splice(0, count);
  };

  const newChatIndex = chats.findIndex((chat) => chat.memo === "NewChat");
  if (newChatIndex !== -1) discardPrefix(newChatIndex);

  let supaMemory = "";
  let hypaChunks = [];
  let lastId = "";
  let hypaData = [];

  if (
    typeof request.room.supaMemoryData === "string" &&
    request.room.supaMemoryData.length > 4
  ) {
    const parts = request.room.supaMemoryData.split("\n");
    const id = parts.shift() || "";
    const storedData = parts.join("\n");
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
      let selected = -1;
      for (let index = 0; index < hypaData.length; index++) {
        const chatIndex = chats.findIndex(
          (chat) => chat.memo === hypaData[index]?.id,
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

  let hypaResult = "";
  hypaChunks = hypaChunks.filter(
    (value) => typeof value === "string" && value.length > 1,
  );
  if (hypaChunks.length > 0) {
    const seen = new Set();
    const retrievalTexts = [];
    for (const value of hypaChunks) {
      if (seen.has(value)) continue;
      seen.add(value);
      const normalized = config.removePunctuationHypa
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
      const filteredChat = chats.filter(
        (chat) => chat.role !== "system" && chat.role !== "function",
      );
      const query = legacyStringlizeChat(
        filteredChat.slice(0, 4),
        request.character.name || "",
      );
      const ranked = await rankDocuments(
        context.scope,
        `legacy:${request.character.id || ""}:${request.room.id || ""}`,
        retrievalTexts,
        [query],
        config,
        { metric: "dot", topK: 3 },
      );
      const selectedTexts = (ranked[0] || [])
        .map(([index]) => retrievalTexts[index])
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

  const plainCount = async function* (text) {
    return (yield* tokenizeTexts([text]))[0];
  };

  while (currentTokens > maxContextTokens) {
    const beforeToken = currentTokens;
    let maxChunkSize = Math.floor(maxContextTokens / 3);
    if (Number(config.maxSupaChunkSize || 0) < maxChunkSize)
      maxChunkSize = Number(config.maxSupaChunkSize || 0);
    let summarized = false;
    let chunkSize = 0;
    let stringlizedChat = "";
    let spiceLen = 0;

    while (true) {
      const cont = chats[spiceLen];
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
          let result;
          try {
            result = yield* summarizeLegacy(supaMemory, config);
          } catch (error) {
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

      const tokens = chatTokenCounts[spiceLen];
      if (chunkSize + tokens > maxChunkSize) {
        if (
          stringlizedChat === "" &&
          cont.role !== "function" &&
          cont.role !== "system"
        ) {
          const speaker =
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

      const speaker =
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
      let result;
      try {
        result = yield* summarizeLegacy(stringlizedChat, config);
      } catch (error) {
        return { currentTokens, chats, error: `SupaMemory: HTTP: ${error}` };
      }

      const resultTokens = yield* plainCount(`${result}\n\n`);
      hypaChunks.push(result.replace(/\n+/g, "\n"));
      let supaList = supaMemory
        .split("\n\n")
        .filter((value) => value.length > 1);
      if (supaList.length >= 3) {
        const oldSupa = supaMemory;
        try {
          supaMemory = yield* summarizeLegacy(supaMemory, config);
        } catch (error) {
          return { currentTokens, chats, error: `SupaMemory: HTTP: ${error}` };
        }
        currentTokens -= yield* plainCount(oldSupa);
        currentTokens += yield* plainCount(supaMemory);
      }
      supaList = supaMemory.split("\n\n").filter((value) => value.length > 1);
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

function normalizeV2Data(raw, chats) {
  if (!raw) return { lastMainChunkID: 0, chunks: [], mainChunks: [] };
  if (
    Array.isArray(raw.mainChunks) &&
    raw.mainChunks.every((chunk) => typeof chunk?.targetId === "string")
  ) {
    const oldMainChunks = raw.mainChunks.slice().reverse();
    const oldChunks = Array.isArray(raw.chunks) ? raw.chunks : [];
    const data = { lastMainChunkID: 0, mainChunks: [], chunks: [] };
    let previousTarget = null;
    for (const old of oldMainChunks) {
      const end = chats.findIndex((chat) => chat.memo === old.targetId);
      const start = previousTarget
        ? chats.findIndex((chat) => chat.memo === previousTarget)
        : 0;
      if (end < 0 || start < 0) continue;
      const lo = previousTarget ? Math.min(start, end) : 0;
      const hi = Math.max(start, end);
      const id = data.lastMainChunkID++;
      data.mainChunks.push({
        id,
        text: old.text,
        chatMemos: chats.slice(lo, hi + 1).map((chat) => chat.memo),
        lastChatMemo: old.targetId,
      });
      for (const chunk of oldChunks.filter(
        (chunk) => chunk.targetId === old.targetId,
      ))
        data.chunks.push({ mainChunkID: id, text: chunk.text });
      previousTarget = old.targetId;
    }
    return data;
  }
  return {
    lastMainChunkID: Number(raw.lastMainChunkID) || 0,
    chunks: Array.isArray(raw.chunks)
      ? raw.chunks.map((chunk) => ({ ...chunk }))
      : [],
    mainChunks: Array.isArray(raw.mainChunks)
      ? raw.mainChunks.map((chunk) => ({
          ...chunk,
          chatMemos: Array.isArray(chunk.chatMemos)
            ? chunk.chatMemos.slice()
            : [],
        }))
      : [],
  };
}

async function* runV2(request, context) {
  const chats = request.chats.map((chat) => ({ ...chat }));
  const config = request.config;
  let currentTokens = request.currentTokens - Number(config.maxResponse || 0);
  const maxContextTokens = request.maxContextTokens;
  const data = normalizeV2Data(request.room.hypaV2Data, chats);
  const memoSet = new Set(chats.map((chat) => chat.memo));
  data.mainChunks = data.mainChunks.filter((chunk) =>
    isSubset(chunk.chatMemos, memoSet),
  );
  const validIds = new Set(data.mainChunks.map((chunk) => chunk.id));
  data.chunks = data.chunks.filter((chunk) => validIds.has(chunk.mainChunkID));
  data.lastMainChunkID = data.mainChunks.at(-1)?.id ?? 0;
  const chatTokenCounts = yield* tokenize(chats);
  const allocatedTokens = Number(config.hypaAllocatedTokens || 0);
  const chunkSize = Number(config.hypaChunkSize || 0);
  currentTokens += allocatedTokens;
  const lastTwoChats = chats.slice(-2);
  let idx = 0;
  if (data.mainChunks.length > 0) {
    const lastIndex = chats.findIndex(
      (chat) => chat.memo === data.mainChunks.at(-1).lastChatMemo,
    );
    if (lastIndex >= 0) {
      idx = lastIndex + 1;
      currentTokens -= chatTokenCounts
        .slice(0, lastIndex + 1)
        .reduce((a, b) => a + b, 0);
    }
  }
  let failures = 0;
  while (currentTokens > maxContextTokens) {
    const batch = [];
    let batchTokens = 0;
    while (batchTokens < chunkSize && idx < chats.length - 4) {
      const chat = chats[idx];
      const tokens = chatTokenCounts[idx];
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
      const message =
        idx >= chats.length - 4
          ? `[HypaV2] Input tokens (${currentTokens}) exceeds max context size (${maxContextTokens}), but can't summarize last 4 messages. Please increase max context size to at least ${currentTokens}.`
          : `[HypaV2] Message tokens (${chatTokenCounts[idx]}) exceeds chunk size (${chunkSize}). Please increase chunk size to at least ${chatTokenCounts[idx]}.`;
      return { currentTokens, chats, error: message };
    }
    try {
      const summary = yield* summarizeV2(
        batch.map((chat) => `${chat.role}: ${chat.content}`).join("\n"),
        config,
      );
      failures = 0;
      const summaryTokens = (yield* tokenize([
        { role: "system", content: summary },
      ]))[0];
      void summaryTokens;
      data.lastMainChunkID++;
      const id = data.lastMainChunkID;
      data.mainChunks.push({
        id,
        text: summary,
        chatMemos: batch.map((chat) => chat.memo),
        lastChatMemo: batch.at(-1).memo,
      });
      for (const text of summary
        .split("\n\n")
        .map((value) => value.trim())
        .filter(Boolean))
        data.chunks.push({ mainChunkID: id, text });
      currentTokens -= batchTokens;
    } catch (error) {
      if (++failures >= 3)
        return {
          currentTokens,
          chats,
          error:
            "[HypaV2] Summarization failed multiple times. Aborting to prevent infinite loop.",
        };
    }
  }
  const mainCandidates = data.mainChunks.map((chunk) => ({
    role: "system",
    content: chunk.text,
  }));
  const mainCounts = yield* tokenize(mainCandidates);
  let mainPrompt = "";
  let mainPromptTokens = 0;
  for (let i = 0; i < data.mainChunks.length; i++) {
    if (mainPromptTokens + mainCounts[i] > allocatedTokens / 2) break;
    mainPrompt += `\n\n${data.mainChunks[i].text}`;
    mainPromptTokens += mainCounts[i];
  }
  const prefix = "search_document: ";
  const documents = data.chunks
    .filter((chunk) => chunk.text.trim())
    .map((chunk) => prefix + chunk.text.trim());
  const recentQueries = [];
  for (let i = 0; i < 3; i++) {
    const chat = chats[chats.length - i - 1];
    if (chat) recentQueries.push(`search_query: ${chat.content}`);
  }
  const rankedLists = await rankDocuments(
    context.scope,
    `hypav2:${request.character.id || ""}:${request.room.id || ""}`,
    documents,
    recentQueries,
    config,
    { metric: "dot" },
  );
  const scoreMap = new Map();
  rankedLists.forEach((rows, listIndex) =>
    rows.forEach(([docIndex, score]) =>
      scoreMap.set(
        docIndex,
        (scoreMap.get(docIndex) || 0) + score / (listIndex + 1),
      ),
    ),
  );
  const rankedIndexes = [...scoreMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([index]) => index);
  const candidateTexts = rankedIndexes.map((index) =>
    documents[index].substring(prefix.length),
  );
  const candidateCounts = yield* tokenize(
    candidateTexts.map((content) => ({ role: "system", content })),
  );
  let details = "";
  let detailTokens = 0;
  for (let i = 0; i < candidateTexts.length; i++) {
    if (candidateCounts[i] > allocatedTokens - mainPromptTokens - detailTokens)
      break;
    details += candidateTexts[i] + "\n\n";
    detailTokens += candidateCounts[i];
  }
  const fullResult = `<Past Events Summary>${mainPrompt}</Past Events Summary>\n<Past Events Details>${details}</Past Events Details>`;
  currentTokens += (yield* tokenize([
    { role: "system", content: fullResult },
  ]))[0];
  const resultChats = [
    { role: "system", content: fullResult, memo: "supaMemory" },
    ...chats.slice(idx),
  ];
  for (const chat of lastTwoChats)
    if (!resultChats.some((item) => item.memo === chat.memo))
      resultChats.push(chat);
  currentTokens -= allocatedTokens;
  return { currentTokens, chats: resultChats, memory: data };
}

function normalizeV3Data(raw) {
  return {
    ...(raw && typeof raw === "object" ? raw : {}),
    summaries: Array.isArray(raw?.summaries)
      ? raw.summaries.map((summary) => ({
          ...summary,
          chatMemos: Array.isArray(summary.chatMemos)
            ? summary.chatMemos.slice()
            : [],
        }))
      : [],
  };
}

function splitBySeparator(text, separator) {
  try {
    const match = String(separator).match(/^\/(.+)\/([gimuy]*)$/);
    return String(text).split(
      match ? new RegExp(match[1], match[2]) : new RegExp(separator),
    );
  } catch {
    return String(text).split("\n\n");
  }
}

function weightedRank(lists, weightFn) {
  const scores = new Map();
  lists.forEach((list, listIndex) =>
    list.forEach(([item, score]) =>
      scores.set(
        item,
        (scores.get(item) || 0) + score * weightFn(listIndex, lists.length),
      ),
    ),
  );
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([item]) => item);
}

function childToParentRRF(children, parentFor, k = 60) {
  const scores = new Map();
  children.forEach((child, index) => {
    const parent = parentFor(child);
    scores.set(parent, (scores.get(parent) || 0) + 1 / (k + index + 1));
  });
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([parent]) => parent);
}

async function* summarizeV3(chats, settings, isResummarize = false) {
  const prompt = isResummarize
    ? String(settings.reSummarizationPrompt || "").trim() ||
      "Re-summarize this summaries."
    : String(settings.summarizationPrompt || "").trim() ||
      "[Summarize the ongoing role story, It must also remove redundancy and unnecessary text and content from the output.]";
  const text = chats
    .map((chat) => `${chat.role}: ${sanitizeSummaryText(chat.content)}`)
    .join("\n");
  return yield* summarizeTextWithClient(text, prompt);
}

function addWithinBudget(candidates, tokenMap, budget, output) {
  let used = 0;
  for (const item of candidates) {
    const tokens = tokenMap.get(item) || 0;
    if (tokens + used > budget) break;
    output.push(item);
    used += tokens;
  }
  return used;
}

async function rankV3Summaries(
  request,
  context,
  data,
  selected,
  settings,
  chats,
  experimental,
) {
  const unused = data.summaries
    .map((summary, index) => ({ summary, index }))
    .filter(({ summary }) => !selected.includes(summary));
  const docs = [];
  const contextualGroups = [];
  for (const { summary, index } of unused) {
    const group = [];
    for (const chunk of splitBySeparator(
      summary.text,
      settings.summaryChunkSeparator,
    )
      .map((value) => value.trim())
      .filter(Boolean)) {
      group.push(docs.length);
      docs.push({ text: chunk, summaryIndex: index });
    }
    if (group.length) contextualGroups.push(group);
  }
  if (!docs.length) return [];
  const groups =
    normalizeHypaModel(request.config.hypaModel) === "voyageContext3"
      ? contextualGroups
      : null;
  if (experimental) {
    const recent = chats
      .slice(-settings.queryChatCount)
      .filter((chat) => chat.content.trim());
    const queries = recent.flatMap((chat, index) => {
      const parts = chat.content.split("\n\n").filter((value) => value.trim());
      const base = (index + 1) / ((recent.length * (recent.length + 1)) / 2);
      return parts.map((content) => ({ content, weight: base / parts.length }));
    });
    if (!queries.length) return [];
    const lists = await rankDocuments(
      context.scope,
      `hypav3-exp:${request.character.id || ""}:${request.room.id || ""}`,
      docs.map((doc) => doc.text),
      queries.map((query) => query.content),
      request.config,
      { metric: "cosine", contextualGroups: groups },
    );
    const rankedChildren = weightedRank(
      lists,
      (index) => queries[index].weight,
    );
    return childToParentRRF(
      rankedChildren,
      (docIndex) => docs[docIndex].summaryIndex,
    ).map((index) => data.summaries[index]);
  }
  const recent = chats
    .slice(-settings.queryChatCount)
    .filter((chat) => chat.content.trim());
  if (!recent.length) return [];
  const queryTexts = recent.map((chat) => chat.content);
  return { docs, groups, queryTexts, recent };
}

async function* runV3(request, context) {
  const chats = request.chats.map((chat) => ({ ...chat }));
  const config = request.config;
  const settings = config.v3Settings || {};
  const experimental = settings.useExperimentalImpl === true;
  let currentTokens = request.currentTokens - Number(config.maxResponse || 0);
  const maxContextTokens = request.maxContextTokens;
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
  const data = normalizeV3Data(request.room.hypaV3Data);
  if (!settings.preserveOrphanedMemory) {
    const memos = new Set(chats.map((chat) => chat.memo));
    data.summaries = data.summaries.filter((summary) =>
      isSubset(summary.chatMemos, memos),
    );
  }
  const chatTokenCounts = yield* tokenize(chats);
  let startIdx = 0;
  if (data.summaries.length) {
    const lastMemo = data.summaries.at(-1).chatMemos.at(-1);
    const lastIndex = chats.findIndex((chat) => chat.memo === lastMemo);
    if (lastIndex >= 0) {
      startIdx = lastIndex + 1;
      currentTokens -= chatTokenCounts
        .slice(0, lastIndex + 1)
        .reduce((a, b) => a + b, 0);
    }
  }
  const emptyMemory = "<Past Events Summary>\n\n</Past Events Summary>";
  const emptyTokens = (yield* tokenize([
    { role: "system", content: emptyMemory },
  ]))[0];
  const memoryTokens = Math.floor(
    maxContextTokens * Number(settings.memoryTokensRatio || 0),
  );
  let availableMemoryTokens;
  let reserveKind;
  if (experimental) {
    const reserve =
      data.summaries.length > 0 || currentTokens > maxContextTokens;
    availableMemoryTokens = reserve ? memoryTokens - emptyTokens : 0;
    if (reserve) {
      currentTokens += memoryTokens;
      reserveKind = "full";
    } else reserveKind = "none";
  } else {
    const reserveEmpty =
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
  const targetTokens =
    maxContextTokens * (1 - Number(settings.extraSummarizationRatio || 0));
  const summarizationMode = currentTokens > maxContextTokens;
  if (experimental) {
    const batches = [];
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
      const batch = [];
      let tokens = 0;
      let index = startIdx;
      while (
        batch.length < Number(settings.maxChatsPerSummary || 1) &&
        index < chats.length - Number(settings.queryChatCount || 0)
      ) {
        const chat = chats[index];
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
        const text = yield* summarizeV3(batch, settings);
        data.summaries.push({
          text,
          chatMemos: batch.map((chat) => chat.memo),
          isImportant: false,
          tags: [],
        });
      } catch (error) {
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
      const end = Math.min(
        startIdx + Number(settings.maxChatsPerSummary || 1),
        chats.length - Number(settings.queryChatCount || 0),
      );
      const batch = [];
      let tokens = 0;
      for (let i = startIdx; i < end; i++) {
        const chat = chats[i];
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
          const text = yield* summarizeV3(batch, settings);
          data.summaries.push({
            text,
            chatMemos: batch.map((chat) => chat.memo),
            isImportant: false,
            tags: [],
          });
        } catch (error) {
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
    const resultChats = experimental
      ? chats.slice(startIdx)
      : [
          { role: "system", content: emptyMemory, memo: "supaMemory" },
          ...chats.slice(startIdx),
        ];
    return { currentTokens, chats: resultChats, memory: data };
  }
  const summaryMessages = data.summaries.map((summary) => ({
    role: "system",
    content: `${summary.text}\n\n`,
  }));
  const summaryCounts = yield* tokenize(summaryMessages);
  const tokenMap = new Map(
    data.summaries.map((summary, index) => [
      summary,
      summaryCounts[index] || 0,
    ]),
  );
  const selected = [];
  const important = data.summaries.filter((summary) => summary.isImportant);
  let importantUsed = addWithinBudget(
    important,
    tokenMap,
    availableMemoryTokens,
    selected,
  );
  availableMemoryTokens -= importantUsed;
  const recentRatio = Number(settings.recentMemoryRatio || 0);
  const similarRatio = Number(settings.similarMemoryRatio || 0);
  const randomRatio = 1 - recentRatio - similarRatio;
  let reservedRecent = Math.floor(availableMemoryTokens * recentRatio);
  let usedRecent = 0;
  const recentSelected = [];
  if (recentRatio > 0) {
    const unused = data.summaries
      .filter((summary) => !selected.includes(summary))
      .reverse();
    usedRecent = addWithinBudget(
      unused,
      tokenMap,
      reservedRecent,
      recentSelected,
    );
    selected.push(...recentSelected);
  }
  let reservedSimilar = Math.floor(availableMemoryTokens * similarRatio);
  if (randomRatio <= 0) reservedSimilar += reservedRecent - usedRecent;
  const similarSelected = [];
  let usedSimilar = 0;
  if (similarRatio > 0) {
    let ranked;
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
      const prep = await rankV3Summaries(
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
        const queryTexts = prep.queryTexts.slice();
        if (settings.enableSimilarityCorrection && prep.recent.length > 1) {
          try {
            queryTexts.push(yield* summarizeV3(prep.recent, settings));
          } catch (error) {
            return {
              currentTokens,
              chats,
              error: `[HypaV3] Summarization failed: ${error}`,
              memory: data,
            };
          }
        }
        const lists = await rankDocuments(
          context.scope,
          `hypav3:${request.character.id || ""}:${request.room.id || ""}`,
          prep.docs.map((doc) => doc.text),
          queryTexts,
          config,
          { metric: "dot", contextualGroups: prep.groups },
        );
        const rankedChildren = weightedRank(
          lists,
          (index, total) => (index + 1) / ((total * (total + 1)) / 2),
        );
        ranked = childToParentRRF(
          rankedChildren,
          (docIndex) => prep.docs[docIndex].summaryIndex,
        ).map((index) => data.summaries[index]);
      }
    }
    for (const summary of ranked || []) {
      const tokens = tokenMap.get(summary) || 0;
      if (tokens + usedSimilar > reservedSimilar) break;
      similarSelected.push(summary);
      usedSimilar += tokens;
    }
    selected.push(...similarSelected);
  }
  let reservedRandom = Math.floor(availableMemoryTokens * randomRatio);
  const randomSelected = [];
  if (randomRatio > 0) {
    reservedRandom +=
      reservedRecent - usedRecent + (reservedSimilar - usedSimilar);
    const candidates = data.summaries
      .filter((summary) => !selected.includes(summary))
      .sort(() => Math.random() - 0.5);
    let used = 0;
    for (const summary of candidates) {
      const tokens = tokenMap.get(summary) || 0;
      if (tokens + used > reservedRandom) continue;
      selected.push(summary);
      randomSelected.push(summary);
      used += tokens;
    }
  }
  selected.sort(
    (a, b) => data.summaries.indexOf(a) - data.summaries.indexOf(b),
  );
  const memoryText = `<Past Events Summary>\n${selected.map((summary) => summary.text).join("\n\n")}\n</Past Events Summary>`;
  const realMemoryTokens = (yield* tokenize([
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
      .filter((summary) => selected.includes(summary))
      .map((summary) => data.summaries.indexOf(summary)),
    lastRecentSummaries: recentSelected.map((summary) =>
      data.summaries.indexOf(summary),
    ),
    lastSimilarSummaries: similarSelected.map((summary) =>
      data.summaries.indexOf(summary),
    ),
    lastRandomSummaries: randomSelected.map((summary) =>
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

function createExecution(request, context) {
  if (request.mode === "legacy") return runLegacy(request, context);
  return request.mode === "v2"
    ? runV2(request, context)
    : runV3(request, context);
}

async function advanceSession(id, session, value, first = false) {
  session.lastAccess = Date.now();
  const step = first
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

function createHypaMemoryExecutor() {
  async function start(rawRequest, context) {
    cleanSessions();
    const request = normalizeStartRequest(rawRequest);
    const id = crypto.randomUUID();
    const session = {
      scope: context.scope,
      generator: createExecution(request, context),
      lastAccess: Date.now(),
      actionId: null,
    };
    sessions.set(id, session);
    try {
      return await advanceSession(id, session, undefined, true);
    } catch (error) {
      sessions.delete(id);
      throw error;
    }
  }

  async function resume(sessionId, actionId, value, context) {
    const session = sessions.get(sessionId);
    if (!session || session.scope !== context.scope) {
      const error = new Error("Hypa memory session not found");
      error.code = "hypa_session_missing";
      throw error;
    }
    if (!actionId || actionId !== session.actionId)
      throw new TypeError("Hypa memory action id does not match");
    session.actionId = null;
    try {
      return await advanceSession(sessionId, session, value, false);
    } catch (error) {
      sessions.delete(sessionId);
      throw error;
    }
  }

  function cancel(sessionId, context) {
    const session = sessions.get(sessionId);
    if (session && session.scope === context.scope) sessions.delete(sessionId);
  }

  function registerRoutes(app, { auth, limiter, getScope }) {
    const guards = limiter ? [limiter] : [];
    app.post("/api/hypa-memory/start", ...guards, async (req, res, next) => {
      if (auth && !(await auth(req, res))) return;
      try {
        res.send(await start(req.body, { scope: await getScope(req) }));
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError)
          return res.status(400).send({ error: error.message });
        next(error);
      }
    });
    app.post(
      "/api/hypa-memory/:sessionId/continue",
      ...guards,
      async (req, res, next) => {
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
        } catch (error) {
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
      async (req, res, next) => {
        if (auth && !(await auth(req, res))) return;
        try {
          cancel(req.params.sessionId, { scope: await getScope(req) });
          res.status(204).end();
        } catch (error) {
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

module.exports = { createHypaMemoryExecutor };
