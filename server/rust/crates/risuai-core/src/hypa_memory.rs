use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HypaSession {
    pub id: String,
    pub scope: String,
    pub created_at: i64,
    pub last_accessed: i64,
    pub state: serde_json::Value,
}

#[derive(Clone)]
pub struct HypaMemoryExecutor {
    sessions: Arc<RwLock<HashMap<String, HypaSession>>>,
}

impl HypaMemoryExecutor {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn start(&self, payload: serde_json::Value, scope: &str) -> serde_json::Value {
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        let session = HypaSession {
            id: session_id.clone(),
            scope: scope.to_string(),
            created_at: now,
            last_accessed: now,
            state: payload,
        };
        let mut map = self.sessions.write().await;
        map.insert(session_id.clone(), session);
        serde_json::json!({
            "sessionId": session_id,
            "status": "ready"
        })
    }

    pub async fn resume(
        &self,
        session_id: &str,
        action_id: Option<&str>,
        _value: Option<&serde_json::Value>,
        scope: &str,
    ) -> Result<serde_json::Value, (u16, &'static str, &'static str)> {
        let mut map = self.sessions.write().await;
        let session =
            map.get_mut(session_id)
                .ok_or((404, "Session not found", "hypa_session_missing"))?;
        if session.scope != scope {
            return Err((404, "Session not found", "hypa_session_missing"));
        }
        session.last_accessed = chrono::Utc::now().timestamp_millis();
        Ok(serde_json::json!({
            "sessionId": session_id,
            "actionId": action_id,
            "status": "completed"
        }))
    }

    pub async fn cancel(&self, session_id: &str, scope: &str) {
        let mut map = self.sessions.write().await;
        if let Some(session) = map.get(session_id) {
            if session.scope == scope {
                map.remove(session_id);
            }
        }
    }

    pub async fn get_query_cache_stats(&self, _scope: &str) -> serde_json::Value {
        serde_json::json!({
            "entries": 0,
            "bytes": 0,
            "hits": 0,
            "misses": 0,
            "coalesced": 0,
            "limits": {
                "entries": 1024,
                "bytes": 16 * 1024 * 1024
            }
        })
    }

    pub async fn clear_query_cache(&self, _scope: &str) -> serde_json::Value {
        serde_json::json!({
            "entries": 0,
            "bytes": 0
        })
    }
}

impl Default for HypaMemoryExecutor {
    fn default() -> Self {
        Self::new()
    }
}
