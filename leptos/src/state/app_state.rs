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
