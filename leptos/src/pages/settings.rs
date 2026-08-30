use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{Button, ButtonVariant};
use crate::components::common::card::{Card, CardHeader};
use crate::components::common::icon::{Icon, IconName};
use crate::models::settings::ThemePreset;
use crate::state::app_state::AppState;
use crate::state::ui_state::ToastType;
use leptos::prelude::*;

#[component]
pub fn SettingsPage() -> impl IntoView {
    let state = expect_context::<AppState>();
    let current_theme = state.theme.current_theme;
    let api_url_input = RwSignal::new(state.api.get().base_url().to_string());

    let on_select_theme = move |theme: ThemePreset| {
        state.theme.set_theme(theme);
        state.ui.toast(
            format!("Theme updated to {}", theme.display_name()),
            ToastType::Success,
        );
    };

    let on_save_api_url = move || {
        let url = api_url_input.get();
        state.set_api_base_url(&url);
        state
            .ui
            .toast("Backend API base URL updated", ToastType::Success);
    };

    let on_logout = move || {
        state.logout();
    };

    view! {
        <div style="max-width: 56rem; margin: 0 auto; display: flex; flex-direction: column; gap: 1.5rem;">
            <div>
                <h1 style="font-size: 1.5rem; font-weight: 800; display: flex; align-items: center; gap: 0.5rem;">
                    <Icon name=IconName::Settings size=24 class="text-primary" />
                    <span>"Application Settings"</span>
                </h1>
                <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">
                    "Configure appearance, network endpoints, and device memory profile"
                </p>
            </div>

            // Color Scheme & Theme Presets
            <Card>
                <CardHeader title="Appearance & Color Scheme" />
                <div style="display: flex; flex-direction: column; gap: 1rem;">
                    <div style="font-size: 0.875rem; color: var(--risu-theme-textcolor2);">
                        "Choose a color scheme compatible with classic RisuAI themes:"
                    </div>
                    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0.75rem;">
                        {ThemePreset::all().iter().map(|preset| {
                            let p = *preset;
                            let is_active = move || current_theme.get() == p;

                            view! {
                                <button
                                    class=move || if is_active() {
                                        "btn btn-secondary"
                                    } else {
                                        "btn btn-ghost"
                                    }
                                    style=move || if is_active() {
                                        "border-color: var(--risu-primary); background-color: var(--risu-theme-selected); display: flex; justify-content: space-between;"
                                    } else {
                                        "border: 1px solid var(--risu-theme-darkborderc); display: flex; justify-content: space-between;"
                                    }
                                    on:click=move |_| on_select_theme(p)
                                >
                                    <span>{p.display_name()}</span>
                                    {move || if is_active() {
                                        view! { <Icon name=IconName::Check size=16 class="text-primary" /> }.into_any()
                                    } else {
                                        ().into_any()
                                    }}
                                </button>
                            }
                        }).collect_view()}
                    </div>
                </div>
            </Card>

            // Backend API Configuration
            <Card>
                <CardHeader title="Backend Endpoint Configuration" />
                <div style="display: flex; flex-direction: column; gap: 1rem;">
                    <p style="font-size: 0.875rem; color: var(--risu-theme-textcolor2);">
                        "Set the Rust server endpoint (e.g. <code>http://127.0.0.1:6001</code>). Leave blank to use relative proxy <code>/api</code>."
                    </p>
                    <div style="display: flex; gap: 0.75rem;">
                        <input
                            type="text"
                            class="input-control"
                            placeholder="http://127.0.0.1:6001 (leave empty for same-origin proxy)"
                            prop:value=move || api_url_input.get()
                            on:input=move |ev| api_url_input.set(event_target_value(&ev))
                        />
                        <Button
                            variant=ButtonVariant::Primary
                            on_click=move |_| on_save_api_url()
                        >
                            "Save"
                        </Button>
                    </div>
                </div>
            </Card>

            // Session & Authentication
            <Card>
                <CardHeader title="Session & Authentication" />
                <div style="display: flex; flex-direction: column; gap: 1rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div style="font-weight: 600; font-size: 0.9375rem;">"In-Memory Session Credential"</div>
                            <div style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2);">
                                "Active credential is kept strictly in WebAssembly heap and never written to localStorage."
                            </div>
                        </div>
                        <Badge variant=BadgeVariant::Success>"Active"</Badge>
                    </div>

                    <div style="display: flex; justify-content: flex-end; padding-top: 0.5rem; border-top: 1px solid var(--risu-theme-darkborderc);">
                        <Button
                            variant=ButtonVariant::Danger
                            on_click=move |_| on_logout()
                        >
                            <Icon name=IconName::LogOut size=16 />
                            <span>"End Session / Log Out"</span>
                        </Button>
                    </div>
                </div>
            </Card>

            // Memory Optimization & Device Target
            <Card>
                <CardHeader title="Optimization & Device Specs" />
                <div style="display: flex; flex-direction: column; gap: 1rem;">
                    <div style="display: flex; justify-content: space-between; align-items: center; padding-bottom: 0.75rem; border-bottom: 1px solid var(--risu-theme-darkborderc);">
                        <div>
                            <div style="font-weight: 600; font-size: 0.9375rem;">"Target Device Specification"</div>
                            <div style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2);">
                                "Optimized for older Android-class devices around 4GB of RAM or less."
                            </div>
                        </div>
                        <Badge variant=BadgeVariant::Success>"Active"</Badge>
                    </div>

                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>
                            <div style="font-weight: 600; font-size: 0.9375rem;">"Lazy / Paged Message Loading"</div>
                            <div style="font-size: 0.8125rem; color: var(--risu-theme-textcolor2);">
                                "Prevents cloning full databases into WebAssembly memory. Loads messages in discrete windows."
                            </div>
                        </div>
                        <Badge variant=BadgeVariant::Success>"Enforced"</Badge>
                    </div>
                </div>
            </Card>
        </div>
    }
}
