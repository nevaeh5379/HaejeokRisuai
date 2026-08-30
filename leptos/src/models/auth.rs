use serde::{Deserialize, Serialize};

/// Represents the typed authentication status returned by `/api/test_auth`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuthStatus {
    /// Password is not yet initialized on the server
    Unset,
    /// Successfully authenticated with provided credentials
    Success,
    /// Password is configured but credentials were not supplied or incorrect
    Incorrect,
    /// Unknown or unexpected status
    #[serde(other)]
    Unknown,
}

impl AuthStatus {
    pub fn is_unset(&self) -> bool {
        matches!(self, AuthStatus::Unset)
    }

    pub fn is_success(&self) -> bool {
        matches!(self, AuthStatus::Success)
    }

    pub fn is_incorrect(&self) -> bool {
        matches!(self, AuthStatus::Incorrect)
    }
}

/// In-memory session credential abstraction
/// Designed to be replaced by signed JWTs or ES256/JWK credential provider in future milestones.
#[derive(Clone, PartialEq, Eq)]
pub enum AuthCredential {
    Password(String),
}

impl AuthCredential {
    pub fn password(p: impl Into<String>) -> Self {
        Self::Password(p.into())
    }

    pub fn header_value(&self) -> &str {
        match self {
            AuthCredential::Password(p) => p.as_str(),
        }
    }
}

/// Custom Debug implementation that strictly redacts sensitive credentials
impl std::fmt::Debug for AuthCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthCredential::Password(_) => write!(f, "AuthCredential::Password([REDACTED])"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthStatusResponse {
    pub status: AuthStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginPayload {
    pub password: Option<String>,
    #[serde(rename = "publicKey", skip_serializing_if = "Option::is_none")]
    pub public_key: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoginResponse {
    pub status: String,
    #[serde(rename = "keyHash", skip_serializing_if = "Option::is_none")]
    pub key_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetPasswordPayload {
    pub password: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimpleSuccessResponse {
    pub success: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_status_serde() {
        let unset: AuthStatusResponse =
            serde_json::from_str(r#"{"status":"unset"}"#).expect("should parse unset");
        assert_eq!(unset.status, AuthStatus::Unset);
        assert!(unset.status.is_unset());

        let success: AuthStatusResponse =
            serde_json::from_str(r#"{"status":"success"}"#).expect("should parse success");
        assert_eq!(success.status, AuthStatus::Success);
        assert!(success.status.is_success());

        let incorrect: AuthStatusResponse =
            serde_json::from_str(r#"{"status":"incorrect"}"#).expect("should parse incorrect");
        assert_eq!(incorrect.status, AuthStatus::Incorrect);
        assert!(incorrect.status.is_incorrect());

        let unknown: AuthStatusResponse =
            serde_json::from_str(r#"{"status":"something_else"}"#).expect("should parse unknown");
        assert_eq!(unknown.status, AuthStatus::Unknown);
    }

    #[test]
    fn test_auth_credential_redacted_debug() {
        let cred = AuthCredential::password("super_secret_master_password_123");
        let debug_str = format!("{:?}", cred);
        assert!(
            !debug_str.contains("super_secret_master_password_123"),
            "Debug output leaked sensitive credentials!"
        );
        assert_eq!(debug_str, "AuthCredential::Password([REDACTED])");
        assert_eq!(cred.header_value(), "super_secret_master_password_123");
    }

    #[test]
    fn test_login_payload_serde() {
        let payload = LoginPayload {
            password: Some("secret".to_string()),
            public_key: None,
        };
        let json_str = serde_json::to_string(&payload).unwrap();
        assert_eq!(json_str, r#"{"password":"secret"}"#);
    }

    #[test]
    fn test_login_response_serde() {
        let json_str = r#"{"status":"success","keyHash":"abc123hash"}"#;
        let resp: LoginResponse = serde_json::from_str(json_str).unwrap();
        assert_eq!(resp.status, "success");
        assert_eq!(resp.key_hash, Some("abc123hash".to_string()));
    }
}
