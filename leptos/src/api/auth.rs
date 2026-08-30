use crate::api::client::{ApiClient, Result};
use crate::models::auth::{
    AuthStatusResponse, LoginPayload, LoginResponse, SetPasswordPayload, SimpleSuccessResponse,
};

impl ApiClient {
    /// Calls GET `/api/test_auth` to check password configuration and validity.
    ///
    /// Never calls `/api/password` during bootstrap, as `/api/password` is not in the recovery whitelist
    /// and returns 503 when storage is unconfigured.
    pub async fn check_auth_status(&self) -> Result<AuthStatusResponse> {
        self.get("/api/test_auth").await
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
