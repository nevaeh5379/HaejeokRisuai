use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::{Notify, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelJobCreateRequest {
    #[serde(rename = "targetUrl")]
    pub target_url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    #[serde(rename = "chatId")]
    pub chat_id: String,
    #[serde(rename = "generationId")]
    pub generation_id: Option<String>,
    pub protocol: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "speakerId")]
    pub speaker_id: Option<String>,
    #[serde(rename = "targetOrigin")]
    pub target_origin: Option<String>,
    pub streaming: Option<bool>,
    pub recoverable: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelJobRecord {
    pub id: String,
    #[serde(rename = "chatId")]
    pub chat_id: String,
    #[serde(rename = "generationId")]
    pub generation_id: Option<String>,
    pub protocol: Option<String>,
    pub model: Option<String>,
    #[serde(rename = "speakerId")]
    pub speaker_id: Option<String>,
    #[serde(rename = "targetUrl")]
    pub target_url: String,
    #[serde(rename = "targetOrigin")]
    pub target_origin: Option<String>,
    pub method: String,
    pub status: String,
    #[serde(rename = "upstreamStatus")]
    pub upstream_status: Option<u16>,
    #[serde(rename = "contentType")]
    pub content_type: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    #[serde(rename = "startedAt")]
    pub started_at: Option<u64>,
    #[serde(rename = "endedAt")]
    pub ended_at: Option<u64>,
    #[serde(rename = "journalPath")]
    pub journal_path: String,
    #[serde(rename = "bodyLength")]
    pub body_length: usize,
    #[serde(rename = "errorText")]
    pub error_text: Option<String>,
    pub recoverable: bool,
    pub claimed: bool,
    #[serde(rename = "claimedAt")]
    pub claimed_at: Option<u64>,
    #[serde(rename = "streamEnded")]
    pub stream_ended: bool,
    #[serde(rename = "sourceClientId")]
    pub source_client_id: Option<String>,
}

pub type JobEventCallback = Arc<dyn Fn(&str, ModelJobRecord, Option<String>) + Send + Sync>;

#[derive(Clone)]
pub struct ModelJobManager {
    jobs_dir: PathBuf,
    jobs: Arc<RwLock<HashMap<String, ModelJobRecord>>>,
    notifiers: Arc<RwLock<HashMap<String, Arc<Notify>>>>,
    abort_handles: Arc<RwLock<HashMap<String, tokio::task::JoinHandle<()>>>>,
    on_job_event: Option<JobEventCallback>,
}

impl ModelJobManager {
    pub async fn init(
        save_path: impl AsRef<Path>,
        on_job_event: Option<JobEventCallback>,
    ) -> std::io::Result<Self> {
        let save_path = save_path.as_ref().to_path_buf();
        let jobs_dir = save_path.join("model_jobs");
        tokio::fs::create_dir_all(&jobs_dir).await?;

        let manager = Self {
            jobs_dir,
            jobs: Arc::new(RwLock::new(HashMap::new())),
            notifiers: Arc::new(RwLock::new(HashMap::new())),
            abort_handles: Arc::new(RwLock::new(HashMap::new())),
            on_job_event,
        };

        manager.recover_jobs().await?;
        Ok(manager)
    }

    async fn recover_jobs(&self) -> std::io::Result<()> {
        let mut entries = match tokio::fs::read_dir(&self.jobs_dir).await {
            Ok(e) => e,
            Err(_) => return Ok(()),
        };

        let now = chrono::Utc::now().timestamp_millis() as u64;

        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    if let Ok(mut record) = serde_json::from_str::<ModelJobRecord>(&content) {
                        if record.status == "running" {
                            record.status = "error".to_string();
                            record.error_text =
                                Some("Job was interrupted by server restart".to_string());
                            record.ended_at = Some(now);
                            record.stream_ended = true;

                            let _ = tokio::fs::write(
                                &path,
                                serde_json::to_string_pretty(&record).unwrap_or_default(),
                            )
                            .await;
                        }
                        let mut jobs_guard = self.jobs.write().await;
                        jobs_guard.insert(record.id.clone(), record);
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn create_job(
        &self,
        req: ModelJobCreateRequest,
        client_id: Option<String>,
    ) -> Result<String, (u16, String, Option<String>)> {
        let chat_id = req.chat_id.clone();

        {
            let jobs_guard = self.jobs.read().await;
            for j in jobs_guard.values() {
                if j.chat_id == chat_id && j.status == "running" {
                    return Err((
                        409,
                        "Another model generation job is currently running for this chat"
                            .to_string(),
                        Some(j.id.clone()),
                    ));
                }
            }
        }

        let job_id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let journal_path = self.jobs_dir.join(format!("{}.journal", job_id));
        let meta_path = self.jobs_dir.join(format!("{}.json", job_id));

        let record = ModelJobRecord {
            id: job_id.clone(),
            chat_id,
            generation_id: req.generation_id.clone(),
            protocol: req.protocol.clone(),
            model: req.model.clone(),
            speaker_id: req.speaker_id.clone(),
            target_url: req.target_url.clone(),
            target_origin: req.target_origin.clone(),
            method: req.method.clone().unwrap_or_else(|| "POST".to_string()),
            status: "running".to_string(),
            upstream_status: None,
            content_type: None,
            created_at: now,
            started_at: Some(now),
            ended_at: None,
            journal_path: journal_path.to_string_lossy().to_string(),
            body_length: 0,
            error_text: None,
            recoverable: req.recoverable.unwrap_or(true),
            claimed: false,
            claimed_at: None,
            stream_ended: false,
            source_client_id: client_id.clone(),
        };

        {
            let mut jobs_guard = self.jobs.write().await;
            jobs_guard.insert(job_id.clone(), record.clone());
        }

        let notify = Arc::new(Notify::new());
        {
            let mut notifiers_guard = self.notifiers.write().await;
            notifiers_guard.insert(job_id.clone(), notify.clone());
        }

        let _ = tokio::fs::write(
            &meta_path,
            serde_json::to_string_pretty(&record).unwrap_or_default(),
        )
        .await;

        if let Some(on_event) = &self.on_job_event {
            on_event("create", record.clone(), client_id);
        }

        let manager = self.clone();
        let target_job_id = job_id.clone();
        let task_req = req;

        let handle = tokio::spawn(async move {
            manager
                .execute_upstream_request(target_job_id, task_req, notify)
                .await;
        });

        {
            let mut handles_guard = self.abort_handles.write().await;
            handles_guard.insert(job_id.clone(), handle);
        }

        Ok(job_id)
    }

    async fn execute_upstream_request(
        &self,
        job_id: String,
        req: ModelJobCreateRequest,
        notify: Arc<Notify>,
    ) {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(
                req.timeout_ms.unwrap_or(300_000),
            ))
            .build()
            .unwrap_or_default();

        let method = match req.method.as_deref().unwrap_or("POST") {
            "GET" => reqwest::Method::GET,
            "DELETE" => reqwest::Method::DELETE,
            "PUT" => reqwest::Method::PUT,
            _ => reqwest::Method::POST,
        };

        let mut req_builder = client.request(method, &req.target_url);

        if let Some(headers) = req.headers {
            for (k, v) in headers {
                let lower = k.to_lowercase();
                if !["host", "connection", "content-length"].contains(&lower.as_str()) {
                    req_builder = req_builder.header(k, v);
                }
            }
        }

        if let Some(body) = req.body {
            req_builder = req_builder.body(body);
        }

        let journal_path = self.jobs_dir.join(format!("{}.journal", job_id));
        let meta_path = self.jobs_dir.join(format!("{}.json", job_id));

        let send_res = req_builder.send().await;

        match send_res {
            Ok(resp) => {
                let status = resp.status().as_u16();
                let ct = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .map(|s| s.to_string());

                {
                    let mut jobs_guard = self.jobs.write().await;
                    if let Some(record) = jobs_guard.get_mut(&job_id) {
                        record.upstream_status = Some(status);
                        record.content_type = ct;
                    }
                }
                notify.notify_waiters();

                let mut file = match tokio::fs::OpenOptions::new()
                    .create(true)
                    .write(true)
                    .truncate(true)
                    .open(&journal_path)
                    .await
                {
                    Ok(f) => f,
                    Err(e) => {
                        self.mark_job_error(
                            &job_id,
                            &format!("Failed to open journal file: {}", e),
                            Some(status),
                        )
                        .await;
                        return;
                    }
                };

                let mut stream = resp.bytes_stream();
                use futures_util::StreamExt;

                let mut total_len = 0;
                while let Some(chunk_res) = stream.next().await {
                    match chunk_res {
                        Ok(chunk) => {
                            if let Err(e) = file.write_all(&chunk).await {
                                self.mark_job_error(
                                    &job_id,
                                    &format!("Failed to write chunk: {}", e),
                                    Some(status),
                                )
                                .await;
                                return;
                            }
                            let _ = file.flush().await;
                            total_len += chunk.len();

                            {
                                let mut jobs_guard = self.jobs.write().await;
                                if let Some(record) = jobs_guard.get_mut(&job_id) {
                                    record.body_length = total_len;
                                }
                            }
                            notify.notify_waiters();
                        }
                        Err(e) => {
                            self.mark_job_error(
                                &job_id,
                                &format!("Stream error from upstream: {}", e),
                                Some(status),
                            )
                            .await;
                            return;
                        }
                    }
                }

                self.mark_job_done(&job_id, status, total_len).await;
            }
            Err(e) => {
                self.mark_job_error(&job_id, &format!("Upstream request failed: {}", e), None)
                    .await;
            }
        }

        let _ = meta_path;
    }

    async fn mark_job_done(&self, job_id: &str, upstream_status: u16, total_len: usize) {
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let finished_record = {
            let mut jobs_guard = self.jobs.write().await;
            if let Some(record) = jobs_guard.get_mut(job_id) {
                record.status = if (200..300).contains(&upstream_status) {
                    "completed".to_string()
                } else {
                    "error".to_string()
                };
                record.upstream_status = Some(upstream_status);
                record.body_length = total_len;
                record.ended_at = Some(now);
                record.stream_ended = true;
                Some(record.clone())
            } else {
                None
            }
        };

        if let Some(rec) = finished_record {
            let meta_path = self.jobs_dir.join(format!("{}.json", job_id));
            let _ = tokio::fs::write(
                &meta_path,
                serde_json::to_string_pretty(&rec).unwrap_or_default(),
            )
            .await;

            if let Some(on_event) = &self.on_job_event {
                on_event("complete", rec, None);
            }
        }

        if let Some(notify) = self.notifiers.read().await.get(job_id) {
            notify.notify_waiters();
        }
    }

    async fn mark_job_error(&self, job_id: &str, err: &str, upstream_status: Option<u16>) {
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let finished_record = {
            let mut jobs_guard = self.jobs.write().await;
            if let Some(record) = jobs_guard.get_mut(job_id) {
                record.status = "error".to_string();
                record.error_text = Some(err.to_string());
                record.upstream_status = upstream_status;
                record.ended_at = Some(now);
                record.stream_ended = true;
                Some(record.clone())
            } else {
                None
            }
        };

        if let Some(rec) = finished_record {
            let meta_path = self.jobs_dir.join(format!("{}.json", job_id));
            let _ = tokio::fs::write(
                &meta_path,
                serde_json::to_string_pretty(&rec).unwrap_or_default(),
            )
            .await;

            if let Some(on_event) = &self.on_job_event {
                on_event("error", rec, None);
            }
        }

        if let Some(notify) = self.notifiers.read().await.get(job_id) {
            notify.notify_waiters();
        }
    }

    pub async fn get_job(&self, job_id: &str) -> Option<ModelJobRecord> {
        let jobs_guard = self.jobs.read().await;
        jobs_guard.get(job_id).cloned()
    }

    pub async fn claim_job(&self, job_id: &str) -> Result<(), (u16, String)> {
        let now = chrono::Utc::now().timestamp_millis() as u64;
        let updated_record = {
            let mut jobs_guard = self.jobs.write().await;
            if let Some(record) = jobs_guard.get_mut(job_id) {
                if record.claimed {
                    return Err((409, "Job is already claimed".to_string()));
                }
                record.claimed = true;
                record.claimed_at = Some(now);
                Some(record.clone())
            } else {
                return Err((404, "Job not found".to_string()));
            }
        };

        if let Some(rec) = updated_record {
            let meta_path = self.jobs_dir.join(format!("{}.json", job_id));
            let _ = tokio::fs::write(
                &meta_path,
                serde_json::to_string_pretty(&rec).unwrap_or_default(),
            )
            .await;
        }

        Ok(())
    }

    pub async fn delete_job(&self, job_id: &str) -> Result<bool, (u16, String)> {
        let mut was_running = false;

        {
            let mut handles_guard = self.abort_handles.write().await;
            if let Some(handle) = handles_guard.remove(job_id) {
                handle.abort();
                was_running = true;
            }
        }

        let now = chrono::Utc::now().timestamp_millis() as u64;
        let removed_record = {
            let mut jobs_guard = self.jobs.write().await;
            if let Some(record) = jobs_guard.get_mut(job_id) {
                record.status = "aborted".to_string();
                record.ended_at = Some(now);
                record.stream_ended = true;
                Some(record.clone())
            } else {
                return Err((404, "Job not found".to_string()));
            }
        };

        if let Some(rec) = removed_record {
            let meta_path = self.jobs_dir.join(format!("{}.json", job_id));
            let _ = tokio::fs::write(
                &meta_path,
                serde_json::to_string_pretty(&rec).unwrap_or_default(),
            )
            .await;

            if let Some(on_event) = &self.on_job_event {
                on_event("abort", rec, None);
            }
        }

        if let Some(notify) = self.notifiers.read().await.get(job_id) {
            notify.notify_waiters();
        }

        Ok(was_running)
    }

    pub async fn get_stream_handle(
        &self,
        job_id: &str,
    ) -> Option<(ModelJobRecord, Option<Arc<Notify>>, PathBuf)> {
        let record = self.get_job(job_id).await?;
        let notifiers_guard = self.notifiers.read().await;
        let notify = notifiers_guard.get(job_id).cloned();
        let path = self.jobs_dir.join(format!("{}.journal", job_id));
        Some((record, notify, path))
    }

    pub async fn list_jobs(&self, filter: &str) -> Option<Vec<ModelJobRecord>> {
        let jobs_guard = self.jobs.read().await;
        match filter {
            "active" => {
                let mut res: Vec<_> = jobs_guard
                    .values()
                    .filter(|j| j.status == "running")
                    .cloned()
                    .collect();
                res.sort_by_key(|a| std::cmp::Reverse(a.created_at));
                Some(res)
            }
            "all" => {
                let mut res: Vec<_> = jobs_guard.values().cloned().collect();
                res.sort_by_key(|a| a.created_at);
                Some(res)
            }
            _ => None,
        }
    }
}
