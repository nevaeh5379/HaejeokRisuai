use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderExecutionRequest {
    pub format: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderTransportRequest {
    pub format: String,
    pub payload: serde_json::Value,
}

#[derive(Clone)]
pub struct ProviderExecutor {
    client: Client,
}

impl ProviderExecutor {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(600))
                .build()
                .unwrap_or_default(),
        }
    }

    pub fn get_formats(
        &self,
    ) -> (
        &'static [&'static str],
        &'static [&'static str],
        &'static [&'static str],
    ) {
        let formats = &["echo", "mistral", "horde"];
        let routes = &["echo", "mistral", "horde"];
        let transport_formats = &[
            "openai-compatible",
            "openai-response",
            "openai-legacy-instruct",
            "anthropic",
            "google-cloud",
            "cohere",
            "novelai",
            "novellist",
            "nanogpt",
            "ollama",
        ];
        (formats, routes, transport_formats)
    }

    pub async fn execute(
        &self,
        req: ProviderExecutionRequest,
    ) -> Result<serde_json::Value, (u16, String)> {
        match req.format.as_str() {
            "echo" => {
                let msg = req
                    .payload
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let delay = req
                    .payload
                    .get("delayMs")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if delay > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
                Ok(serde_json::json!({
                    "handled": true,
                    "response": {
                        "type": "success",
                        "result": msg
                    }
                }))
            }
            "mistral" => {
                let api_key = req
                    .payload
                    .get("apiKey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let body = req
                    .payload
                    .get("body")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));
                let prefix = req
                    .payload
                    .get("httpErrorPrefix")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                let resp = self
                    .client
                    .post("https://api.mistral.ai/v1/chat/completions")
                    .header("authorization", format!("Bearer {}", api_key))
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| (502, e.to_string()))?;

                let status = resp.status().as_u16();
                let json: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));

                if (200..300).contains(&status) {
                    let content = json
                        .get("choices")
                        .and_then(|c| c.as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|c| c.get("message"))
                        .and_then(|m| m.get("content"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("");
                    Ok(serde_json::json!({
                        "handled": true,
                        "response": {
                            "type": "success",
                            "result": content
                        }
                    }))
                } else {
                    let err_msg = json.to_string();
                    Ok(serde_json::json!({
                        "handled": true,
                        "response": {
                            "type": "fail",
                            "result": format!("{}{}", prefix, err_msg)
                        }
                    }))
                }
            }
            _ => Ok(serde_json::json!({ "handled": false })),
        }
    }

    pub async fn execute_transport(
        &self,
        req: ProviderTransportRequest,
    ) -> Result<serde_json::Value, (u16, String)> {
        let (url, body, headers) = match req.format.as_str() {
            "openai-compatible" => (
                "https://api.openai.com/v1/chat/completions".to_string(),
                req.payload.get("body").cloned().unwrap_or_default(),
                req.payload.get("headers").cloned().unwrap_or_default(),
            ),
            "anthropic" => (
                "https://api.anthropic.com/v1/messages".to_string(),
                req.payload.get("body").cloned().unwrap_or_default(),
                req.payload.get("headers").cloned().unwrap_or_default(),
            ),
            _ => {
                return Ok(serde_json::json!({ "handled": false }));
            }
        };

        let mut req_builder = self.client.post(&url).json(&body);
        if let Some(obj) = headers.as_object() {
            for (k, v) in obj {
                if let Some(s) = v.as_str() {
                    let lower = k.to_lowercase();
                    if !["host", "connection", "risu-auth", "content-length"]
                        .contains(&lower.as_str())
                    {
                        req_builder = req_builder.header(k, s);
                    }
                }
            }
        }

        let resp = req_builder.send().await.map_err(|e| (502, e.to_string()))?;
        let ok = resp.status().is_success();
        let status = resp.status().as_u16();
        let data: serde_json::Value = resp.json().await.unwrap_or(serde_json::json!({}));

        Ok(serde_json::json!({
            "handled": true,
            "response": {
                "ok": ok,
                "status": status,
                "data": data
            }
        }))
    }
}

impl Default for ProviderExecutor {
    fn default() -> Self {
        Self::new()
    }
}
