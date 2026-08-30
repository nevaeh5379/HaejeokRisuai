use crate::api::client::{ApiClient, Result};
use crate::models::auth::{
    AuthStatusResponse, LoginPayload, LoginResponse, SetPasswordPayload, SimpleSuccessResponse,
};

impl ApiClient {
    /// Calls GET `/api/test_auth` (with optional `?auth=...` query) to check password configuration and validity.
    ///
    /// Never calls `/api/password` during bootstrap, as `/api/password` is not in the recovery whitelist
    /// and returns 503 when storage is unconfigured.
    pub async fn check_auth_status(&self, token_or_password: Option<&str>) -> Result<AuthStatusResponse> {
        let path = match token_or_password {
            Some(t) if !t.is_empty() => format!("/api/test_auth?auth={}", urlencoding::encode(t)),
            _ => "/api/test_auth".to_string(),
        };
        self.get(&path).await
    }

    /// Checks auth status using the currently attached in-memory credential, if any.
    pub async fn check_current_auth_status(&self) -> Result<AuthStatusResponse> {
        let cred_val = self.credential().map(|c| c.header_value());
        self.check_auth_status(cred_val).await
    }

    /// Calls POST `/api/login`
    pub async fn login(&self, payload: &LoginPayload) -> Result<LoginResponse> {
        self.post("/api/login", payload).await
    }

    /// Calls POST `/api/set_password`
    pub async fn set_password(
        &self,
        payload: &SetPasswordPayload,
    ) -> Result<SimpleSuccessResponse> {
        self.post("/api/set_password", payload).await
    }
}
