use crate::components::common::button::{ActionCallback, Button, ButtonVariant};
use leptos::prelude::*;

#[component]
pub fn EmptyState(
    #[prop(default = "📂")] icon: &'static str,
    #[prop(default = "No Items Found")] title: &'static str,
    #[prop(default = "There is nothing to display here yet.")] description: &'static str,
    #[prop(optional)] action_text: Option<&'static str>,
    #[prop(into, optional)] on_action: Option<ActionCallback>,
) -> impl IntoView {
    view! {
        <div class="empty-state">
            <div class="empty-state-icon">{icon}</div>
            <div class="empty-state-title">{title}</div>
            <p style="font-size: 0.875rem; max-width: 20rem; margin: 0 auto;">{description}</p>
            {if let (Some(text), Some(cb)) = (action_text, on_action) {
                view! {
                    <div style="margin-top: 0.5rem;">
                        <Button
                            variant=ButtonVariant::Primary
                            on_click=move |_| cb.run()
                        >
                            {text}
                        </Button>
                    </div>
                }.into_any()
            } else {
                ().into_any()
            }}
        </div>
    }
}
