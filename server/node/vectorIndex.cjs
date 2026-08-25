const { VECTOR_SEARCH_METRICS } = require('../../packages/protocol/compute.cjs');

const MAX_INDEXES = 32;
const MAX_VECTORS_PER_INDEX = 100000;
const MAX_DIMENSIONS = 8192;
const FLOAT_BYTES = 4;

function readMemoryLimitMb(name, fallbackMb) {
    const parsed = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallbackMb;
    return Math.min(Math.max(parsed, 8), 4096);
}

const MAX_INDEX_MEMORY_MB = readMemoryLimitMb('RISU_VECTOR_INDEX_MAX_MB', 128);
const MAX_TOTAL_MEMORY_MB = Math.max(
    MAX_INDEX_MEMORY_MB,
    readMemoryLimitMb('RISU_VECTOR_INDEX_TOTAL_MAX_MB', 256),
);
const MAX_FLOATS_PER_INDEX = Math.floor(
    (MAX_INDEX_MEMORY_MB * 1024 * 1024) / FLOAT_BYTES,
);
const MAX_TOTAL_FLOATS = Math.floor(
    (MAX_TOTAL_MEMORY_MB * 1024 * 1024) / FLOAT_BYTES,
);
const indexes = new Map();

function validateIndexId(indexId) {
    if (typeof indexId !== 'string' || indexId.length === 0 || indexId.length > 2048) {
        throw new TypeError('Invalid vector index id');
    }
}

function validateRevision(revision) {
    if (typeof revision !== 'string' || revision.length === 0 || revision.length > 256) {
        throw new TypeError('Invalid vector index revision');
    }
}

function touchIndex(indexId, create = false) {
    validateIndexId(indexId);
    let index = indexes.get(indexId);
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
    if (index) index.lastAccess = Date.now();
    while (indexes.size > MAX_INDEXES) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, value] of indexes) {
            if (value.lastAccess < oldestTime) {
                oldestKey = key;
                oldestTime = value.lastAccess;
            }
        }
        if (oldestKey === null) break;
        indexes.delete(oldestKey);
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
    if (!Array.isArray(descriptors)) throw new TypeError('descriptors must be an array');
    if (descriptors.length > MAX_VECTORS_PER_INDEX) throw new RangeError('Too many vectors');
    if (revision !== null) validateRevision(revision);
    const index = touchIndex(indexId, true);
    const activeIds = new Set();
    const missingIds = [];
    const pendingSignatures = new Map();

    if (revision === null || index.revision !== revision) index.revision = null;

    for (const descriptor of descriptors) {
        const id = String(descriptor?.id ?? '');
        const signature = String(descriptor?.signature ?? '');
        if (!id) throw new TypeError('Vector id is required');
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

    return {
        ready: revision !== null && missingIds.length === 0,
        missingIds,
        size: index.vectors.size,
    };
}
function upsertVectorIndex(indexId, entries) {
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
    const index = touchIndex(indexId, true);
    if (index.vectors.size + entries.length > MAX_VECTORS_PER_INDEX) {
        throw new RangeError('Too many vectors');
    }

    for (const entry of entries) {
        const id = String(entry?.id ?? '');
        const signature = String(entry?.signature ?? '');
        const rawEmbedding = entry?.embedding;
        if (!id || !Array.isArray(rawEmbedding)) throw new TypeError('Invalid vector entry');
        if (rawEmbedding.length === 0 || rawEmbedding.length > MAX_DIMENSIONS) {
            throw new RangeError('Invalid embedding dimensions');
        }
        const embedding = Float32Array.from(rawEmbedding, (value) => Number(value));
        for (const value of embedding) {
            if (!Number.isFinite(value)) throw new TypeError('Embedding contains a non-finite value');
        }
        if (index.dimension !== null && index.dimension !== embedding.length) {
            throw new RangeError('Embedding dimensions do not match the vector index');
        }
        index.dimension = embedding.length;
        const existing = index.vectors.get(id);
        const nextFloatCount = index.floatCount - (existing?.embedding.length || 0) + embedding.length;
        if (nextFloatCount > MAX_FLOATS_PER_INDEX) throw new RangeError('Vector index memory limit exceeded');
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

    let totalFloats = Array.from(indexes.values()).reduce((sum, value) => sum + value.floatCount, 0);
    const evictionCandidates = Array.from(indexes.entries())
        .filter(([key]) => key !== indexId)
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    while (totalFloats > MAX_TOTAL_FLOATS && evictionCandidates.length > 0) {
        const [key, value] = evictionCandidates.shift();
        totalFloats -= value.floatCount;
        indexes.delete(key);
    }
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
    const score = (embedding) => metric === 'dot'
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

function searchVectorIndex(indexId, queries, metric = 'cosine', topK = null) {
    if (!Array.isArray(queries)) throw new TypeError('queries must be an array');
    if (!VECTOR_SEARCH_METRICS.includes(metric)) throw new TypeError('Invalid vector search metric');
    if (topK !== null && (!Number.isSafeInteger(topK) || topK <= 0 || topK > MAX_VECTORS_PER_INDEX)) {
        throw new RangeError('Invalid vector search topK');
    }
    const index = touchIndex(indexId, false);
    if (!index) return null;

    const vectors = Array.from(index.vectors.entries());
    return queries.map((rawQuery) => {
        if (!Array.isArray(rawQuery) || rawQuery.length === 0 || rawQuery.length > MAX_DIMENSIONS) {
            throw new RangeError('Invalid query embedding dimensions');
        }
        const query = Float32Array.from(rawQuery, (value) => Number(value));
        if (index.dimension !== null && query.length !== index.dimension) {
            throw new RangeError('Query dimensions do not match the vector index');
        }
        return rankVectors(vectors, query, metric, topK);
    });
}

function clearVectorIndexes() {
    indexes.clear();
}
module.exports = {
    checkVectorIndexRevision,
    syncVectorIndex,
    upsertVectorIndex,
    searchVectorIndex,
    clearVectorIndexes,
};
