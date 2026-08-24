import localforage from "localforage";
import { forageStorage, globalFetch } from "src/ts/globalApi.svelte";
import { appendLastPath } from "src/ts/util";
import { getDatabase } from "src/ts/storage/database.svelte";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { isNodeServer } from "src/ts/platform";
import { NodeStorage } from "src/ts/storage/nodeStorage";

export type HypaModel =
  | "custom"
  | "ada"
  | "openai3small"
  | "openai3large"
  | "voyageContext3";

export const DEFAULT_HYPA_MODEL: HypaModel = "openai3small";

function vectorContentSignature(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

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

  constructor(model: HypaModel | "auto" = "auto", customEmbeddingUrl?: string, serverIndexId?: string) {
    this.forage = localforage.createInstance({
      name: "hypaVector",
    });
    this.vectors = [];
    const db = getDatabase();
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

      const db = getDatabase();
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
      const db = getDatabase();
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

  async addText(texts: string[]) {
    const db = getDatabase();
    const suffix =
      this.model === "custom" && db.hypaCustomSettings?.model?.trim()
        ? `-${db.hypaCustomSettings.model.trim()}`
        : "";

    for (let i = 0; i < texts.length; i++) {
      const itm: memoryVector = await this.forage.getItem(
        texts[i] + "|" + this.model + suffix,
      );
      if (itm) {
        itm.alreadySaved = true;
        this.vectors.push(itm);
      }
    }

    texts = texts.filter((v) => {
      for (let i = 0; i < this.vectors.length; i++) {
        if (this.vectors[i].content === v) {
          return false;
        }
      }
      return true;
    });

    if (texts.length === 0) {
      return;
    }
    const vectors = await this.embedDocuments(texts);

    const memoryVectors: memoryVector[] = vectors.map((embedding, idx) => ({
      content: texts[idx],
      embedding,
    }));

    for (let i = 0; i < memoryVectors.length; i++) {
      const vec = memoryVectors[i];
      if (!vec.alreadySaved) {
        await this.forage.setItem(texts[i] + "|" + this.model + suffix, vec);
      }
    }

    this.vectors = memoryVectors.concat(this.vectors);
  }

  async similaritySearch(query: string) {
    const results = await this.similaritySearchVectorWithScore(
      (await this.getEmbeds(query))[0],
    );
    return results.map((result) => result[0]);
  }

  async similaritySearchScored(query: string) {
    return await this.similaritySearchVectorWithScore(
      (await this.getEmbeds(query))[0],
    );
  }

  private async similaritySearchVectorWithScore(
    query: VectorArray,
  ): Promise<[string, number][]> {
    const serverResult = await this.tryServerSimilaritySearch(query);
    if (serverResult) return serverResult;

    const memoryVectors = this.vectors;
    const sim = similarity;
    const searches = memoryVectors
      .map((vector, index) => ({
        similarity: sim(query, vector.embedding),
        index,
      }))
      .sort((a, b) => (a.similarity > b.similarity ? -1 : 0));

    return searches.map((search) => [
      memoryVectors[search.index].content,
      search.similarity,
    ]);
  }

  private async tryServerSimilaritySearch(query: VectorArray): Promise<[string, number][] | null> {
    if (!this.serverIndexId || isContextModel(this.model)) return null;
    if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) return null;
    const db = getDatabase();
    const indexId = [
      this.serverIndexId,
      this.model,
      this.model === "custom" ? this.customEmbeddingUrl : "",
      this.model === "custom" ? db.hypaCustomSettings?.model?.trim() || "" : "",
    ].join("|");
    const descriptors = this.vectors.map((vector, index) => ({
      id: String(index),
      signature: vectorContentSignature(vector.content),
    }));

    try {
      const storage = forageStorage.realStorage;
      const status = await storage.vectorIndexStatus(indexId, descriptors);
      if (status.missingIds.length > 0) {
        const missing = new Set(status.missingIds);
        await storage.vectorIndexUpsert(
          indexId,
          this.vectors.flatMap((vector, index) =>
            missing.has(String(index))
              ? [{ id: String(index), signature: vectorContentSignature(vector.content), embedding: Array.from(vector.embedding) }]
              : [],
          ),
        );
      }
      const ranked = await storage.vectorIndexSearch(indexId, [Array.from(query)]);
      return (ranked[0] ?? []).flatMap(([id, score]) => {
        const vector = this.vectors[Number(id)];
        return vector ? [[vector.content, score] as [string, number]] : [];
      });
    } catch (error) {
      console.warn("[HypaProcesser] Server vector search failed; using browser fallback", error);
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
