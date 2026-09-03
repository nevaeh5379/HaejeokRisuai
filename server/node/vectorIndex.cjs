const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  VECTOR_SEARCH_METRICS,
} = require("../../packages/protocol/compute.cjs");

const MAX_INDEXES = 32;
const MAX_VECTORS_PER_INDEX = 100000;
const MAX_DIMENSIONS = 8192;
const FLOAT_BYTES = 4;

function readMemoryLimitMb(name, fallbackMb) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMb;
  return Math.min(Math.max(parsed, 8), 4096);
}

function readDiskLimitMb(name, fallbackMb) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMb;
  return Math.min(Math.max(parsed, 64), 65536);
}

const MAX_INDEX_MEMORY_MB = readMemoryLimitMb("RISU_VECTOR_INDEX_MAX_MB", 128);
const MAX_TOTAL_MEMORY_MB = Math.max(
  MAX_INDEX_MEMORY_MB,
  readMemoryLimitMb("RISU_VECTOR_INDEX_TOTAL_MAX_MB", 256),
);
const MAX_FLOATS_PER_INDEX = Math.floor(
  (MAX_INDEX_MEMORY_MB * 1024 * 1024) / FLOAT_BYTES,
);
const MAX_TOTAL_FLOATS = Math.floor(
  (MAX_TOTAL_MEMORY_MB * 1024 * 1024) / FLOAT_BYTES,
);
const MAX_PERSIST_DISK_BYTES =
  readDiskLimitMb("RISU_VECTOR_INDEX_DISK_MAX_MB", 2048) * 1024 * 1024;
const indexes = new Map();
const PERSIST_MAGIC = Buffer.from("RISUVEC1");
const PERSIST_HEADER_BYTES = PERSIST_MAGIC.length + 4;
const PERSIST_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 100;
const persistTimers = new Map();
const persistPromises = new Map();
let prunePromise = Promise.resolve();
let persistenceDir = null;

function validateIndexId(indexId) {
  if (
    typeof indexId !== "string" ||
    indexId.length === 0 ||
    indexId.length > 2048
  ) {
    throw new TypeError("Invalid vector index id");
  }
}

function validateRevision(revision) {
  if (
    typeof revision !== "string" ||
    revision.length === 0 ||
    revision.length > 256
  ) {
    throw new TypeError("Invalid vector index revision");
  }
}

function persistenceFilePath(indexId, directory = persistenceDir) {
  if (!directory) return null;
  const digest = crypto.createHash("sha256").update(indexId).digest("hex");
  return path.join(directory, `${digest}.rvec`);
}

function configureVectorIndexPersistence(directory) {
  persistenceDir = directory ? path.resolve(directory) : null;
  if (persistenceDir) {
    fs.mkdirSync(persistenceDir, { recursive: true, mode: 0o755 });
    try {
      fs.chmodSync(persistenceDir, 0o755);
    } catch {}
  }
}

async function prunePersistenceDirectory(directory) {
  const dirents = await fsp.readdir(directory, { withFileTypes: true });
  const files = [];
  let totalBytes = 0;
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith(".rvec")) continue;
    const filePath = path.join(directory, dirent.name);
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat) continue;
    totalBytes += stat.size;
    files.push({ filePath, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  if (totalBytes <= MAX_PERSIST_DISK_BYTES) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (totalBytes <= MAX_PERSIST_DISK_BYTES) break;
    await fsp.unlink(file.filePath).catch(() => {});
    totalBytes -= file.size;
  }
}

function schedulePersistencePrune(directory) {
  prunePromise = prunePromise
    .catch(() => {})
    .then(() => prunePersistenceDirectory(directory))
    .catch((error) =>
      console.warn("[VectorIndex] Failed to prune persistent cache:", error),
    );
}

function snapshotIndex(indexId, index) {
  return {
    indexId,
    revision: index.revision,
    dimension: index.dimension,
    entries: Array.from(index.vectors.entries(), ([id, value]) => ({
      id,
      signature: value.signature,
      embedding: value.embedding,
    })),
  };
}

async function writeIndexSnapshot(snapshot, directory) {
  const filePath = persistenceFilePath(snapshot.indexId, directory);
  if (!filePath) return;
  const metadata = Buffer.from(
    JSON.stringify({
      version: PERSIST_VERSION,
      indexId: snapshot.indexId,
      revision: snapshot.revision,
      dimension: snapshot.dimension,
      entries: snapshot.entries.map(({ id, signature }) => ({ id, signature })),
    }),
    "utf8",
  );
  if (metadata.length > 64 * 1024 * 1024)
    throw new RangeError("Vector index cache metadata is too large");
  const header = Buffer.allocUnsafe(PERSIST_HEADER_BYTES);
  PERSIST_MAGIC.copy(header, 0);
  header.writeUInt32LE(metadata.length, PERSIST_MAGIC.length);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsp.open(tempPath, "w", 0o644);
    await handle.write(header);
    await handle.write(metadata);
    for (const entry of snapshot.entries) {
      const embedding = entry.embedding;
      if (os.endianness() === "LE") {
        await handle.write(
          Buffer.from(
            embedding.buffer,
            embedding.byteOffset,
            embedding.byteLength,
          ),
        );
      } else {
        const encoded = Buffer.allocUnsafe(embedding.byteLength);
        for (let i = 0; i < embedding.length; i++)
          encoded.writeFloatLE(embedding[i], i * FLOAT_BYTES);
        await handle.write(encoded);
      }
    }
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.rename(tempPath, filePath);
    schedulePersistencePrune(directory);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    throw error;
  }
}

function enqueuePersist(indexId, index, directory = persistenceDir) {
  if (!directory || !index) return;
  const previous = persistPromises.get(indexId) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => writeIndexSnapshot(snapshotIndex(indexId, index), directory))
    .catch((error) =>
      console.warn("[VectorIndex] Failed to persist %s:", indexId, error),
    );
  persistPromises.set(indexId, next);
  void next.finally(() => {
    if (persistPromises.get(indexId) === next) persistPromises.delete(indexId);
  });
}

function schedulePersist(indexId, index) {
  if (!persistenceDir || !index) return;
  const existing = persistTimers.get(indexId);
  if (existing) clearTimeout(existing.timer);
  const directory = persistenceDir;
  const timer = setTimeout(() => {
    persistTimers.delete(indexId);
    enqueuePersist(indexId, index, directory);
  }, PERSIST_DEBOUNCE_MS);
  timer.unref?.();
  persistTimers.set(indexId, { timer, index, directory });
}

async function flushVectorIndexPersistence() {
  for (const [indexId, pending] of persistTimers) {
    clearTimeout(pending.timer);
    enqueuePersist(indexId, pending.index, pending.directory);
  }
  persistTimers.clear();
  await Promise.all(Array.from(persistPromises.values()));
  await prunePromise;
}

async function readPersistedMetadata(filePath) {
  let handle;
  try {
    handle = await fsp.open(filePath, "r");
    const header = Buffer.alloc(PERSIST_HEADER_BYTES);
    const headerRead = await handle.read(header, 0, header.length, 0);
    if (
      headerRead.bytesRead !== header.length ||
      !header.subarray(0, PERSIST_MAGIC.length).equals(PERSIST_MAGIC)
    )
      return null;
    const metadataLength = header.readUInt32LE(PERSIST_MAGIC.length);
    if (metadataLength <= 0 || metadataLength > 64 * 1024 * 1024) return null;
    const metadataBuffer = Buffer.alloc(metadataLength);
    const metadataRead = await handle.read(
      metadataBuffer,
      0,
      metadataLength,
      PERSIST_HEADER_BYTES,
    );
    if (metadataRead.bytesRead !== metadataLength) return null;
    const metadata = JSON.parse(metadataBuffer.toString("utf8"));
    if (
      metadata?.version !== PERSIST_VERSION ||
      typeof metadata?.indexId !== "string" ||
      !Array.isArray(metadata?.entries)
    )
      return null;
    const stat = await handle.stat();
    return { metadata, size: stat.size };
  } catch {
    return null;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

function loadPersistedIndex(indexId) {
  const filePath = persistenceFilePath(indexId);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const encoded = fs.readFileSync(filePath);
    if (
      encoded.length < PERSIST_HEADER_BYTES ||
      !encoded.subarray(0, PERSIST_MAGIC.length).equals(PERSIST_MAGIC)
    ) {
      throw new Error("Invalid vector index cache header");
    }
    const metadataLength = encoded.readUInt32LE(PERSIST_MAGIC.length);
    if (
      metadataLength <= 0 ||
      metadataLength > 64 * 1024 * 1024 ||
      PERSIST_HEADER_BYTES + metadataLength > encoded.length
    ) {
      throw new Error("Invalid vector index cache metadata length");
    }
    const metadata = JSON.parse(
      encoded
        .subarray(PERSIST_HEADER_BYTES, PERSIST_HEADER_BYTES + metadataLength)
        .toString("utf8"),
    );
    if (
      metadata?.version !== PERSIST_VERSION ||
      metadata?.indexId !== indexId ||
      !Array.isArray(metadata?.entries)
    ) {
      throw new Error(
        "Vector index cache metadata does not match the requested index",
      );
    }
    if (metadata.entries.length > MAX_VECTORS_PER_INDEX)
      throw new RangeError("Persisted vector index contains too many vectors");
    const dimension =
      metadata.dimension === null ? null : Number(metadata.dimension);
    if (
      metadata.entries.length > 0 &&
      (!Number.isSafeInteger(dimension) ||
        dimension <= 0 ||
        dimension > MAX_DIMENSIONS)
    ) {
      throw new RangeError("Persisted vector index has invalid dimensions");
    }
    if (metadata.revision !== null && metadata.revision !== undefined)
      validateRevision(metadata.revision);
    const floatCount = metadata.entries.length * (dimension || 0);
    if (floatCount > MAX_FLOATS_PER_INDEX)
      throw new RangeError("Persisted vector index exceeds the memory limit");
    const payloadOffset = PERSIST_HEADER_BYTES + metadataLength;
    const payloadBytes = floatCount * FLOAT_BYTES;
    if (encoded.length !== payloadOffset + payloadBytes)
      throw new Error(
        "Persisted vector index payload length does not match metadata",
      );
    const storage = new ArrayBuffer(payloadBytes);
    new Uint8Array(storage).set(encoded.subarray(payloadOffset));
    const vectors = new Map();
    for (let i = 0; i < metadata.entries.length; i++) {
      const descriptor = metadata.entries[i];
      const id = String(descriptor?.id ?? "");
      const signature = String(descriptor?.signature ?? "");
      if (!id) throw new Error("Persisted vector id is missing");
      let embedding;
      if (os.endianness() === "LE") {
        embedding = new Float32Array(
          storage,
          i * dimension * FLOAT_BYTES,
          dimension,
        );
      } else {
        embedding = new Float32Array(dimension);
        const view = new DataView(
          storage,
          i * dimension * FLOAT_BYTES,
          dimension * FLOAT_BYTES,
        );
        for (let j = 0; j < dimension; j++)
          embedding[j] = view.getFloat32(j * FLOAT_BYTES, true);
      }
      for (const value of embedding)
        if (!Number.isFinite(value))
          throw new Error("Persisted embedding contains a non-finite value");
      vectors.set(id, { signature, embedding });
    }
    return {
      vectors,
      floatCount,
      dimension: metadata.entries.length > 0 ? dimension : null,
      lastAccess: Date.now(),
      revision: metadata.revision ?? null,
      pendingRevision: null,
      pendingSignatures: null,
    };
  } catch (error) {
    console.warn(
      "[VectorIndex] Ignoring invalid persisted cache for %s:",
      indexId,
      error.message || error,
    );
    try {
      fs.unlinkSync(filePath);
    } catch {}
    return null;
  }
}

function evictMemoryIndexes(excludeId = null) {
  const oldestCandidates = () =>
    Array.from(indexes.entries())
      .filter(([key]) => key !== excludeId)
      .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  while (indexes.size > MAX_INDEXES) {
    const candidate = oldestCandidates()[0];
    if (!candidate) break;
    indexes.delete(candidate[0]);
  }
  let totalFloats = Array.from(indexes.values()).reduce(
    (sum, value) => sum + value.floatCount,
    0,
  );
  const candidates = oldestCandidates();
  while (totalFloats > MAX_TOTAL_FLOATS && candidates.length > 0) {
    const [key, value] = candidates.shift();
    totalFloats -= value.floatCount;
    indexes.delete(key);
  }
}

function touchPersistentAccess(indexId, index) {
  if (!persistenceDir) return;
  const now = Date.now();
  if (now - (index.persistenceTouchedAt || 0) < 5 * 60 * 1000) return;
  const filePath = persistenceFilePath(indexId);
  try {
    const time = new Date(now);
    fs.utimesSync(filePath, time, time);
  } catch {}
  index.persistenceTouchedAt = now;
}

function touchIndex(indexId, create = false) {
  validateIndexId(indexId);
  let index = indexes.get(indexId);
  if (!index) {
    index = loadPersistedIndex(indexId);
    if (index) indexes.set(indexId, index);
  }
  if (!index && create) {
    index = {
      vectors: new Map(),
      floatCount: 0,
      dimension: null,
      lastAccess: Date.now(),
      revision: null,
      pendingRevision: null,
      pendingSignatures: null,
    };
    indexes.set(indexId, index);
  }
  if (index) {
    index.lastAccess = Date.now();
    touchPersistentAccess(indexId, index);
    evictMemoryIndexes(indexId);
  }
  return index;
}

function checkVectorIndexRevision(indexId, revision) {
  validateRevision(revision);
  const index = touchIndex(indexId, false);
  return {
    ready: Boolean(index && index.revision === revision),
    missingIds: [],
    size: index?.vectors.size ?? 0,
  };
}

function syncVectorIndex(indexId, descriptors, revision = null) {
  if (!Array.isArray(descriptors))
    throw new TypeError("descriptors must be an array");
  if (descriptors.length > MAX_VECTORS_PER_INDEX)
    throw new RangeError("Too many vectors");
  if (revision !== null) validateRevision(revision);
  const index = touchIndex(indexId, true);
  const activeIds = new Set();
  const missingIds = [];
  const pendingSignatures = new Map();

  if (revision === null || index.revision !== revision) index.revision = null;

  for (const descriptor of descriptors) {
    const id = String(descriptor?.id ?? "");
    const signature = String(descriptor?.signature ?? "");
    if (!id) throw new TypeError("Vector id is required");
    activeIds.add(id);
    const existing = index.vectors.get(id);
    if (!existing || existing.signature !== signature) {
      missingIds.push(id);
      pendingSignatures.set(id, signature);
    }
  }

  for (const id of index.vectors.keys()) {
    if (!activeIds.has(id)) {
      index.floatCount -= index.vectors.get(id).embedding.length;
      index.vectors.delete(id);
    }
  }
  if (index.vectors.size === 0) index.dimension = null;

  if (revision !== null) {
    if (missingIds.length === 0) {
      index.revision = revision;
      index.pendingRevision = null;
      index.pendingSignatures = null;
    } else {
      index.pendingRevision = revision;
      index.pendingSignatures = pendingSignatures;
    }
  } else {
    index.pendingRevision = null;
    index.pendingSignatures = null;
  }

  schedulePersist(indexId, index);
  return {
    ready: revision !== null && missingIds.length === 0,
    missingIds,
    size: index.vectors.size,
  };
}
function upsertVectorIndex(indexId, entries) {
  if (!Array.isArray(entries)) throw new TypeError("entries must be an array");
  const index = touchIndex(indexId, true);
  if (index.vectors.size + entries.length > MAX_VECTORS_PER_INDEX) {
    throw new RangeError("Too many vectors");
  }

  for (const entry of entries) {
    const id = String(entry?.id ?? "");
    const signature = String(entry?.signature ?? "");
    const rawEmbedding = entry?.embedding;
    if (!id || !Array.isArray(rawEmbedding))
      throw new TypeError("Invalid vector entry");
    if (rawEmbedding.length === 0 || rawEmbedding.length > MAX_DIMENSIONS) {
      throw new RangeError("Invalid embedding dimensions");
    }
    const embedding = Float32Array.from(rawEmbedding, (value) => Number(value));
    for (const value of embedding) {
      if (!Number.isFinite(value))
        throw new TypeError("Embedding contains a non-finite value");
    }
    if (index.dimension !== null && index.dimension !== embedding.length) {
      throw new RangeError(
        "Embedding dimensions do not match the vector index",
      );
    }
    index.dimension = embedding.length;
    const existing = index.vectors.get(id);
    const nextFloatCount =
      index.floatCount - (existing?.embedding.length || 0) + embedding.length;
    if (nextFloatCount > MAX_FLOATS_PER_INDEX)
      throw new RangeError("Vector index memory limit exceeded");
    index.floatCount = nextFloatCount;
    index.vectors.set(id, { signature, embedding });
    if (index.pendingSignatures?.get(id) === signature) {
      index.pendingSignatures.delete(id);
    }
  }

  if (index.pendingRevision && index.pendingSignatures?.size === 0) {
    index.revision = index.pendingRevision;
    index.pendingRevision = null;
    index.pendingSignatures = null;
  }

  evictMemoryIndexes(indexId);
  schedulePersist(indexId, index);
  return { size: index.vectors.size };
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length || a.length === 0) return -Infinity;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? -Infinity : dot / denominator;
}

function dotProduct(a, b) {
  if (a.length !== b.length || a.length === 0) return -Infinity;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function rankVectors(vectors, query, metric, topK) {
  const score = (embedding) =>
    metric === "dot"
      ? dotProduct(query, embedding)
      : cosineSimilarity(query, embedding);

  if (topK === null || topK >= vectors.length || topK > 64) {
    const ranked = vectors
      .map(([id, value]) => [id, score(value.embedding)])
      .sort((a, b) => b[1] - a[1]);
    return topK === null ? ranked : ranked.slice(0, topK);
  }

  // Retrieval callers usually need only 1-3 hits. Keep a tiny sorted window
  // instead of allocating and sorting a result for every vector in the index.
  const best = [];
  for (const [id, value] of vectors) {
    const candidate = [id, score(value.embedding)];
    let insertAt = best.length;
    while (insertAt > 0 && candidate[1] > best[insertAt - 1][1]) insertAt--;
    if (insertAt >= topK) continue;
    best.splice(insertAt, 0, candidate);
    if (best.length > topK) best.pop();
  }
  return best;
}

function searchVectorIndex(indexId, queries, metric = "cosine", topK = null) {
  if (!Array.isArray(queries)) throw new TypeError("queries must be an array");
  if (!VECTOR_SEARCH_METRICS.includes(metric))
    throw new TypeError("Invalid vector search metric");
  if (
    topK !== null &&
    (!Number.isSafeInteger(topK) || topK <= 0 || topK > MAX_VECTORS_PER_INDEX)
  ) {
    throw new RangeError("Invalid vector search topK");
  }
  const index = touchIndex(indexId, false);
  if (!index) return null;

  const vectors = Array.from(index.vectors.entries());
  return queries.map((rawQuery) => {
    if (
      !Array.isArray(rawQuery) ||
      rawQuery.length === 0 ||
      rawQuery.length > MAX_DIMENSIONS
    ) {
      throw new RangeError("Invalid query embedding dimensions");
    }
    const query = Float32Array.from(rawQuery, (value) => Number(value));
    if (index.dimension !== null && query.length !== index.dimension) {
      throw new RangeError("Query dimensions do not match the vector index");
    }
    return rankVectors(vectors, query, metric, topK);
  });
}

async function getVectorIndexCacheStats(scopePrefix = "") {
  if (typeof scopePrefix !== "string")
    throw new TypeError("scopePrefix must be a string");
  let memoryIndexes = 0;
  let memoryVectors = 0;
  let memoryFloats = 0;
  for (const [indexId, index] of indexes) {
    if (scopePrefix && !indexId.startsWith(scopePrefix)) continue;
    memoryIndexes += 1;
    memoryVectors += index.vectors.size;
    memoryFloats += index.floatCount;
  }

  let diskIndexes = 0;
  let diskVectors = 0;
  let diskBytes = 0;
  if (persistenceDir) {
    const dirents = await fsp
      .readdir(persistenceDir, { withFileTypes: true })
      .catch(() => []);
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".rvec")) continue;
      const inspected = await readPersistedMetadata(
        path.join(persistenceDir, dirent.name),
      );
      if (
        !inspected ||
        (scopePrefix && !inspected.metadata.indexId.startsWith(scopePrefix))
      )
        continue;
      diskIndexes += 1;
      diskVectors += inspected.metadata.entries.length;
      diskBytes += inspected.size;
    }
  }

  const pendingWrites = Array.from(
    new Set([
      ...Array.from(persistTimers.keys()),
      ...Array.from(persistPromises.keys()),
    ]),
  ).filter((indexId) => !scopePrefix || indexId.startsWith(scopePrefix)).length;

  return {
    memory: {
      indexes: memoryIndexes,
      vectors: memoryVectors,
      bytes: memoryFloats * FLOAT_BYTES,
    },
    disk: {
      enabled: Boolean(persistenceDir),
      indexes: diskIndexes,
      vectors: diskVectors,
      bytes: diskBytes,
      pendingWrites,
    },
    limits: {
      memoryBytes: MAX_TOTAL_FLOATS * FLOAT_BYTES,
      perIndexMemoryBytes: MAX_FLOATS_PER_INDEX * FLOAT_BYTES,
      diskBytes: MAX_PERSIST_DISK_BYTES,
      memoryIndexes: MAX_INDEXES,
      vectorsPerIndex: MAX_VECTORS_PER_INDEX,
    },
  };
}

async function clearVectorIndexCache(scopePrefix = "") {
  if (typeof scopePrefix !== "string")
    throw new TypeError("scopePrefix must be a string");
  for (const [indexId, pending] of Array.from(persistTimers.entries())) {
    if (scopePrefix && !indexId.startsWith(scopePrefix)) continue;
    clearTimeout(pending.timer);
    persistTimers.delete(indexId);
  }
  const inFlight = Array.from(persistPromises.entries())
    .filter(([indexId]) => !scopePrefix || indexId.startsWith(scopePrefix))
    .map(([, promise]) => promise);
  await Promise.all(inFlight);

  let memoryIndexes = 0;
  let memoryVectors = 0;
  for (const [indexId, index] of Array.from(indexes.entries())) {
    if (scopePrefix && !indexId.startsWith(scopePrefix)) continue;
    memoryIndexes += 1;
    memoryVectors += index.vectors.size;
    indexes.delete(indexId);
  }

  let diskIndexes = 0;
  let diskBytes = 0;
  if (persistenceDir) {
    const dirents = await fsp
      .readdir(persistenceDir, { withFileTypes: true })
      .catch(() => []);
    for (const dirent of dirents) {
      if (!dirent.isFile() || !dirent.name.endsWith(".rvec")) continue;
      const filePath = path.join(persistenceDir, dirent.name);
      const inspected = await readPersistedMetadata(filePath);
      if (
        !inspected ||
        (scopePrefix && !inspected.metadata.indexId.startsWith(scopePrefix))
      )
        continue;
      await fsp.unlink(filePath).catch(() => {});
      diskIndexes += 1;
      diskBytes += inspected.size;
    }
  }

  return { memoryIndexes, memoryVectors, diskIndexes, diskBytes };
}

function clearVectorIndexes() {
  for (const pending of persistTimers.values()) clearTimeout(pending.timer);
  persistTimers.clear();
  indexes.clear();
}
module.exports = {
  configureVectorIndexPersistence,
  flushVectorIndexPersistence,
  getVectorIndexCacheStats,
  clearVectorIndexCache,
  checkVectorIndexRevision,
  syncVectorIndex,
  upsertVectorIndex,
  searchVectorIndex,
  clearVectorIndexes,
};
