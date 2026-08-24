const MAX_INDEXES = 32;
const MAX_VECTORS_PER_INDEX = 100000;
const MAX_DIMENSIONS = 8192;
const MAX_FLOATS_PER_INDEX = 8_000_000;
const MAX_TOTAL_FLOATS = 32_000_000;
const indexes = new Map();

function validateIndexId(indexId) {
    if (typeof indexId !== 'string' || indexId.length === 0 || indexId.length > 2048) {
        throw new TypeError('Invalid vector index id');
    }
}

function touchIndex(indexId, create = false) {
    validateIndexId(indexId);
    let index = indexes.get(indexId);
    if (!index && create) {
        index = { vectors: new Map(), floatCount: 0, dimension: null, lastAccess: Date.now() };
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

function syncVectorIndex(indexId, descriptors) {
    if (!Array.isArray(descriptors)) throw new TypeError('descriptors must be an array');
    if (descriptors.length > MAX_VECTORS_PER_INDEX) throw new RangeError('Too many vectors');
    const index = touchIndex(indexId, true);
    const activeIds = new Set();
    const missingIds = [];

    for (const descriptor of descriptors) {
        const id = String(descriptor?.id ?? '');
        const signature = String(descriptor?.signature ?? '');
        if (!id) throw new TypeError('Vector id is required');
        activeIds.add(id);
        const existing = index.vectors.get(id);
        if (!existing || existing.signature !== signature) missingIds.push(id);
    }

    for (const id of index.vectors.keys()) {
        if (!activeIds.has(id)) {
            index.floatCount -= index.vectors.get(id).embedding.length;
            index.vectors.delete(id);
        }
    }
    if (index.vectors.size === 0) index.dimension = null;
    return { missingIds, size: index.vectors.size };
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

function searchVectorIndex(indexId, queries) {
    if (!Array.isArray(queries)) throw new TypeError('queries must be an array');
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
        return vectors
            .map(([id, value]) => [id, cosineSimilarity(query, value.embedding)])
            .sort((a, b) => b[1] - a[1]);
    });
}

function clearVectorIndexes() {
    indexes.clear();
}
module.exports = {
    syncVectorIndex,
    upsertVectorIndex,
    searchVectorIndex,
    clearVectorIndexes,
};
