use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorItem {
    pub id: String,
    pub signature: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorSyncItem {
    pub id: String,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub score: f32,
}

#[derive(Debug, Clone)]
pub struct VectorEntry {
    pub signature: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct VectorIndex {
    pub index_id: String,
    pub revision: String,
    pub dimension: usize,
    pub vectors: HashMap<String, VectorEntry>,
    pub last_accessed: i64,
}

#[derive(Clone)]
pub struct VectorIndexManager {
    _persistence_dir: Option<PathBuf>,
    indexes: Arc<RwLock<HashMap<String, VectorIndex>>>,
}

impl VectorIndexManager {
    pub fn new(persistence_dir: Option<PathBuf>) -> Self {
        if let Some(dir) = &persistence_dir {
            let _ = std::fs::create_dir_all(dir);
        }
        Self {
            _persistence_dir: persistence_dir,
            indexes: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn check_revision(
        &self,
        index_id: &str,
        revision: &str,
    ) -> (bool, Option<String>, usize) {
        let map = self.indexes.read().await;
        if let Some(idx) = map.get(index_id) {
            let up_to_date = idx.revision == revision;
            (up_to_date, Some(idx.revision.clone()), idx.vectors.len())
        } else {
            (false, None, 0)
        }
    }

    pub async fn sync(
        &self,
        index_id: &str,
        revision: &str,
        dimension: usize,
        items: &[VectorSyncItem],
    ) -> (Vec<String>, usize) {
        let mut map = self.indexes.write().await;
        let now = chrono::Utc::now().timestamp();

        let index = map
            .entry(index_id.to_string())
            .or_insert_with(|| VectorIndex {
                index_id: index_id.to_string(),
                revision: revision.to_string(),
                dimension,
                vectors: HashMap::new(),
                last_accessed: now,
            });

        if index.revision != revision {
            index.revision = revision.to_string();
            index.vectors.clear();
        }
        index.dimension = dimension;
        index.last_accessed = now;

        let mut missing_signatures = Vec::new();
        let mut present_count = 0;

        for item in items {
            if let Some(entry) = index.vectors.get(&item.id) {
                if entry.signature == item.signature {
                    present_count += 1;
                    continue;
                }
            }
            missing_signatures.push(item.signature.clone());
        }

        (missing_signatures, present_count)
    }

    pub async fn upsert(
        &self,
        index_id: &str,
        revision: &str,
        dimension: usize,
        items: Vec<VectorItem>,
    ) -> (usize, usize) {
        let mut map = self.indexes.write().await;
        let now = chrono::Utc::now().timestamp();

        let index = map
            .entry(index_id.to_string())
            .or_insert_with(|| VectorIndex {
                index_id: index_id.to_string(),
                revision: revision.to_string(),
                dimension,
                vectors: HashMap::new(),
                last_accessed: now,
            });

        index.revision = revision.to_string();
        index.dimension = dimension;
        index.last_accessed = now;

        let count = items.len();
        for item in items {
            if item.embedding.len() == dimension {
                index.vectors.insert(
                    item.id,
                    VectorEntry {
                        signature: item.signature,
                        embedding: item.embedding,
                    },
                );
            }
        }

        let total = index.vectors.len();
        (count, total)
    }

    pub async fn search(
        &self,
        index_id: &str,
        query: &[f32],
        limit: usize,
        metric: Option<&str>,
        threshold: Option<f32>,
    ) -> Vec<VectorSearchResult> {
        let map = self.indexes.read().await;
        let index = match map.get(index_id) {
            Some(idx) => idx,
            None => return Vec::new(),
        };

        if index.dimension != query.len() || query.is_empty() {
            return Vec::new();
        }

        let query_norm: f32 = query.iter().map(|x| x * x).sum::<f32>().sqrt();
        let is_cosine = metric.unwrap_or("cosine") != "dot";
        let min_threshold = threshold.unwrap_or(-1.0);

        let mut scored: Vec<VectorSearchResult> = Vec::with_capacity(index.vectors.len());

        for (id, entry) in &index.vectors {
            if entry.embedding.len() != query.len() {
                continue;
            }
            let dot: f32 = query
                .iter()
                .zip(entry.embedding.iter())
                .map(|(a, b)| a * b)
                .sum();

            let score = if is_cosine {
                let emb_norm: f32 = entry.embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
                if query_norm > 0.0 && emb_norm > 0.0 {
                    dot / (query_norm * emb_norm)
                } else {
                    0.0
                }
            } else {
                dot
            };

            if score >= min_threshold {
                scored.push(VectorSearchResult {
                    id: id.clone(),
                    score,
                });
            }
        }

        scored.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        if scored.len() > limit {
            scored.truncate(limit);
        }
        scored
    }

    pub async fn get_stats(&self) -> serde_json::Value {
        let map = self.indexes.read().await;
        let mut total_vectors = 0;
        let index_count = map.len();
        for idx in map.values() {
            total_vectors += idx.vectors.len();
        }
        serde_json::json!({
            "indexCount": index_count,
            "totalVectors": total_vectors,
        })
    }

    pub async fn clear(&self) {
        let mut map = self.indexes.write().await;
        map.clear();
    }
}

impl VectorIndexManager {
    pub async fn count(&self) -> usize {
        let guard = self.indexes.read().await;
        guard.values().map(|idx| idx.vectors.len()).sum()
    }
}
