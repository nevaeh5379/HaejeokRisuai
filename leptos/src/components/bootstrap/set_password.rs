use crate::components::common::badge::{Badge, BadgeVariant};
use crate::components::common::button::{ActionCallback, Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use crate::components::common::input::ObscuredInput;
use crate::models::auth::SetPasswordPayload;
use crate::state::app_state::AppState;
use crate::state::ui_state::ToastType;
use leptos::prelude::*;

#[component]
pub fn SetPasswordScreen(
    #[prop(into)] on_success: ActionCallback,
) -> impl IntoView {
    let state = expect_context::<AppState>();

    let password = RwSignal::new(String::new());
    let confirm_password = RwSignal::new(String::new());
    let error_message = RwSignal::new(Option::<String>::None);
    let is_submitting = RwSignal::new(false);

    let handle_submit = {
        let on_success = on_success.clone();
        move || {
            let pw = password.get();
            let confirm_pw = confirm_password.get();

            if pw.trim().is_empty() {
                error_message.set(Some("Master password cannot be empty".to_string()));
                return;
            }

            if pw != confirm_pw {
                error_message.set(Some("Passwords do not match".to_string()));
                return;
            }

            error_message.set(None);
            is_submitting.set(true);

            let api = state.api.get_untracked();
            let on_success = on_success.clone();

            leptos::task::spawn_local(async move {
                let payload = SetPasswordPayload {
                    password: pw.clone(),
                };
                match api.set_password(&payload).await {
                    Ok(_) => {
                        is_submitting.set(false);
                        state.auth.set_password(&pw);
                        state.sync_api_credential();
                        state
                            .ui
                            .toast("Master password configured successfully", ToastType::Success);
                        on_success.run();
                    }
                    Err(err) => {
                        is_submitting.set(false);
                        error_message.set(Some(format!("Failed to set password: {}", err)));
                    }
                }
            });
        }
    };

    view! {
        <div class="bootstrap-wrapper" style="min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 1.5rem; background-color: var(--risu-theme-bgcolor);">
            <div class="card" style="max-width: 30rem; width: 100%; padding: 2rem;">
                <div style="text-align: center; margin-bottom: 1.5rem;">
                    <div style="font-size: 2.5rem; margin-bottom: 0.5rem;">"🌸"</div>
                    <h1 style="font-size: 1.5rem; font-weight: 800; color: var(--risu-primary); margin-bottom: 0.25rem;">
                        "Welcome to RisuAI"
                    </h1>
                    <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem;">
                        "Initial Setup: Configure Master Administrator Password"
                    </p>
                    <div style="margin-top: 0.75rem;">
                        <Badge variant=BadgeVariant::Warning with_dot=true>"Setup Mode (/api/set_password)"</Badge>
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
                        id="new-password"
                        label="Master Password"
                        placeholder="Enter a strong master password"
                        autocomplete="new-password"
                        value=password.into()
                        on_change=move |v| password.set(v)
                        on_enter=handle_submit.clone()
                    />

                    <ObscuredInput
                        id="confirm-password"
                        label="Confirm Master Password"
                        placeholder="Re-enter master password"
                        autocomplete="new-password"
                        value=confirm_password.into()
                        on_change=move |v| confirm_password.set(v)
                        on_enter=handle_submit.clone()
                    />

                    <p style="font-size: 0.75rem; color: var(--risu-theme-textcolor2); line-height: 1.4;">
                        "This password will protect your RisuAI database, settings, and chat history. Credentials are maintained in session memory and never leaked to localStorage."
                    </p>

                    <Button
                        variant=ButtonVariant::Primary
                        loading=is_submitting.get()
                        disabled=is_submitting.get()
                        class="w-full"
                    >
                        <Icon name=IconName::Shield size=16 />
                        <span>"Set Master Password & Continue"</span>
                    </Button>
                </form>
            </div>
        </div>
    }
}
