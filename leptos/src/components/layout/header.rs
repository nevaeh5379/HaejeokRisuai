use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use crate::state::app_state::AppState;
use leptos::prelude::*;

#[component]
pub fn Header() -> impl IntoView {
    let state = expect_context::<AppState>();

    // Query health status reactively
    let health_resource = LocalResource::new(move || {
        let api = state.api.get();
        async move { api.get_health().await }
    });

    view! {
        <header class="app-header">
            <div class="header-left">
                <Button
                    variant=ButtonVariant::Ghost
                    class="btn-icon"
                    on_click=move |_| state.ui.toggle_sidebar()
                >
                    <Icon name=IconName::Menu size=20 />
                </Button>
                <div class="header-title">"RisuAI Web"</div>
            </div>

            <div class="header-right">
                <Suspense fallback=move || view! {
                    <Badge variant=BadgeVariant::Neutral with_dot=true>
                        "Checking..."
                    </Badge>
                }>
                    {move || {
                        health_resource.get().map(|res| {
                            match (*res).clone() {
                                Ok(health) => {
                                    let is_ready = health.is_ready();
                                    let storage_status = health.storage.status.clone();
                                    if is_ready {
                                        view! {
                                            <Badge variant=BadgeVariant::Success with_dot=true>
                                                "Backend Ready"
                                            </Badge>
                                        }.into_any()
                                    } else {
                                        view! {
                                            <Badge variant=BadgeVariant::Warning with_dot=true>
                                                {format!("Storage: {}", storage_status)}
                                            </Badge>
                                        }.into_any()
                                    }
                                },
                                Err(_) => view! {
                                    <Badge variant=BadgeVariant::Danger with_dot=true>
                                        "Offline / Proxy"
                                    </Badge>
                                }.into_any(),
                            }
                        })
                    }}
                </Suspense>

                <Button
                    variant=ButtonVariant::Ghost
                    class="btn-icon"
                    on_click=move |_| state.logout()
                >
                    <Icon name=IconName::LogOut size=18 />
                </Button>
            </div>
        </header>
    }
}
