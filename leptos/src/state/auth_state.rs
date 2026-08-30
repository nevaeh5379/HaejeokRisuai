use crate::models::auth::AuthCredential;
use leptos::prelude::*;

/// In-memory session credential state.
///
/// NOTE: Never persists raw credentials to `LocalStorage` or `SessionStorage`.
/// Holds the active session token/password in WASM memory for the duration of the page lifecycle.
#[derive(Clone, Copy)]
pub struct AuthState {
    pub credential: RwSignal<Option<AuthCredential>>,
    pub is_authenticated: RwSignal<bool>,
}

impl std::fmt::Debug for AuthState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthState")
            .field("is_authenticated", &self.is_authenticated.get_untracked())
            .field("has_credential", &self.credential.get_untracked().is_some())
            .finish()
    }
}

impl Default for AuthState {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthState {
    pub fn new() -> Self {
        Self {
            credential: RwSignal::new(None),
            is_authenticated: RwSignal::new(false),
        }
    }

    pub fn set_credential(&self, cred: Option<AuthCredential>) {
        let is_authed = cred.is_some();
        self.credential.set(cred);
        self.is_authenticated.set(is_authed);
    }

    pub fn set_password(&self, password: &str) {
        self.set_credential(Some(AuthCredential::password(password)));
    }

    pub fn logout(&self) {
        self.set_credential(None);
    }

    pub fn get_credential(&self) -> Option<AuthCredential> {
        self.credential.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auth_state_debug_does_not_reveal_secrets() {
        let state = AuthState::new();
        state.set_password("my_super_secret_password_999");

        let debug_str = format!("{:?}", state);
        assert!(
            !debug_str.contains("my_super_secret_password_999"),
            "AuthState Debug leaked password secret!"
        );
        assert!(debug_str.contains("is_authenticated: true"));
        assert!(debug_str.contains("has_credential: true"));

        state.logout();
        let debug_str_after = format!("{:?}", state);
        assert!(debug_str_after.contains("is_authenticated: false"));
        assert!(debug_str_after.contains("has_credential: false"));
    }
}
