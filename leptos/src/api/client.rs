use crate::models::auth::AuthCredential;
use gloo_net::http::{Request, RequestBuilder};
use serde::{de::DeserializeOwned, Serialize};
use std::fmt;

pub type Result<T> = std::result::Result<T, ApiError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    Network(String),
    Http { status: u16, message: String },
    Serialization(String),
    StorageUnavailable,
    Unauthorized,
    NotFound,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ApiError::Network(msg) => write!(f, "Network error: {}", msg),
            ApiError::Http { status, message } => write!(f, "HTTP {} error: {}", status, message),
            ApiError::Serialization(msg) => write!(f, "Serialization error: {}", msg),
            ApiError::StorageUnavailable => write!(f, "Database storage unavailable"),
            ApiError::Unauthorized => write!(f, "Authentication required or invalid token"),
            ApiError::NotFound => write!(f, "Resource not found"),
        }
    }
}

impl std::error::Error for ApiError {}

#[derive(Clone)]
pub struct ApiClient {
    base_url: String,
    credential: Option<AuthCredential>,
}

/// Custom Debug implementation to prevent any accidental leakage of credentials into logs or debugging output
impl fmt::Debug for ApiClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ApiClient")
            .field("base_url", &self.base_url)
            .field("has_credential", &self.credential.is_some())
            .finish()
    }
}

impl Default for ApiClient {
    fn default() -> Self {
        Self::new("")
    }
}

impl ApiClient {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            credential: None,
        }
    }

    pub fn with_credential(mut self, credential: Option<AuthCredential>) -> Self {
        self.credential = credential;
        self
    }

    pub fn set_credential(&mut self, credential: Option<AuthCredential>) {
        self.credential = credential;
    }

    pub fn credential(&self) -> Option<&AuthCredential> {
        self.credential.as_ref()
    }

    pub fn has_credential(&self) -> bool {
        self.credential.is_some()
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn build_url(&self, path: &str) -> String {
        let clean_path = if path.starts_with('/') {
            path
        } else {
            &format!("/{}", path)
        };
        format!("{}{}", self.base_url, clean_path)
    }

    fn attach_auth(&self, mut req: RequestBuilder) -> RequestBuilder {
        if let Some(cred) = &self.credential {
            req = req.header("risu-auth", cred.header_value());
        }
        req
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = self.build_url(path);
        let req = self.attach_auth(Request::get(&url));

        let resp = req
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        self.handle_response(resp).await
    }

    pub async fn post<B: Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T> {
        let url = self.build_url(path);
        let req = self.attach_auth(Request::post(&url));

        let resp = req
            .json(body)
            .map_err(|e| ApiError::Serialization(e.to_string()))?
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        self.handle_response(resp).await
    }

    pub async fn put<B: Serialize, T: DeserializeOwned>(&self, path: &str, body: &B) -> Result<T> {
        let url = self.build_url(path);
        let req = self.attach_auth(Request::put(&url));

        let resp = req
            .json(body)
            .map_err(|e| ApiError::Serialization(e.to_string()))?
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        self.handle_response(resp).await
    }

    pub async fn delete<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        let url = self.build_url(path);
        let req = self.attach_auth(Request::delete(&url));

        let resp = req
            .send()
            .await
            .map_err(|e| ApiError::Network(e.to_string()))?;

        self.handle_response(resp).await
    }

    async fn handle_response<T: DeserializeOwned>(
        &self,
        resp: gloo_net::http::Response,
    ) -> Result<T> {
        let status = resp.status();
        match status {
            200..=299 => resp
                .json::<T>()
                .await
                .map_err(|e| ApiError::Serialization(e.to_string())),
            401 => Err(ApiError::Unauthorized),
            404 => Err(ApiError::NotFound),
            503 => Err(ApiError::StorageUnavailable),
            _ => {
                let err_text = resp
                    .text()
                    .await
                    .unwrap_or_else(|_| "Unknown error".to_string());
                let parsed_msg = if let Ok(val) = serde_json::from_str::<serde_json::Value>(&err_text) {
                    val.get("error")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or(err_text)
                } else {
                    err_text
                };
                Err(ApiError::Http {
                    status,
                    message: parsed_msg,
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_api_client_debug_redaction() {
        let client = ApiClient::new("http://localhost:6001")
            .with_credential(Some(AuthCredential::password("super_secret_token_12345")));

        let debug_output = format!("{:?}", client);
        assert!(
            !debug_output.contains("super_secret_token_12345"),
            "ApiClient debug output leaked credentials!"
        );
        assert!(debug_output.contains("has_credential: true"));
        assert!(debug_output.contains("base_url: \"http://localhost:6001\""));
    }

    #[test]
    fn test_api_client_url_building() {
        let client = ApiClient::new("http://localhost:6001/");
        assert_eq!(client.base_url(), "http://localhost:6001");
        assert_eq!(client.build_url("/api/health"), "http://localhost:6001/api/health");
        assert_eq!(client.build_url("api/health"), "http://localhost:6001/api/health");
    }
}
