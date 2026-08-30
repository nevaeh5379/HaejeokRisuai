use crate::api::client::ApiClient;
use crate::state::auth_state::AuthState;
use crate::state::chat_state::ChatState;
use crate::state::theme_state::ThemeState;
use crate::state::ui_state::UiState;
use leptos::prelude::*;

/// Overall bootstrap and recovery gate status
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum GateStatus {
    /// Checking backend health and authentication status
    #[default]
    Checking,
    /// Backend server is unreachable or offline
    Offline(String),
    /// No password is set on the server yet; setup required
    NeedSetPassword,
    /// Password is set; user must authenticate
    NeedLogin,
    /// Authenticated, but PostgreSQL storage is unconfigured or not ready
    NeedDatabaseRecovery,
    /// Authenticated and storage is ready; main application layout is unlocked
    Ready,
}

#[derive(Debug, Clone, Copy)]
pub struct AppState {
    pub api: RwSignal<ApiClient>,
    pub theme: ThemeState,
    pub auth: AuthState,
    pub ui: UiState,
    pub chat: ChatState,
    pub gate_status: RwSignal<GateStatus>,
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

impl AppState {
    pub fn new() -> Self {
        let auth = AuthState::new();
        let theme = ThemeState::new();
        let ui = UiState::new();
        let chat = ChatState::new();
        let gate_status = RwSignal::new(GateStatus::Checking);

        let api_client = ApiClient::new("").with_credential(auth.get_credential());
        let api = RwSignal::new(api_client);

        Self {
            api,
            theme,
            auth,
            ui,
            chat,
            gate_status,
        }
    }

    /// Syncs the current in-memory AuthCredential to the active ApiClient
    pub fn sync_api_credential(&self) {
        let cred = self.auth.get_credential();
        self.api.update(|client| {
            client.set_credential(cred);
        });
    }

    /// Updates the backend base URL and preserves credential
    pub fn set_api_base_url(&self, base_url: &str) {
        let cred = self.auth.get_credential();
        self.api.update(|client| {
            *client = ApiClient::new(base_url).with_credential(cred);
        });
    }

    /// Clears active credentials and returns to Login gate
    pub fn logout(&self) {
        self.auth.logout();
        self.sync_api_credential();
        self.gate_status.set(GateStatus::NeedLogin);
    }
}

/// Verification state of in-memory credentials against the backend
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CredentialVerification {
    #[default]
    NotChecked,
    Valid,
    Invalid,
}

/// Pure decision helper for bootstrap gate state transitions.
///
/// Semantics:
/// - `AuthStatus::Unset` => `GateStatus::NeedSetPassword` regardless of other inputs.
/// - Configured state is `AuthStatus::Incorrect`, `AuthStatus::Unknown`, or `AuthStatus::Success` (treated safely as configured).
/// - Configured + no in-memory credential => `GateStatus::NeedLogin`.
/// - Configured + credential + verification `Invalid` => `GateStatus::NeedLogin`.
/// - Configured + credential + verification `Valid` + `storage_ready: true` => `GateStatus::Ready`.
/// - Configured + credential + verification `Valid` + `storage_ready: false` => `GateStatus::NeedDatabaseRecovery`.
/// - Configured + credential + verification `NotChecked` => `GateStatus::Checking`.
pub fn decide_bootstrap_gate(
    auth_status: crate::models::auth::AuthStatus,
    has_credential: bool,
    verification: CredentialVerification,
    storage_ready: bool,
) -> GateStatus {
    use crate::models::auth::AuthStatus;

    if matches!(auth_status, AuthStatus::Unset) {
        return GateStatus::NeedSetPassword;
    }

    // Configured states: AuthStatus::Incorrect, AuthStatus::Unknown, AuthStatus::Success
    if !has_credential {
        return GateStatus::NeedLogin;
    }

    match verification {
        CredentialVerification::NotChecked => GateStatus::Checking,
        CredentialVerification::Invalid => GateStatus::NeedLogin,
        CredentialVerification::Valid => {
            if storage_ready {
                GateStatus::Ready
            } else {
                GateStatus::NeedDatabaseRecovery
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::auth::AuthStatus;

    #[test]
    fn test_unset_auth_status_always_needs_set_password() {
        for has_cred in [false, true] {
            for verification in [
                CredentialVerification::NotChecked,
                CredentialVerification::Valid,
                CredentialVerification::Invalid,
            ] {
                for storage_ready in [false, true] {
                    let decision = decide_bootstrap_gate(
                        AuthStatus::Unset,
                        has_cred,
                        verification,
                        storage_ready,
                    );
                    assert_eq!(decision, GateStatus::NeedSetPassword);
                }
            }
        }
    }

    #[test]
    fn test_configured_no_in_memory_credential_needs_login() {
        for auth_status in [
            AuthStatus::Incorrect,
            AuthStatus::Unknown,
            AuthStatus::Success,
        ] {
            for verification in [
                CredentialVerification::NotChecked,
                CredentialVerification::Valid,
                CredentialVerification::Invalid,
            ] {
                for storage_ready in [false, true] {
                    let decision =
                        decide_bootstrap_gate(auth_status, false, verification, storage_ready);
                    assert_eq!(decision, GateStatus::NeedLogin);
                }
            }
        }
    }

    #[test]
    fn test_configured_with_credential_invalid_verification_needs_login() {
        for auth_status in [
            AuthStatus::Incorrect,
            AuthStatus::Unknown,
            AuthStatus::Success,
        ] {
            for storage_ready in [false, true] {
                let decision = decide_bootstrap_gate(
                    auth_status,
                    true,
                    CredentialVerification::Invalid,
                    storage_ready,
                );
                assert_eq!(decision, GateStatus::NeedLogin);
            }
        }
    }

    #[test]
    fn test_configured_with_credential_valid_and_storage_ready_is_ready() {
        for auth_status in [
            AuthStatus::Incorrect,
            AuthStatus::Unknown,
            AuthStatus::Success,
        ] {
            let decision =
                decide_bootstrap_gate(auth_status, true, CredentialVerification::Valid, true);
            assert_eq!(decision, GateStatus::Ready);
        }
    }

    #[test]
    fn test_configured_with_credential_valid_and_storage_not_ready_needs_database_recovery() {
        for auth_status in [
            AuthStatus::Incorrect,
            AuthStatus::Unknown,
            AuthStatus::Success,
        ] {
            let decision =
                decide_bootstrap_gate(auth_status, true, CredentialVerification::Valid, false);
            assert_eq!(decision, GateStatus::NeedDatabaseRecovery);
        }
    }

    #[test]
    fn test_configured_with_credential_not_checked_is_checking() {
        for auth_status in [
            AuthStatus::Incorrect,
            AuthStatus::Unknown,
            AuthStatus::Success,
        ] {
            for storage_ready in [false, true] {
                let decision = decide_bootstrap_gate(
                    auth_status,
                    true,
                    CredentialVerification::NotChecked,
                    storage_ready,
                );
                assert_eq!(decision, GateStatus::Checking);
            }
        }
    }
}
