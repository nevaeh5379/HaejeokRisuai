import { settingsStore } from "src/ts/stores/domain/settingsStore.svelte";
import localforage from "localforage";
import { forageStorage, globalFetch } from "src/ts/globalApi.svelte";
import { appendLastPath } from "src/ts/util";

import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { isNodeServer } from "src/ts/platform";
import { NodeStorage } from "src/ts/storage/files/nodeStorage";
import {
  vectorContentSignature,
  vectorDescriptorRevision,
  vectorTextRevision,
} from "./vectorIndexSignature";

export type HypaModel =
  | "custom"
  | "ada"
  | "openai3small"
  | "openai3large"
  | "voyageContext3";

export const DEFAULT_HYPA_MODEL: HypaModel = "openai3small";
const EMBEDDING_CACHE_BATCH_SIZE = 128;


const supportedHypaModels = new Set<HypaModel>([
  "custom",
  "ada",
  "openai3small",
  "openai3large",
  "voyageContext3",
]);

export function normalizeHypaModel(model: unknown): HypaModel {
  if (typeof model === "string" && supportedHypaModels.has(model as HypaModel)) {
    return model as HypaModel;
  }
  return DEFAULT_HYPA_MODEL;
}

export class HypaProcesser {
  oaikey: string;
  vectors: memoryVector[];
  forage: LocalForage;
  model: HypaModel;
  customEmbeddingUrl: string;
  serverIndexId?: string;
  private serverIndexedContents: string[] | null = null;

  constructor(model: HypaModel | "auto" = "auto", customEmbeddingUrl?: string, serverIndexId?: string) {
    this.forage = localforage.createInstance({
      name: "hypaVector",
    });
    this.vectors = [];
    const db = settingsStore.state;
    this.model = normalizeHypaModel(model === "auto" ? db.hypaModel : model);
    this.customEmbeddingUrl =
      customEmbeddingUrl?.trim() || db.hypaCustomSettings?.url?.trim() || "";
    this.serverIndexId = serverIndexId;
  }

  async embedDocuments(texts: string[]): Promise<VectorArray[]> {
    const subPrompts = chunkArray(texts, 50);

    const embeddings: VectorArray[] = [];

    for (let i = 0; i < subPrompts.length; i += 1) {
      const input = subPrompts[i];

      const data = await this.getEmbeds(input, "document");

      embeddings.push(...data);
    }

    return embeddings;
  }

  async getEmbeds(
    input: string[] | string,
    inputType: "query" | "document" = "query",
  ): Promise<VectorArray[]> {
    if (isContextModel(this.model)) {
      const provider = getContextProvider(this.model);
      const inputs: string[] = Array.isArray(input) ? input : [input];
      if (inputType === "query") {
        return await provider.embedQueries(inputs);
      }
      const groups = inputs.map((s) => [s]);
      const results = await provider.embedDocumentGroups(groups);
      return results.map((group) => group[0]);
    }
    let gf = null;
    if (this.model === "custom") {
      if (!this.customEmbeddingUrl) {
        throw new Error("Custom model requires a Custom Server URL");
      }
      const { customEmbeddingUrl } = this;
      const replaceUrl = customEmbeddingUrl.endsWith("/embeddings")
        ? customEmbeddingUrl
        : appendLastPath(customEmbeddingUrl, "embeddings");

      const db = settingsStore.state;
      const fetchArgs = {
        headers: {
          ...(db.hypaCustomSettings?.key?.trim()
            ? { Authorization: "Bearer " + db.hypaCustomSettings.key.trim() }
            : {}),
        },
        body: {
          input: input,
          ...(db.hypaCustomSettings?.model?.trim()
            ? { model: db.hypaCustomSettings.model.trim() }
            : {}),
        },
      };

      gf = await globalFetch(replaceUrl.toString(), fetchArgs);
    }
    if (
      this.model === "ada" ||
      this.model === "openai3small" ||
      this.model === "openai3large"
    ) {
      const db = settingsStore.state;
      const models = {
        ada: "text-embedding-ada-002",
        openai3small: "text-embedding-3-small",
        openai3large: "text-embedding-3-large",
      };

      gf = await globalFetch("https://api.openai.com/v1/embeddings", {
        headers: {
          Authorization:
            "Bearer " + (this.oaikey?.trim() || db.supaMemoryKey?.trim()),
        },
        body: {
          input: input,
          model: models[this.model],
        },
      });
    }
    const data = gf.data;

    if (!gf.ok) {
      throw JSON.stringify(gf.data);
    }

    const result: number[][] = [];
    for (let i = 0; i < data.data.length; i++) {
      result.push(data.data[i].embedding);
    }

    return result;
  }

  async testText(text: string) {
    const forageResult: number[] = await this.forage.getItem(text);
    if (forageResult) {
      return forageResult;
    }
    const vec = (await this.embedDocuments([text]))[0];
    await this.forage.setItem(text, vec);
    return vec;
  }

  private getEmbeddingCacheKey(text: string): string {
    const db = settingsStore.state;
    const suffix =
      this.model === "custom" && db.hypaCustomSettings?.model?.trim()
        ? `-${db.hypaCustomSettings.model.trim()}`
        : "";
    return text + "|" + this.model + suffix;
  }

  private getServerVectorIndexId(): string | null {
    if (!this.serverIndexId || isContextModel(this.model)) return null;
    const db = settingsStore.state;
    return [
      this.serverIndexId,
      this.model,
      this.model === "custom" ? this.customEmbeddingUrl : "",
      this.model === "custom" ? db.hypaCustomSettings?.model?.trim() || "" : "",
    ].join("|");
  }

  private async loadCachedVectors(
    texts: string[],
  ): Promise<Array<memoryVector | null>> {
    const results: Array<memoryVector | null> = [];
    for (
      let offset = 0;
      offset < texts.length;
      offset += EMBEDDING_CACHE_BATCH_SIZE
    ) {
      const batch = texts.slice(offset, offset + EMBEDDING_CACHE_BATCH_SIZE);
      const loaded = await Promise.all(
        batch.map((text) =>
          this.forage.getItem<memoryVector>(this.getEmbeddingCacheKey(text)),
        ),
      );
      results.push(...loaded);
    }
    return results;
  }

  private async saveCachedVectors(vectors: memoryVector[]): Promise<void> {
    for (
      let offset = 0;
      offset < vectors.length;
      offset += EMBEDDING_CACHE_BATCH_SIZE
    ) {
      const batch = vectors.slice(offset, offset + EMBEDDING_CACHE_BATCH_SIZE);
      await Promise.all(
        batch.map((vector) =>
          this.forage.setItem(this.getEmbeddingCacheKey(vector.content), vector),
        ),
      );
    }
  }

  async addText(texts: string[]) {
    const cached = await this.loadCachedVectors(texts);
    for (const item of cached) {
      if (!item) continue;
      item.alreadySaved = true;
      this.vectors.push(item);
    }

    const existingContents = new Set(this.vectors.map((vector) => vector.content));
    texts = texts.filter((text) => !existingContents.has(text));
    if (texts.length === 0) return;

    const vectors = await this.embedDocuments(texts);
    const memoryVectors: memoryVector[] = vectors.map((embedding, index) => ({
      content: texts[index],
      embedding,
    }));
    await this.saveCachedVectors(memoryVectors);
    this.vectors = memoryVectors.concat(this.vectors);
  }

  /**
   * Prepare a Node-side text vector index without materializing every cached
   * embedding in browser memory. Only vectors missing from the server index are
   * read from IndexedDB or requested from the embedding API.
   */
  async prepareServerTextIndex(texts: string[]): Promise<boolean> {
    if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
      return false;
    }
    const indexId = this.getServerVectorIndexId();
    if (!indexId) return false;

    const revision = vectorTextRevision(texts);

    try {
      const storage = forageStorage.realStorage;
      const revisionStatus = await storage.vectorIndexStatus(
        indexId,
        undefined,
        revision,
      );
      if (revisionStatus.ready) {
        this.serverIndexedContents = texts.slice();
        return true;
      }
      const descriptors = texts.map((text, index) => ({
        id: String(index),
        signature: vectorContentSignature(text),
      }));
      const status = await storage.vectorIndexStatus(
        indexId,
        descriptors,
        revision,
      );
      if (status.missingIds.length > 0) {
        const missing = status.missingIds
          .map((id) => ({ id, index: Number(id) }))
          .filter(
            (entry) =>
              Number.isSafeInteger(entry.index) &&
              entry.index >= 0 &&
              entry.index < texts.length,
          );
        const uniqueTexts = [...new Set(missing.map((entry) => texts[entry.index]))];
        const cached = await this.loadCachedVectors(uniqueTexts);
        const embeddingByText = new Map<string, VectorArray>();
        const uncachedTexts: string[] = [];

        for (let i = 0; i < uniqueTexts.length; i++) {
          const vector = cached[i];
          if (vector?.embedding?.length) {
            embeddingByText.set(uniqueTexts[i], vector.embedding);
          } else {
            uncachedTexts.push(uniqueTexts[i]);
          }
        }

        if (uncachedTexts.length > 0) {
          const embeddings = await this.embedDocuments(uncachedTexts);
          const generated = uncachedTexts.map((content, index) => ({
            content,
            embedding: embeddings[index],
          }));
          await this.saveCachedVectors(generated);
          for (const vector of generated) {
            embeddingByText.set(vector.content, vector.embedding);
          }
        }

        await storage.vectorIndexUpsert(
          indexId,
          missing.map((entry) => {
            const content = texts[entry.index];
            const embedding = embeddingByText.get(content);
            if (!embedding) {
              throw new Error(`Missing embedding for vector index entry ${entry.id}`);
            }
            return {
              id: entry.id,
              signature: vectorContentSignature(content),
              embedding: Array.from(embedding),
            };
          }),
        );
      }

      this.serverIndexedContents = texts.slice();
      return true;
    } catch (error) {
      console.warn(
        "[HypaProcesser] Failed to prepare server text index; using browser vectors",
        error,
      );
      this.serverIndexedContents = null;
      return false;
    }
  }

  async similaritySearch(query: string, topK?: number) {
    const results = await this.similaritySearchVectorWithScore(
      (await this.getEmbeds(query))[0],
      topK,
    );
    return results.map((result) => result[0]);
  }

  async similaritySearchScored(query: string, topK?: number) {
    return await this.similaritySearchVectorWithScore(
      (await this.getEmbeds(query))[0],
      topK,
    );
  }

  protected async similaritySearchVectorWithScore(
    query: VectorArray,
    topK?: number,
  ): Promise<[string, number][]> {
    const serverResult = await this.tryServerSimilaritySearch(query, topK);
    if (serverResult) return serverResult;

    const memoryVectors = this.vectors;
    const sim = similarity;
    const searches = memoryVectors
      .map((vector, index) => ({
        similarity: sim(query, vector.embedding),
        index,
      }))
      .sort((a, b) => b.similarity - a.similarity);

    const ranked = searches.map((search) => [
      memoryVectors[search.index].content,
      search.similarity,
    ] as [string, number]);
    return topK ? ranked.slice(0, topK) : ranked;
  }

  private async tryServerSimilaritySearch(
    query: VectorArray,
    topK?: number,
  ): Promise<[string, number][] | null> {
    if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) {
      return null;
    }
    const indexId = this.getServerVectorIndexId();
    if (!indexId) return null;

    try {
      const storage = forageStorage.realStorage;
      if (this.serverIndexedContents) {
        const ranked = await storage.vectorIndexSearch(indexId, [Array.from(query)], "dot", topK);
        return (ranked[0] ?? []).flatMap(([id, score]) => {
          const content = this.serverIndexedContents?.[Number(id)];
          return content ? [[content, score] as [string, number]] : [];
        });
      }

      const descriptors = this.vectors.map((vector, index) => ({
        id: String(index),
        signature: vectorContentSignature(vector.content),
      }));
      const status = await storage.vectorIndexStatus(
        indexId,
        descriptors,
        vectorDescriptorRevision(descriptors),
      );
      if (status.missingIds.length > 0) {
        const missing = new Set(status.missingIds);
        await storage.vectorIndexUpsert(
          indexId,
          this.vectors.flatMap((vector, index) =>
            missing.has(String(index))
              ? [
                  {
                    id: String(index),
                    signature: vectorContentSignature(vector.content),
                    embedding: Array.from(vector.embedding),
                  },
                ]
              : [],
          ),
        );
      }
      const ranked = await storage.vectorIndexSearch(indexId, [Array.from(query)], "dot", topK);
      return (ranked[0] ?? []).flatMap(([id, score]) => {
        const vector = this.vectors[Number(id)];
        return vector ? [[vector.content, score] as [string, number]] : [];
      });
    } catch (error) {
      console.warn(
        "[HypaProcesser] Server vector search failed; using browser fallback",
        error,
      );
      if (this.serverIndexedContents && this.vectors.length === 0) {
        const fallbackTexts = this.serverIndexedContents;
        this.serverIndexedContents = null;
        await this.addText(fallbackTexts);
      }
      return null;
    }
  }

  similarityCheck(query1: number[], query2: number[]) {
    return similarity(query1, query2);
  }
}

export function similarity(a: VectorArray, b: VectorArray) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

export function cosineSimilarity(a: VectorArray, b: VectorArray): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function contextHash(texts: string[]): string {
  let h = 0x811c9dc5;
  const s = texts.join("\0");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export type VectorArray = number[] | Float32Array;

export type memoryVector = {
  embedding: number[] | Float32Array;
  content: string;
  alreadySaved?: boolean;
};

const chunkArray = <T>(arr: T[], chunkSize: number) =>
  arr.reduce((chunks, elem, index) => {
    const chunkIndex = Math.floor(index / chunkSize);
    const chunk = chunks[chunkIndex] || [];
    chunks[chunkIndex] = chunk.concat([elem]);
    return chunks;
  }, [] as T[][]);
