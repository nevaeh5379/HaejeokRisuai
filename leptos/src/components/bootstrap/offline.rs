use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{ActionCallback, Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use crate::components::common::input::Input;
use crate::state::app_state::AppState;
use leptos::prelude::*;

#[component]
pub fn OfflineScreen(
    error_message: String,
    #[prop(into)] on_retry: ActionCallback,
) -> impl IntoView {
    let state = expect_context::<AppState>();
    let api_url = RwSignal::new(state.api.get().base_url().to_string());
    let custom_url_saved = RwSignal::new(false);

    let on_update_endpoint = {
        let on_retry = on_retry.clone();
        move || {
            let url = api_url.get().trim().to_string();
            state.set_api_base_url(&url);
            custom_url_saved.set(true);
            on_retry.run();
        }
    };

    view! {
        <div class="bootstrap-wrapper" style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background-color: var(--risu-theme-bgcolor);">
            <div class="card" style="max-width: 32rem; width: 100%; padding: 2rem;">
                <div style="display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1.25rem;">
                    <div style="color: var(--risu-danger); display: flex;">
                        <Icon name=IconName::AlertCircle size=28 />
                    </div>
                    <div>
                        <h1 style="font-size: 1.25rem; font-weight: 700;">
                            "Backend Unreachable"
                        </h1>
                        <Badge variant=BadgeVariant::Danger with_dot=true>"Server Offline"</Badge>
                    </div>
                </div>

                <p style="font-size: 0.875rem; color: var(--risu-theme-textcolor2); line-height: 1.5; margin-bottom: 1rem;">
                    "Could not connect to the RisuAI Rust backend server at <code>/api/health</code>. Ensure the server process is currently running."
                </p>

                <div style="background-color: var(--risu-theme-bgcolor); border: 1px solid var(--risu-theme-darkborderc); border-radius: var(--risu-radius-md); padding: 0.875rem; font-family: monospace; font-size: 0.8125rem; color: var(--risu-danger); margin-bottom: 1.5rem; word-break: break-all;">
                    {error_message}
                </div>

                <div style="display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--risu-theme-darkborderc);">
                    <div style="font-size: 0.8125rem; font-weight: 600; color: var(--risu-theme-textcolor2);">
                        "Custom Server Endpoint (Optional)"
                    </div>
                    <div style="display: flex; gap: 0.5rem;">
                        <div style="flex: 1;">
                            <Input
                                placeholder="http://127.0.0.1:6001 (leave empty for same-origin)"
                                value=api_url.into()
                                on_change=move |v| api_url.set(v)
                            />
                        </div>
                        <Button
                            variant=ButtonVariant::Secondary
                            on_click=move |_| on_update_endpoint()
                        >
                            "Apply"
                        </Button>
                    </div>
                </div>

                <div style="display: flex; gap: 0.75rem; justify-content: flex-end;">
                    <Button
                        variant=ButtonVariant::Primary
                        on_click=move |_| on_retry.run()
                    >
                        <Icon name=IconName::Refresh size=16 />
                        <span>"Retry Connection"</span>
                    </Button>
                </div>
            </div>
        </div>
    }
}
