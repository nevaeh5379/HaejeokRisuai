use base64::prelude::*;
use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::crypto::{constant_time_eq_str, hash_json};

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("No auth header")]
    NoAuthHeader,
    #[error("Invalid token format")]
    InvalidTokenFormat,
    #[error("Token Expired")]
    TokenExpired,
    #[error("Unknown Public Key")]
    UnknownPublicKey,
    #[error("Unsupported Algorithm")]
    UnsupportedAlgorithm,
    #[error("Invalid Signature")]
    InvalidSignature,
    #[error("Invalid Public Key")]
    InvalidPublicKey,
    #[error("Internal Server Error")]
    InternalError(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtHeader {
    pub alg: String,
    pub typ: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwkPublicKey {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub y: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_ops: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JwtPayload {
    pub iat: Option<i64>,
    pub exp: i64,
    pub pub_key: serde_json::Value,
}

pub fn decode_base64url(s: &str) -> Result<Vec<u8>, base64::DecodeError> {
    BASE64_URL_SAFE_NO_PAD.decode(s.trim())
}

pub fn parse_verifying_key_from_jwk(
    jwk_val: &serde_json::Value,
) -> Result<VerifyingKey, AuthError> {
    let jwk: JwkPublicKey =
        serde_json::from_value(jwk_val.clone()).map_err(|_| AuthError::InvalidPublicKey)?;

    if jwk.kty != "EC" || jwk.crv != "P-256" {
        return Err(AuthError::InvalidPublicKey);
    }

    let x_bytes = decode_base64url(&jwk.x).map_err(|_| AuthError::InvalidPublicKey)?;
    let y_bytes = decode_base64url(&jwk.y).map_err(|_| AuthError::InvalidPublicKey)?;

    if x_bytes.len() != 32 || y_bytes.len() != 32 {
        return Err(AuthError::InvalidPublicKey);
    }

    let mut uncompressed = Vec::with_capacity(65);
    uncompressed.push(0x04); // uncompressed point indicator
    uncompressed.extend_from_slice(&x_bytes);
    uncompressed.extend_from_slice(&y_bytes);

    let pub_key =
        PublicKey::from_sec1_bytes(&uncompressed).map_err(|_| AuthError::InvalidPublicKey)?;
    Ok(VerifyingKey::from(pub_key))
}

pub fn verify_token_string(token: &str, known_hashes: &[String]) -> Result<String, AuthError> {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return Err(AuthError::InvalidTokenFormat);
    }

    let header_bytes = decode_base64url(parts[0]).map_err(|_| AuthError::InvalidTokenFormat)?;
    let payload_bytes = decode_base64url(parts[1]).map_err(|_| AuthError::InvalidTokenFormat)?;
    let signature_bytes = decode_base64url(parts[2]).map_err(|_| AuthError::InvalidSignature)?;

    let header: JwtHeader =
        serde_json::from_slice(&header_bytes).map_err(|_| AuthError::InvalidTokenFormat)?;
    if header.alg != "ES256" {
        return Err(AuthError::UnsupportedAlgorithm);
    }

    let raw_payload: serde_json::Value =
        serde_json::from_slice(&payload_bytes).map_err(|_| AuthError::InvalidTokenFormat)?;

    let exp = raw_payload
        .get("exp")
        .and_then(|v| v.as_i64())
        .ok_or(AuthError::InvalidTokenFormat)?;
    let now = chrono::Utc::now().timestamp();
    if exp < now {
        return Err(AuthError::TokenExpired);
    }

    let pub_val = raw_payload.get("pub").ok_or(AuthError::InvalidPublicKey)?;
    let pub_key_hash = hash_json(pub_val).map_err(|e| AuthError::InternalError(e.to_string()))?;

    if !known_hashes.contains(&pub_key_hash) {
        return Err(AuthError::UnknownPublicKey);
    }

    let verifying_key = parse_verifying_key_from_jwk(pub_val)?;

    let signature = if signature_bytes.len() == 64 {
        Signature::from_bytes((&signature_bytes[..]).into())
            .map_err(|_| AuthError::InvalidSignature)?
    } else {
        Signature::from_der(&signature_bytes).map_err(|_| AuthError::InvalidSignature)?
    };

    let signed_content = format!("{}.{}", parts[0], parts[1]);
    verifying_key
        .verify(signed_content.as_bytes(), &signature)
        .map_err(|_| AuthError::InvalidSignature)?;

    Ok(pub_key_hash)
}

#[derive(Clone)]
pub struct AuthState {
    save_dir: PathBuf,
    password: Arc<RwLock<String>>,
    known_hashes: Arc<RwLock<Vec<String>>>,
}

impl AuthState {
    pub async fn init(save_dir: impl AsRef<Path>) -> std::io::Result<Self> {
        let save_dir = save_dir.as_ref().to_path_buf();
        tokio::fs::create_dir_all(&save_dir).await?;

        let password_path = save_dir.join("__password");
        let password = if password_path.exists() {
            tokio::fs::read_to_string(&password_path)
                .await?
                .trim()
                .to_string()
        } else {
            String::new()
        };

        let hashes_path = save_dir.join("__known_public_key_hashes.json");
        let known_hashes = if hashes_path.exists() {
            let data = tokio::fs::read_to_string(&hashes_path).await?;
            serde_json::from_str::<Vec<String>>(&data).unwrap_or_default()
        } else {
            Vec::new()
        };

        Ok(Self {
            save_dir,
            password: Arc::new(RwLock::new(password)),
            known_hashes: Arc::new(RwLock::new(known_hashes)),
        })
    }

    pub async fn is_password_set(&self) -> bool {
        let p = self.password.read().await;
        !p.is_empty()
    }

    pub async fn get_password(&self) -> String {
        self.password.read().await.clone()
    }

    pub async fn set_password(&self, new_pw: &str) -> Result<(), &'static str> {
        let mut pw = self.password.write().await;
        if !pw.is_empty() {
            return Err("already set");
        }
        let trimmed = new_pw.trim().to_string();
        let path = self.save_dir.join("__password");
        tokio::fs::write(&path, &trimmed)
            .await
            .map_err(|_| "failed to write password")?;
        *pw = trimmed;
        Ok(())
    }

    pub async fn check_password(&self, candidate: &str) -> bool {
        let stored = self.password.read().await;
        if stored.is_empty() {
            return false;
        }
        constant_time_eq_str(stored.trim(), candidate.trim())
    }

    pub async fn add_known_key(
        &self,
        pub_key_val: &serde_json::Value,
    ) -> Result<String, AuthError> {
        let hash = hash_json(pub_key_val).map_err(|e| AuthError::InternalError(e.to_string()))?;
        let mut hashes = self.known_hashes.write().await;
        if !hashes.contains(&hash) {
            hashes.push(hash.clone());
            let path = self.save_dir.join("__known_public_key_hashes.json");
            let json = serde_json::to_string(&*hashes)
                .map_err(|e| AuthError::InternalError(e.to_string()))?;
            let _ = tokio::fs::write(&path, json).await;
        }
        Ok(hash)
    }

    pub async fn verify_token(&self, token: &str) -> Result<String, AuthError> {
        let hashes = self.known_hashes.read().await;
        verify_token_string(token, &hashes)
    }

    pub async fn verify_request_auth(
        &self,
        auth_header: Option<&str>,
    ) -> Result<String, AuthError> {
        let header = auth_header.ok_or(AuthError::NoAuthHeader)?;
        let token =
            crate::security::normalize_auth_header(Some(header)).ok_or(AuthError::NoAuthHeader)?;

        // Also allow raw password matching if applicable
        let stored_pw = self.password.read().await;
        if !stored_pw.is_empty() && constant_time_eq_str(stored_pw.trim(), token.trim()) {
            return Ok("password_direct".to_string());
        }

        self.verify_token(&token).await
    }
}
