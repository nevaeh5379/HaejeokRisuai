use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::icon::{Icon, IconName};
use crate::state::app_state::AppState;
use leptos::prelude::*;

#[component]
pub fn Sidebar() -> impl IntoView {
    let state = expect_context::<AppState>();
    let sidebar_open = state.ui.sidebar_open;

    view! {
        // Mobile backdrop
        {move || if sidebar_open.get() {
            view! {
                <div
                    class="sidebar-backdrop"
                    on:click=move |_| state.ui.close_sidebar()
                ></div>
            }.into_any()
        } else {
            ().into_any()
        }}

        <aside class=move || if sidebar_open.get() { "app-sidebar open" } else { "app-sidebar" }>
            <div class="sidebar-brand">
                <div class="sidebar-brand-title">
                    <span style="font-size: 1.4rem;">"🌸"</span>
                    <span>"RisuAI"</span>
                </div>
                <Badge variant=BadgeVariant::Neutral class="ml-auto">
                    "v1.0 (Rust)"
                </Badge>
            </div>

            <nav class="sidebar-nav">
                <a
                    href="/"
                    class="sidebar-link"
                    on:click=move |_| state.ui.close_sidebar()
                >
                    <Icon name=IconName::Chat size=18 />
                    <span>"Dashboard"</span>
                </a>
                <a
                    href="/chat"
                    class="sidebar-link"
                    on:click=move |_| state.ui.close_sidebar()
                >
                    <Icon name=IconName::Send size=18 />
                    <span>"Active Chat"</span>
                </a>
                <a
                    href="/characters"
                    class="sidebar-link"
                    on:click=move |_| state.ui.close_sidebar()
                >
                    <Icon name=IconName::Users size=18 />
                    <span>"Characters"</span>
                </a>
                <a
                    href="/library"
                    class="sidebar-link"
                    on:click=move |_| state.ui.close_sidebar()
                >
                    <Icon name=IconName::BookOpen size=18 />
                    <span>"Library"</span>
                </a>
                <a
                    href="/health"
                    class="sidebar-link"
                    on:click=move |_| state.ui.close_sidebar()
                >
                    <Icon name=IconName::HeartPulse size=18 />
                    <span>"Backend Health"</span>
                </a>
                <a
                    href="/settings"
                    class="sidebar-link"
                    on:click=move |_| state.ui.close_sidebar()
                >
                    <Icon name=IconName::Settings size=18 />
                    <span>"Settings"</span>
                </a>
            </nav>

            <div class="sidebar-footer">
                <div style="font-size: 0.75rem; color: var(--risu-theme-textcolor2); display: flex; justify-content: space-between; align-items: center;">
                    <span>"Memory Mode"</span>
                    <span style="color: var(--risu-success); font-weight: 600;">"Optimized (4GB)"</span>
                </div>
            </div>
        </aside>
    }
}
