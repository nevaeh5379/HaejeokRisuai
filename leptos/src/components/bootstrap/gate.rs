use crate::components::bootstrap::checking::CheckingScreen;
use crate::components::bootstrap::database_recovery::DatabaseRecoveryScreen;
use crate::components::bootstrap::login::LoginScreen;
use crate::components::bootstrap::offline::OfflineScreen;
use crate::components::bootstrap::set_password::SetPasswordScreen;
use crate::components::feedback::toast::ToastContainer;
use crate::models::auth::AuthStatus;
use crate::state::app_state::{AppState, GateStatus};
use leptos::prelude::*;

#[component]
pub fn BootstrapGate(children: ChildrenFn) -> impl IntoView {
    let state = expect_context::<AppState>();
    let stored_children = StoredValue::new(children);

    let evaluate_bootstrap = move || {
        state.gate_status.set(GateStatus::Checking);
        let api = state.api.get_untracked();
        leptos::task::spawn_local(async move {
            // Step 1: Query unauthenticated health check
            let health = match api.get_health().await {
                Ok(h) => h,
                Err(err) => {
                    state.gate_status.set(GateStatus::Offline(err.to_string()));
                    return;
                }
            };

            // Step 2: Query unauthenticated /api/test_auth with attached credentials
            let auth_status = match api.check_current_auth_status().await {
                Ok(a) => a.status,
                Err(err) => {
                    state.gate_status.set(GateStatus::Offline(err.to_string()));
                    return;
                }
            };

            // Step 3: Branch cleanly based on typed AuthStatus and Storage readiness
            match auth_status {
                AuthStatus::Unset => {
                    state.gate_status.set(GateStatus::NeedSetPassword);
                }
                AuthStatus::Incorrect => {
                    state.gate_status.set(GateStatus::NeedLogin);
                }
                AuthStatus::Success => {
                    // User is authenticated; check if storage is ready
                    if health.is_ready() {
                        state.gate_status.set(GateStatus::Ready);
                    } else {
                        state.gate_status.set(GateStatus::NeedDatabaseRecovery);
                    }
                }
                AuthStatus::Unknown => {
                    state.gate_status.set(GateStatus::NeedLogin);
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
