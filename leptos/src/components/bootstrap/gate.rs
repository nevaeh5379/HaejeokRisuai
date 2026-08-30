use crate::api::client::{ApiClient, ApiError};
use crate::components::bootstrap::checking::CheckingScreen;
use crate::components::bootstrap::database_recovery::DatabaseRecoveryScreen;
use crate::components::bootstrap::login::LoginScreen;
use crate::components::bootstrap::offline::OfflineScreen;
use crate::components::bootstrap::set_password::SetPasswordScreen;
use crate::components::feedback::toast::ToastContainer;
use crate::models::auth::AuthStatus;
use crate::state::app_state::{
    decide_bootstrap_gate, AppState, CredentialVerification, GateStatus,
};
use leptos::prelude::*;

#[component]
pub fn BootstrapGate(children: ChildrenFn) -> impl IntoView {
    let state = expect_context::<AppState>();
    let stored_children = StoredValue::new(children);

    let evaluate_bootstrap = move || {
        state.gate_status.set(GateStatus::Checking);
        let api = state.api.get_untracked();
        let public_api = ApiClient::new(api.base_url());
        leptos::task::spawn_local(async move {
            // Step 1: Query unauthenticated health check
            let health = match public_api.get_health().await {
                Ok(h) => h,
                Err(err) => {
                    state.gate_status.set(GateStatus::Offline(err.to_string()));
                    return;
                }
            };

            // Step 2: Query unauthenticated auth status
            let auth_status = match public_api.check_auth_status().await {
                Ok(a) => a.status,
                Err(err) => {
                    state.gate_status.set(GateStatus::Offline(err.to_string()));
                    return;
                }
            };

            // Step 3: Branch via decide_bootstrap_gate
            if matches!(auth_status, AuthStatus::Unset) {
                let decision = decide_bootstrap_gate(
                    auth_status,
                    false,
                    CredentialVerification::NotChecked,
                    false,
                );
                state.gate_status.set(decision);
                return;
            }

            let has_credential = state.auth.get_credential().is_some();
            if !has_credential {
                let decision = decide_bootstrap_gate(
                    auth_status,
                    false,
                    CredentialVerification::NotChecked,
                    false,
                );
                state.gate_status.set(decision);
                return;
            }

            // Step 4: Verify credential using get_db_config
            match api.get_db_config().await {
                Ok(cfg) => {
                    let storage_ready = health.is_ready() && cfg.ready;
                    let decision = decide_bootstrap_gate(
                        auth_status,
                        true,
                        CredentialVerification::Valid,
                        storage_ready,
                    );
                    state.gate_status.set(decision);
                }
                Err(ApiError::Http { status: 400, .. }) | Err(ApiError::Unauthorized) => {
                    let decision = decide_bootstrap_gate(
                        auth_status,
                        true,
                        CredentialVerification::Invalid,
                        false,
                    );
                    state.gate_status.set(decision);
                }
                Err(ApiError::Network(msg)) => {
                    state
                        .gate_status
                        .set(GateStatus::Offline(format!("Network error: {}", msg)));
                }
                Err(ApiError::StorageUnavailable) => {
                    state.gate_status.set(GateStatus::NeedDatabaseRecovery);
                }
                Err(_err) => {
                    state.gate_status.set(GateStatus::Offline(
                        "An unexpected error occurred".to_string(),
                    ));
                }
            }
        });
    };

    // Run initial evaluation on mount
    evaluate_bootstrap();

    view! {
        <div class="bootstrap-root" style="width: 100vw; height: 100vh; overflow: hidden; position: relative;">
            {move || {
                match state.gate_status.get() {
                    GateStatus::Checking => view! { <CheckingScreen /> }.into_any(),
                    GateStatus::Offline(err) => view! {
                        <OfflineScreen
                            error_message=err
                            on_retry=move || evaluate_bootstrap()
                        />
                    }.into_any(),
                    GateStatus::NeedSetPassword => view! {
                        <SetPasswordScreen
                            on_success=move || evaluate_bootstrap()
                        />
                    }.into_any(),
                    GateStatus::NeedLogin => view! {
                        <LoginScreen
                            on_success=move || evaluate_bootstrap()
                        />
                    }.into_any(),
                    GateStatus::NeedDatabaseRecovery => view! {
                        <DatabaseRecoveryScreen
                            on_storage_ready=move || evaluate_bootstrap()
                        />
                    }.into_any(),
                    GateStatus::Ready => {
                        stored_children.with_value(|c| c().into_any())
                    }
                }
            }}

            // Global Toast Notifications accessible across bootstrap & application
            <ToastContainer />
        </div>
    }
}
