use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{ActionCallback, Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use crate::components::common::input::ObscuredInput;
use crate::models::auth::LoginPayload;
use crate::state::app_state::AppState;
use crate::state::ui_state::ToastType;
use leptos::prelude::*;

#[component]
pub fn LoginScreen(
    #[prop(into)] on_success: ActionCallback,
) -> impl IntoView {
    let state = expect_context::<AppState>();

    let password = RwSignal::new(String::new());
    let error_message = RwSignal::new(Option::<String>::None);
    let is_submitting = RwSignal::new(false);

    let handle_submit = {
        let on_success = on_success.clone();
        move || {
            let pw = password.get();

            if pw.trim().is_empty() {
                error_message.set(Some("Please enter your master password".to_string()));
                return;
            }

            error_message.set(None);
            is_submitting.set(true);

            let api = state.api.get_untracked();
            let on_success = on_success.clone();

            leptos::task::spawn_local(async move {
                let payload = LoginPayload {
                    password: Some(pw.clone()),
                    public_key: None,
                };
                match api.login(&payload).await {
                    Ok(_) => {
                        is_submitting.set(false);
                        state.auth.set_password(&pw);
                        state.sync_api_credential();
                        state
                            .ui
                            .toast("Authenticated successfully", ToastType::Success);
                        on_success.run();
                    }
                    Err(err) => {
                        is_submitting.set(false);
                        let msg = match &err {
                            crate::api::client::ApiError::Http { status: 400, message } => {
                                if message.contains("Password incorrect") {
                                    "Incorrect master password. Please try again.".to_string()
                                } else {
                                    message.clone()
                                }
                            }
                            _ => format!("Authentication failed: {}", err),
                        };
                        error_message.set(Some(msg));
                    }
                }
            });
        }
    };

    view! {
        <div class="bootstrap-wrapper" style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background-color: var(--risu-theme-bgcolor);">
            <div class="card" style="max-width: 28rem; width: 100%; padding: 2rem;">
                <div style="text-align: center; margin-bottom: 1.5rem;">
                    <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">"🌸"</div>
                    <h1 style="font-size: 1.5rem; font-weight: 800; color: var(--risu-primary); margin-bottom: 0.25rem;">
                        "Unlock RisuAI"
                    </h1>
                    <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">
                        "Master Password Authentication"
                    </p>
                    <div style="margin-top: 0.75rem;">
                        <Badge variant=BadgeVariant::Neutral with_dot=true>"Session Memory Credential"</Badge>
                    </div>
                </div>

                {move || error_message.get().map(|msg| view! {
                    <div
                        role="alert"
                        style="background-color: rgba(255, 85, 85, 0.15); border: 1px solid var(--risu-danger); color: var(--risu-danger); padding: 0.75rem; border-radius: var(--risu-radius-md); font-size: 0.875rem; margin-bottom: 1.25rem; display: flex; align-items: center; gap: 0.5rem;"
                    >
                        <Icon name=IconName::AlertCircle size=18 />
                        <span>{msg}</span>
                    </div>
                })}

                <form
                    on:submit={
                        let handle_submit = handle_submit.clone();
                        move |ev| {
                            ev.prevent_default();
                            handle_submit();
                        }
                    }
                    style="display: flex; flex-direction: column; gap: 1.25rem;"
                >
                    <ObscuredInput
                        id="login-password"
                        label="Master Password"
                        placeholder="Enter your password"
                        autocomplete="current-password"
                        value=password.into()
                        on_change=move |v| password.set(v)
                        on_enter=handle_submit.clone()
                    />

                    <Button
                        variant=ButtonVariant::Primary
                        loading=is_submitting.get()
                        disabled=is_submitting.get()
                        class="w-full"
                    >
                        <Icon name=IconName::Key size=16 />
                        <span>"Authenticate & Open"</span>
                    </Button>
                </form>
            </div>
        </div>
    }
}
