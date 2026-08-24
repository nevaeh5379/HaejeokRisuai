import localforage from "localforage";
import { normalizeHypaModel, type HypaModel } from "./hypamemory";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { TaskRateLimiter, TaskCanceledError } from "./taskRateLimiter";
import { forageStorage, globalFetch } from "src/ts/globalApi.svelte";
import { getDatabase } from "src/ts/storage/database.svelte";
import { appendLastPath } from "src/ts/util";
import { isNodeServer } from "src/ts/platform";
import { NodeStorage } from "src/ts/storage/nodeStorage";

export interface HypaProcessorV2Options {
  model?: HypaModel;
  customEmbeddingUrl?: string;
  oaiKey?: string;
  rateLimiter?: TaskRateLimiter;
  serverIndexId?: string;
}

export interface EmbeddingText<TMetadata> {
  id: string;
  content: string;
  metadata?: TMetadata;
}

export interface EmbeddingResult<TMetadata> extends EmbeddingText<TMetadata> {
  embedding: EmbeddingVector;
}

export type EmbeddingVector = number[] | Float32Array;

function vectorContentSignature(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

export class HypaProcessorV2<TMetadata> {
  private static readonly LOG_PREFIX = "[HypaProcessorV2]";
  public readonly options: HypaProcessorV2Options;
  public progressCallback: (queuedCount: number) => void = null;
  public vectors: Map<string, EmbeddingResult<TMetadata>> = new Map();
  private forage: LocalForage = localforage.createInstance({
    name: "hypaVector",
  });

  public constructor(options?: HypaProcessorV2Options) {
    const db = getDatabase();

    const model = normalizeHypaModel(options?.model ?? db.hypaModel);
    this.options = {
      customEmbeddingUrl: db.hypaCustomSettings?.url?.trim() || "",
      oaiKey: db.supaMemoryKey?.trim() || "",
      rateLimiter: new TaskRateLimiter(),
      ...options,
      model,
    };
  }

  public async addTexts(ebdTexts: EmbeddingText<TMetadata>[]): Promise<void> {
    await this.getEmbeds(ebdTexts, true);
  }

  public async similaritySearchScored(
    query: string,
  ): Promise<[EmbeddingResult<TMetadata>, number][]> {
    const results = await this.similaritySearchScoredBatch([query]);
    return results[0];
  }

  public async similaritySearchScoredBatch(
    queries: string[],
  ): Promise<[EmbeddingResult<TMetadata>, number][][]> {
    if (queries.length === 0) {
      return [];
    }

    // Remove duplicate queries
    const uniqueQueries = [...new Set(queries)];

    // Convert queries to EmbeddingText array
    const ebdTexts: EmbeddingText<TMetadata>[] = uniqueQueries.map(
      (query, index) => ({
        id: `query-${index}`,
        content: query,
      }),
    );

    // Get query embeddings (don't save to memory)
    const ebdResults = await this.getEmbeds(ebdTexts, false);

    const serverScoredResults = await this.tryServerSimilaritySearch(ebdResults);
    if (serverScoredResults) {
      const serverResultMap = new Map<string, [EmbeddingResult<TMetadata>, number][]>();
      for (let i = 0; i < uniqueQueries.length; i++) {
        serverResultMap.set(uniqueQueries[i], serverScoredResults[i]);
      }
      return queries.map((query) => serverResultMap.get(query));
    }

    const scoredResultsMap = new Map<
      string,
      [EmbeddingResult<TMetadata>, number][]
    >();

    // Calculate similarity for each unique query
    for (let i = 0; i < uniqueQueries.length; i++) {
      const ebdResult = ebdResults[i];

      const scoredVectors = Array.from(this.vectors.values())
        .map((vector): [EmbeddingResult<TMetadata>, number] => [
          vector,
          this.similarity(ebdResult.embedding, vector.embedding),
        ])
        .sort((a, b) => b[1] - a[1]);

      scoredResultsMap.set(uniqueQueries[i], scoredVectors);
    }

    return queries.map((query) => scoredResultsMap.get(query));
  }

  private async getEmbeds(
    ebdTexts: EmbeddingText<TMetadata>[],
    saveToMemory: boolean = true,
  ): Promise<EmbeddingResult<TMetadata>[]> {
    if (ebdTexts.length === 0) {
      return [];
    }

    const resultMap: Map<string, EmbeddingResult<TMetadata>> = new Map();
    const toEmbed: EmbeddingText<TMetadata>[] = [];

    const ctxProvider = isContextModel(this.options.model)
      ? getContextProvider(this.options.model)
      : null;
    const ctxGroups = new Map<string, string[]>();
    if (ctxProvider && saveToMemory) {
      const groups = new Map<TMetadata, EmbeddingText<TMetadata>[]>();
      for (const item of ebdTexts) {
        const g = groups.get(item.metadata) || [];
        g.push(item);
        groups.set(item.metadata, g);
      }
      for (const [, g] of groups) {
        const texts = g.map((item) => item.content);
        for (const item of g) {
          ctxGroups.set(item.id, texts);
        }
      }
    }

    // Load cache
    const loadPromises = ebdTexts.map(async (item, index) => {
      const { id, content, metadata } = item;

      // Use if already in memory
      if (this.vectors.has(id)) {
        resultMap.set(id, this.vectors.get(id));
        return;
      }

      try {
        const cached = await this.forage.getItem<EmbeddingResult<TMetadata>>(
          this.getCacheKey(content, ctxGroups.get(id)),
        );

        if (cached) {
          // Debug log for cache hit
          console.debug(
            HypaProcessorV2.LOG_PREFIX,
            `Cache hit for getting embedding ${index} with model ${this.options.model}`,
          );

          // Add metadata
          cached.metadata = metadata;

          // Save to memory
          if (saveToMemory) {
            this.vectors.set(id, cached);
          }

          resultMap.set(id, cached);
        } else {
          toEmbed.push(item);
        }
      } catch (error) {
        toEmbed.push(item);
      }
    });

    await Promise.all(loadPromises);

    if (ctxProvider && toEmbed.length > 0 && saveToMemory) {
      const missMetadatas = new Set(
        toEmbed.map((item) => item.metadata).filter(Boolean),
      );

      const additionalItems = ebdTexts.filter(
        (item) =>
          item.metadata &&
          missMetadatas.has(item.metadata) &&
          !toEmbed.some((e) => e.id === item.id),
      );

      for (const item of additionalItems) {
        resultMap.delete(item.id);
        if (this.vectors.has(item.id)) {
          this.vectors.delete(item.id);
        }
      }

      toEmbed.push(...additionalItems);
    }

    if (toEmbed.length === 0) {
      return ebdTexts.map((item) => resultMap.get(item.id));
    }

    // Chunking array
    const chunkSize = await this.getOptimalChunkSize();

    // Debug log for optimal chunk size
    console.debug(
      HypaProcessorV2.LOG_PREFIX,
      `Optimal chunk size for ${this.options.model}: ${chunkSize}`,
    );

    const chunks = this.chunkArray(toEmbed, chunkSize);

    if (ctxProvider && saveToMemory) {
      const metadataGroups = new Map<TMetadata, EmbeddingText<TMetadata>[]>();
      for (const item of toEmbed) {
        const key = item.metadata;
        const group = metadataGroups.get(key) || [];
        group.push(item);
        metadataGroups.set(key, group);
      }

      const groupEntries = Array.from(metadataGroups.entries());
      const groups = groupEntries.map(([, group]) =>
        group.map((item) => item.content),
      );

      const results = await ctxProvider.embedDocumentGroups(groups);

      for (let i = 0; i < groupEntries.length; i++) {
        const [, group] = groupEntries[i];
        const embeddings = results[i];

        for (let j = 0; j < group.length; j++) {
          const { id, content, metadata } = group[j];
          const embedding = embeddings[j];

          const ebdResult: EmbeddingResult<TMetadata> = {
            id,
            content,
            embedding,
            metadata,
          };

          await this.forage.setItem(
            this.getCacheKey(content, ctxGroups.get(id)),
            {
              content,
              embedding,
            },
          );

          if (saveToMemory) {
            this.vectors.set(id, ebdResult);
          }

          resultMap.set(id, ebdResult);
        }
      }
    } else {
      // API model: Parallel processing
      const embeddingTasks = chunks.map((chunk) => {
        const contents = chunk.map((item) => item.content);

        return () => this.getAPIEmbeds(contents);
      });

      // Progress callback
      this.options.rateLimiter.taskQueueChangeCallback = this.progressCallback;

      const batchResult =
        await this.options.rateLimiter.executeBatch<EmbeddingVector[]>(
          embeddingTasks,
        );
      const errors: Error[] = [];

      const chunksSavePromises = batchResult.results.map(async (result, i) => {
        if (!result.success) {
          errors.push(result.error);
          return;
        }

        if (!result.data) {
          errors.push(new Error("No embeddings found in the response."));
          return;
        }

        const chunk = chunks[i];
        const savePromises = result.data.map(async (embedding, j) => {
          const { id, content, metadata } = chunk[j];

          const ebdResult: EmbeddingResult<TMetadata> = {
            id,
            content,
            embedding,
            metadata,
          };

          // Save to DB
          await this.forage.setItem(this.getCacheKey(content), {
            content,
            embedding,
          });

          // Save to memory
          if (saveToMemory) {
            this.vectors.set(id, ebdResult);
          }

          resultMap.set(id, ebdResult);
        });

        await Promise.all(savePromises);
      });

      await Promise.all(chunksSavePromises);

      // Throw major error if there are errors
      if (errors.length > 0) {
        const majorError =
          errors.find((error) => !(error instanceof TaskCanceledError)) ||
          errors[0];

        throw majorError;
      }
    }

    return ebdTexts.map((item) => resultMap.get(item.id));
  }

  private async tryServerSimilaritySearch(
    queryResults: EmbeddingResult<TMetadata>[],
  ): Promise<[EmbeddingResult<TMetadata>, number][][] | null> {
    if (!this.options.serverIndexId || isContextModel(this.options.model)) return null;
    if (!isNodeServer || !(forageStorage.realStorage instanceof NodeStorage)) return null;

    const db = getDatabase();
    const indexId = [
      this.options.serverIndexId,
      this.options.model,
      this.options.model === "custom" ? this.options.customEmbeddingUrl : "",
      this.options.model === "custom" ? db.hypaCustomSettings?.model?.trim() || "" : "",
    ].join("|");
    const vectors = Array.from(this.vectors.values());
    const descriptors = vectors.map((vector) => ({
      id: vector.id,
      signature: vectorContentSignature(vector.content),
    }));

    try {
      const storage = forageStorage.realStorage;
      const status = await storage.vectorIndexStatus(indexId, descriptors);
      if (status.missingIds.length > 0) {
        const missing = new Set(status.missingIds);
        await storage.vectorIndexUpsert(
          indexId,
          vectors
            .filter((vector) => missing.has(vector.id))
            .map((vector) => ({
              id: vector.id,
              signature: vectorContentSignature(vector.content),
              embedding: Array.from(vector.embedding),
            })),
        );
      }

      const ranked = await storage.vectorIndexSearch(
        indexId,
        queryResults.map((result) => Array.from(result.embedding)),
      );
      return ranked.map((rows) =>
        rows
          .map(([id, score]): [EmbeddingResult<TMetadata>, number] | null => {
            const vector = this.vectors.get(id);
            return vector ? [vector, score] : null;
          })
          .filter((row): row is [EmbeddingResult<TMetadata>, number] => row !== null),
      );
    } catch (error) {
      console.warn(`${HypaProcessorV2.LOG_PREFIX} Server vector search failed; using browser fallback`, error);
      return null;
    }
  }

  private similarity(a: EmbeddingVector, b: EmbeddingVector): number {
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

  private getCacheKey(content: string, contextTexts?: string[]): string {
    const db = getDatabase();
    const suffix =
      this.options.model === "custom" && db.hypaCustomSettings?.model?.trim()
        ? `-${db.hypaCustomSettings.model.trim()}`
        : "";

    const ctxProvider = isContextModel(this.options.model)
      ? getContextProvider(this.options.model)
      : null;
    const ctxSuffix = ctxProvider
      ? ctxProvider.getCacheKeySuffix(contextTexts)
      : "";

    return `${content}|${this.options.model}${suffix}${ctxSuffix}`;
  }

  private getOptimalChunkSize(): number {
    return 50;
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }

    return chunks;
  }

  private async getAPIEmbeds(contents: string[]): Promise<EmbeddingVector[]> {
    const db = getDatabase();
    let response = null;

    if (this.options.model === "custom") {
      if (!this.options.customEmbeddingUrl) {
        throw new Error("Custom model requires a Custom Server URL");
      }

      const replaceUrl = this.options.customEmbeddingUrl.endsWith("/embeddings")
        ? this.options.customEmbeddingUrl
        : appendLastPath(this.options.customEmbeddingUrl, "embeddings");

      const fetchArgs = {
        headers: {
          ...(db.hypaCustomSettings?.key?.trim()
            ? { Authorization: "Bearer " + db.hypaCustomSettings.key.trim() }
            : {}),
        },
        body: {
          input: contents,
          ...(db.hypaCustomSettings?.model?.trim()
            ? { model: db.hypaCustomSettings.model.trim() }
            : {}),
        },
      };

      response = await globalFetch(replaceUrl, fetchArgs);
    } else if (
      ["ada", "openai3small", "openai3large"].includes(this.options.model)
    ) {
      const models = {
        ada: "text-embedding-ada-002",
        openai3small: "text-embedding-3-small",
        openai3large: "text-embedding-3-large",
      };

      const fetchArgs = {
        headers: {
          Authorization:
            "Bearer " +
            (this.options.oaiKey?.trim() || db.supaMemoryKey?.trim()),
        },
        body: {
          input: contents,
          model: models[this.options.model],
        },
      };

      response = await globalFetch(
        "https://api.openai.com/v1/embeddings",
        fetchArgs,
      );
    } else if (isContextModel(this.options.model)) {
      const provider = getContextProvider(this.options.model);
      return await provider.embedQueries(contents);
    } else {
      throw new Error(`Unsupported model: ${this.options.model}`);
    }

    if (!response.ok || !response.data.data) {
      throw new Error(JSON.stringify(response.data));
    }

    const embeddings: EmbeddingVector[] = response.data.data.map(
      (item: { embedding: EmbeddingVector }) => {
        if (!item.embedding) {
          throw new Error("No embeddings found in the response.");
        }

        return item.embedding;
      },
    );

    return embeddings;
  }
}
