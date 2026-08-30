use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::card::{Card, CardHeader};
use crate::components::common::icon::{Icon, IconName};
use crate::state::app_state::AppState;
use leptos::prelude::*;
use leptos_router::components::A;

#[component]
pub fn HomePage() -> impl IntoView {
    let state = expect_context::<AppState>();

    let health_resource = LocalResource::new(move || {
        let api = state.api.get();
        async move { api.get_health().await }
    });

    view! {
        <div style="max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem;">
            // Hero Welcome Section
            <div class="card" style="background: linear-gradient(135deg, var(--risu-theme-darkbg), var(--risu-theme-selected)); border-color: var(--risu-theme-borderc);">
                <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem;">
                    <div>
                        <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
                            <span style="font-size: 2rem;">"🌸"</span>
                            <h1 style="font-size: 1.75rem; font-weight: 800; color: var(--risu-primary);">
                                "RisuAI Leptos Frontend"
                            </h1>
                        </div>
                        <p style="color: var(--risu-theme-textcolor); font-size: 0.9375rem; max-width: 32rem; line-height: 1.5;">
                            "Next-generation cross-platform WebAssembly frontend built with Leptos & Rust. High-performance, Rust/Leptos WASM with minimal generated JS glue, and optimized for low-RAM mobile devices."
                        </p>
                    </div>
                    <div style="display: flex; gap: 0.75rem;">
                        <A href="/chat">
                            <Button variant=ButtonVariant::Primary>
                                <Icon name=IconName::Send size=16 />
                                <span>"Start Chatting"</span>
                            </Button>
                        </A>
                        <A href="/characters">
                            <Button variant=ButtonVariant::Secondary>
                                <Icon name=IconName::Users size=16 />
                                <span>"Browse Cards"</span>
                            </Button>
                        </A>
                    </div>
                </div>
            </div>

            // Quick Status Grid
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1rem;">
                // Backend Health Widget
                <Card>
                    <CardHeader title="Backend Status" />
                    <Suspense fallback=move || view! {
                        <div class="loading-container" style="padding: 1rem;">
                            <div class="spinner" style="width: 1.5rem; height: 1.5rem;"></div>
                            <span style="font-size: 0.8125rem;">"Connecting to Rust server..."</span>
                        </div>
                    }>
                        {move || {
                            health_resource.get().map(|res| {
                                match (*res).clone() {
                                    Ok(health) => {
                                        let storage_status = health.storage.status.clone();
                                        let vendor = health.storage.vendor.clone();
                                        let is_ready = storage_status == "ready";

                                        view! {
                                            <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                                    <span style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">"Health API"</span>
                                                    <Badge variant=BadgeVariant::Success with_dot=true>"OK (/api/health)"</Badge>
                                                </div>
                                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                                    <span style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">"Storage Status"</span>
                                                    <Badge variant=if is_ready { BadgeVariant::Success } else { BadgeVariant::Warning }>
                                                        {storage_status}
                                                    </Badge>
                                                </div>
                                                <div style="display: flex; justify-content: space-between; align-items: center;">
                                                    <span style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">"Storage Engine"</span>
                                                    <span style="font-weight: 600; font-size: 0.875rem;">{vendor}</span>
                                                </div>
                                            </div>
                                        }.into_any()
                                    },
                                    Err(err) => view! {
                                        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                                            <div style="display: flex; justify-content: space-between; align-items: center;">
                                                <span style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">"Connection"</span>
                                                <Badge variant=BadgeVariant::Danger with_dot=true>"Offline"</Badge>
                                            </div>
                                            <p style="font-size: 0.75rem; color: var(--risu-danger);">{err.to_string()}</p>
                                        </div>
                                    }.into_any(),
                                }
                            })
                        }}
                    </Suspense>
                </Card>

                // Memory Optimization Widget
                <Card>
                    <CardHeader title="Device & Memory Optimization" />
                    <div style="display: flex; flex-direction: column; gap: 0.75rem;">
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">"Target Profile"</span>
                            <Badge variant=BadgeVariant::Neutral>"~4GB RAM / Android"</Badge>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">"Data Loading"</span>
                            <span style="font-weight: 600; font-size: 0.875rem; color: var(--risu-success);">"Paged & Lazy Only"</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <span style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">"App Footprint"</span>
                            <span style="font-weight: 600; font-size: 0.875rem;">"Rust/Leptos WASM with minimal generated JS glue"</span>
                        </div>
                    </div>
                </Card>
            </div>
        </div>
    }
}
