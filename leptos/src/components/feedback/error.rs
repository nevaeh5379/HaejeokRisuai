use crate::api::client::ApiError;
use crate::components::common::button::{ActionCallback, Button, ButtonVariant};
use crate::components::common::icon::{Icon, IconName};
use leptos::prelude::*;

#[component]
pub fn ErrorBanner(message: String, #[prop(optional)] class: &'static str) -> impl IntoView {
    view! {
        <div class=format!("error-banner {}", class)>
            <Icon name=IconName::Close size=18 class="text-danger" />
            <div style="flex: 1; font-size: 0.875rem;">
                {message}
            </div>
        </div>
    }
}

#[component]
pub fn ApiErrorView(
    error: ApiError,
    #[prop(into, optional)] on_retry: Option<ActionCallback>,
) -> impl IntoView {
    let error_text = error.to_string();

    view! {
        <div class="card" style="border-color: rgba(255, 85, 85, 0.4); text-align: center; padding: 2rem 1.5rem;">
            <div style="font-size: 2.5rem; margin-bottom: 0.75rem;">"⚠️"</div>
            <h3 style="color: var(--risu-danger); font-size: 1.125rem; font-weight: 700; margin-bottom: 0.5rem;">
                "Operation Failed"
            </h3>
            <p style="color: var(--risu-theme-textcolor2); font-size: 0.875rem; margin-bottom: 1.25rem;">
                {error_text}
            </p>
            {if let Some(retry) = on_retry {
                view! {
                    <div>
                        <Button
                            variant=ButtonVariant::Secondary
                            on_click=move |_| retry.run()
                        >
                            <Icon name=IconName::Refresh size=16 />
                            <span>"Retry"</span>
                        </Button>
                    </div>
                }.into_any()
            } else {
                ().into_any()
            }}
        </div>
    }
}
