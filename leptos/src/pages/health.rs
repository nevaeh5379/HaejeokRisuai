use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::card::{Card, CardHeader};
use crate::components::common::icon::{Icon, IconName};
use crate::components::feedback::error::ApiErrorView;
use crate::components::feedback::loading::LoadingSpinner;
use crate::state::app_state::AppState;
use crate::state::ui_state::ToastType;
use leptos::prelude::*;

const BACKEND_ENDPOINTS: &[(&str, &str)] = &[
    ("GET /api/health", "Storage readiness and vendor inspection"),
    (
        "GET /api/test_auth, POST /api/login",
        "Authentication and session validation",
    ),
    (
        "GET/POST /api/db-config",
        "Database storage configuration and recovery",
    ),
    (
        "GET /api/database-v2/characters/search",
        "Character search query (LIMIT 50)",
    ),
    (
        "GET /api/database-v2/chats/{id}/messages",
        "Lazy message window streaming",
    ),
    ("GET /api/read/{path}", "Dynamic image and asset streaming"),
];

#[component]
pub fn HealthPage() -> impl IntoView {
    let state = expect_context::<AppState>();
    let refresh_count = RwSignal::new(0);

    let health_resource = LocalResource::new(move || {
        let _ = refresh_count.get();
        let api = state.api.get();
        async move { api.get_health().await }
    });

    let on_refresh = move || {
        refresh_count.update(|c| *c += 1);
        state
            .ui
            .toast("Refreshing backend health status...", ToastType::Info);
    };

    view! {
        <div style="max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem;">
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
                <div>
                    <h1 style="font-size: 1.5rem; font-weight: 800; display: flex; align-items: center; gap: 0.5rem;">
                        <Icon name=IconName::HeartPulse size=24 class="text-primary" />
                        <span>"Rust Backend Health Diagnostics"</span>
                    </h1>
                    <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">
                        "Real-time integration testing against /api/health"
                    </p>
                </div>
                <Button
                    variant=ButtonVariant::Secondary
                    on_click=move |_| on_refresh()
                >
                    <Icon name=IconName::Refresh size=16 />
                    <span>"Refresh Health"</span>
                </Button>
            </div>

            <Suspense fallback=move || view! {
                <Card>
                    <LoadingSpinner text="Querying /api/health endpoint..." />
                </Card>
            }>
                {move || {
                    health_resource.get().map(|res| {
                        match (*res).clone() {
                            Ok(health) => {
                                let raw_json = serde_json::to_string_pretty(&health).unwrap_or_default();
                                let is_ready = health.storage.status == "ready";
                                let status_color = if is_ready { "var(--risu-success)" } else { "var(--risu-warning)" };

                                view! {
                                    <div style="display: flex; flex-direction: column; gap: 1.25rem;">
                                        // Main Status Card
                                        <Card>
                                            <CardHeader title="API Status Overview" />
                                            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.25rem;">
                                                <div style="background-color: var(--risu-theme-bgcolor); padding: 1rem; border-radius: var(--risu-radius-md); border: 1px solid var(--risu-theme-darkborderc);">
                                                    <div style="font-size: 0.75rem; color: var(--risu-theme-textcolor2); margin-bottom: 0.25rem;">"HTTP Status"</div>
                                                    <div style="font-size: 1.25rem; font-weight: 700; color: var(--risu-success);">"200 OK"</div>
                                                </div>
                                                <div style="background-color: var(--risu-theme-bgcolor); padding: 1rem; border-radius: var(--risu-radius-md); border: 1px solid var(--risu-theme-darkborderc);">
                                                    <div style="font-size: 0.75rem; color: var(--risu-theme-textcolor2); margin-bottom: 0.25rem;">"Application Status"</div>
                                                    <div style="font-size: 1.25rem; font-weight: 700;">{health.status.clone()}</div>
                                                </div>
                                                <div style="background-color: var(--risu-theme-bgcolor); padding: 1rem; border-radius: var(--risu-radius-md); border: 1px solid var(--risu-theme-darkborderc);">
                                                    <div style="font-size: 0.75rem; color: var(--risu-theme-textcolor2); margin-bottom: 0.25rem;">"Storage Status"</div>
                                                    <div style=format!("font-size: 1.25rem; font-weight: 700; color: {};", status_color)>
                                                        {health.storage.status.clone()}
                                                    </div>
                                                </div>
                                                <div style="background-color: var(--risu-theme-bgcolor); padding: 1rem; border-radius: var(--risu-radius-md); border: 1px solid var(--risu-theme-darkborderc);">
                                                    <div style="font-size: 0.75rem; color: var(--risu-theme-textcolor2); margin-bottom: 0.25rem;">"Database Vendor"</div>
                                                    <div style="font-size: 1.25rem; font-weight: 700;">{health.storage.vendor.clone()}</div>
                                                </div>
                                            </div>

                                            // Raw Response Inspector
                                            <div>
                                                <div style="font-size: 0.8125rem; font-weight: 600; color: var(--risu-theme-textcolor2); margin-bottom: 0.5rem;">
                                                    "Raw JSON Payload"
                                                </div>
                                                <pre style="background-color: var(--risu-theme-bgcolor); padding: 1rem; border-radius: var(--risu-radius-md); border: 1px solid var(--risu-theme-darkborderc); font-family: monospace; font-size: 0.875rem; overflow-x: auto;">
                                                    {raw_json}
                                                </pre>
                                            </div>
                                        </Card>

                                        // Backend Endpoint Manifest Reference
                                        <Card>
                                            <CardHeader title="Backend API Contract Map (server/rust)" />
                                            <div style="font-size: 0.875rem; color: var(--risu-theme-textcolor2); line-height: 1.6;">
                                                <p style="margin-bottom: 0.75rem;">
                                                    "The Leptos client directly targets the existing Axum endpoints defined in risuai-server::routes:"
                                                </p>
                                                <ul style="list-style: disc; margin-left: 1.5rem; display: flex; flex-direction: column; gap: 0.375rem;">
                                                    {BACKEND_ENDPOINTS.iter().map(|(ep, desc)| {
                                                        let desc_str = format!(" - {}", desc);
                                                        view! {
                                                            <li>
                                                                <code>{*ep}</code>
                                                                <span>{desc_str}</span>
                                                            </li>
                                                        }
                                                    }).collect_view()}
                                                </ul>
                                            </div>
                                        </Card>
                                    </div>
                                }.into_any()
                            },
                            Err(err) => {
                                let err_clone = err.clone();
                                view! {
                                    <ApiErrorView
                                        error=err_clone
                                        on_retry=move || on_refresh()
                                    />
                                }.into_any()
                            }
                        }
                    })
                }}
            </Suspense>
        </div>
    }
}
